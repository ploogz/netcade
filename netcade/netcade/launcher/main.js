'use strict';
/**
 * Netcade launcher: main process.
 * Owns settings, the game library, the lobby connection, relay tunnels and emulator processes.
 * The renderer (UI) talks to it only through the API in preload.js.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const { Library } = require('./lib/library');
const { matchGame, publicGame, describe } = require('./lib/romInfo');
const emulators = require('./lib/emulators');
const dolphin = require('./lib/dolphin');
const retroarch = require('./lib/retroarch');
const tunnel = require('./lib/tunnel');
const { LobbyClient, httpBase } = require('./lib/lobbyClient');

const APP_VERSION = app.getVersion();

/** Build-time config: CI writes the group's server address here so players never type it. */
const BUILD_CONFIG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'netcade.config.json'), 'utf8')); } catch { return {}; }
})();

/** Emulators shipped inside this install (null in a dev checkout without vendor/). */
const BUNDLE = emulators.bundled({ resourcesPath: process.resourcesPath, appPath: __dirname, isPackaged: app.isPackaged });
const PROTOCOL = 'netcade';

// ------------------------------------------------------------------ paths
const USER = app.getPath('userData');
const P = {
  settings: path.join(USER, 'settings.json'),
  libraryCache: path.join(USER, 'library-cache.json'),
  logs: path.join(USER, 'logs'),
  dolphinUser: path.join(USER, 'dolphin-user'),
  retroarchData: path.join(USER, 'retroarch'),
  cores: path.join(USER, 'cores'),
};

// --------------------------------------------------------------- settings
function defaultName() {
  try {
    const n = os.userInfo().username || 'Player';
    return n.charAt(0).toUpperCase() + n.slice(1, 20);
  } catch {
    return 'Player';
  }
}

const DEFAULT_SETTINGS = {
  version: 1,
  name: defaultName(),
  serverUrl: BUILD_CONFIG.defaultServerUrl || '',
  emulatorSource: 'bundled',   // 'bundled' = the copies inside Netcade, 'custom' = the player's own installs
  embeddedServer: { enabled: false, port: 8080 },
  romFolders: [],
  dolphinPath: '',
  retroarchPath: '',
  n64CorePath: '',
  graphics: {
    preset: 'balanced', fullscreen: false, vsync: true, widescreen: false, showFps: false,
    // macOS has no native Vulkan, so the OpenGL renderer is the safe default there
    n64Renderer: process.platform === 'darwin' ? 'gliden64' : 'parallel', n64Scale: 2, gcBackend: 'auto', gcScale: 2,
  },
  controls: {
    n64: { mode: 'keyboard', keyboard: {}, gamepad: {} },
    gc: { mode: 'keyboard', keyboard: {}, gamepad: {}, device: { kind: process.platform === 'win32' ? 'xinput' : 'sdl', index: 0, name: '' } },
  },
  netplay: { forceRelay: false, retroarchPort: 55435, dolphinPort: 2626, notify: true, dolphinDirect: false },
  favorites: [],
  recent: [],
  onboarded: false,
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

let settings = loadSettings();

function loadSettings() {
  try {
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(fs.readFileSync(P.settings, 'utf8')));
  } catch {
    return deepMerge(DEFAULT_SETTINGS, {});
  }
}

function saveSettings() {
  fs.mkdirSync(USER, { recursive: true });
  const tmp = P.settings + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, P.settings);
}

// ------------------------------------------------------------------ state
const library = new Library(P.libraryCache);
const lobby = new LobbyClient();
let win = null;
let embedded = null;           // in-process lobby server, when enabled
let lobbyView = null;          // last lobby view from the server
let lastHasKey = '';           // avoid re-sending identical has-status
let myHas = null;
let session = null;            // the running emulator session
let pendingJoin = null;        // lobby code from a netcade:// link, joined once online
let emuInfo = { dolphin: {}, retroarch: {}, n64Core: '' };
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try {
    fs.mkdirSync(P.logs, { recursive: true });
    fs.appendFileSync(path.join(P.logs, 'netcade.log'), line);
  } catch { /* ignore */ }
};

function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(text, kind = 'info') {
  emit('toast', { text, kind });
}

function notify(title, body) {
  if (!settings.netplay?.notify) return;
  if (win && win.isFocused()) return;
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show();
  } catch { /* ignore */ }
}

function serverUrl() {
  if (settings.embeddedServer?.enabled) return `http://127.0.0.1:${settings.embeddedServer.port || 8080}`;
  return (settings.serverUrl || '').trim();
}

// ------------------------------------------------------------- emulators
function useBundle(kind) {
  return settings.emulatorSource !== 'custom' && BUNDLE && BUNDLE[kind];
}
const dolphinExe = () => (useBundle('dolphin') ? BUNDLE.dolphin.path : settings.dolphinPath);
const retroarchExe = () => (useBundle('retroarch') ? BUNDLE.retroarch.path : settings.retroarchPath);
const raBundle = () => (useBundle('retroarch') ? { autoconfig: BUNDLE.autoconfig } : null);

async function refreshEmulators(autoDetect = false) {
  if (settings.emulatorSource !== 'custom' && BUNDLE) {
    const core = BUNDLE.n64Core && useBundle('retroarch') ? BUNDLE.n64Core.path : emulators.findN64Core(settings.retroarchPath, P.cores);
    emuInfo = {
      bundled: true,
      bundleBuiltAt: BUNDLE.builtAt,
      dolphin: { path: dolphinExe(), ok: emulators.exists(dolphinExe()), version: useBundle('dolphin') ? BUNDLE.dolphin.version : await emulators.version('dolphin', settings.dolphinPath), bundled: !!useBundle('dolphin') },
      retroarch: { path: retroarchExe(), ok: emulators.exists(retroarchExe()), version: useBundle('retroarch') ? BUNDLE.retroarch.version : await emulators.version('retroarch', settings.retroarchPath), bundled: !!useBundle('retroarch') },
      n64Core: core,
      n64CoreVersion: useBundle('retroarch') && BUNDLE.n64Core ? BUNDLE.n64Core.version : '',
    };
    emit('emulators', emuInfo);
    sendHello();
    return emuInfo;
  }
  return refreshCustomEmulators(autoDetect);
}

async function refreshCustomEmulators(autoDetect = false) {
  if (autoDetect || !settings.dolphinPath) {
    const d = emulators.detect('dolphin');
    if (d && !settings.dolphinPath) settings.dolphinPath = d;
  }
  if (autoDetect || !settings.retroarchPath) {
    const r = emulators.detect('retroarch');
    if (r && !settings.retroarchPath) settings.retroarchPath = r;
  }
  saveSettings();
  const [dv, rv] = await Promise.all([
    emulators.version('dolphin', settings.dolphinPath),
    emulators.version('retroarch', settings.retroarchPath),
  ]);
  const core = settings.n64CorePath && fs.existsSync(settings.n64CorePath)
    ? settings.n64CorePath
    : emulators.findN64Core(settings.retroarchPath, P.cores);
  emuInfo = {
    bundled: false,
    bundleAvailable: !!BUNDLE,
    dolphin: { path: settings.dolphinPath, ok: emulators.exists(settings.dolphinPath), version: dv },
    retroarch: { path: settings.retroarchPath, ok: emulators.exists(settings.retroarchPath), version: rv },
    n64Core: core,
  };
  emit('emulators', emuInfo);
  sendHello();
  return emuInfo;
}

// ---------------------------------------------------------------- library
async function scanLibrary() {
  const res = await library.scan(settings.romFolders, (done, total, file) => emit('library-progress', { done, total, file }));
  emit('library', { games: library.games, errors: res.errors });
  checkHas(true);
  return res;
}

// ----------------------------------------------------------------- lobby
function sendHello() {
  if (!serverUrl()) return;
  lobby.connect(serverUrl(), {
    name: settings.name,
    versions: {
      app: APP_VERSION,
      dolphin: emuInfo.dolphin?.version || '',
      retroarch: [emuInfo.retroarch?.version, emuInfo.n64CoreVersion].filter(Boolean).join(' · '),
    },
  });
}

function checkHas(force = false) {
  if (!lobbyView || !lobby.me) return;
  if (lobbyView.hostId === lobby.me.id) {
    myHas = { status: 'match' };
    return;
  }
  const m = matchGame(lobbyView.game, library.games, lobbyView.system);
  myHas = { status: m.status, detail: m.detail, localPath: m.local?.path };
  const key = `${lobbyView.code}|${lobbyView.game?.key}|${m.status}|${m.detail}`;
  if (force || key !== lastHasKey) {
    lastHasKey = key;
    lobby.send({ type: 'has', status: m.status, detail: m.detail });
  }
}

lobby.on('status', (s) => {
  emit('server-status', { ...s, me: lobby.me });
  if (s.state === 'online' && pendingJoin) {
    lobby.send({ type: 'join', code: pendingJoin });
    pendingJoin = null;
  }
  if (s.state !== 'online') {
    if (lobbyView) {
      lobbyView = null;
      emit('lobby', null);
    }
  }
});

lobby.on('message', (msg) => {
  switch (msg.type) {
    case 'welcome':
      emit('server-status', { state: 'online', me: lobby.me });
      lobby.send({ type: 'list' });
      break;
    case 'lobby': {
      const prev = lobbyView;
      lobbyView = msg.lobby;
      checkHas();
      emit('lobby', { ...lobbyView, myHas, myId: lobby.me?.id });
      if (prev && lobby.me && lobbyView.hostId === lobby.me.id) {
        const joined = lobbyView.members.filter((m) => !prev.members.some((p) => p.id === m.id));
        for (const j of joined) notify('Player joined', `${j.name} joined your ${lobbyView.game?.title || ''} lobby`);
      }
      break;
    }
    case 'joined':
      lastHasKey = '';
      emit('lobby-msg', msg);
      break;
    case 'left':
    case 'kicked':
      lobbyView = null;
      emit('lobby', null);
      emit('lobby-msg', msg);
      if (msg.type === 'kicked') toast('The host removed you from the lobby.', 'warn');
      break;
    case 'chat':
      emit('lobby-msg', msg);
      if (!msg.system && msg.from !== lobby.me?.id) notify(msg.name, msg.text);
      break;
    case 'launch':
      onLaunch(msg).catch((err) => {
        log('launch failed', err.stack || err.message);
        setSession({ phase: 'error', text: err.message });
        if (msg.role === 'host') lobby.send({ type: 'endGame' });
      });
      break;
    case 'connectInfo':
      onConnectInfo(msg).catch((err) => {
        log('connect failed', err.stack || err.message);
        setSession({ phase: 'error', text: err.message });
      });
      break;
    case 'dolphinSession':
      onDolphinSession(msg).catch((err) => {
        log('dolphin guest failed', err.stack || err.message);
        setSession({ phase: 'error', text: err.message });
      });
      break;
    case 'tunnelOpen':
      if (session && session.role === 'host' && session.system === 'n64' && lobby.me) {
        tunnel.openHostTunnel({
          serverUrl: serverUrl(), pid: lobby.me.id, token: lobby.me.token, cid: msg.cid,
          localPort: session.port, log,
        });
      }
      break;
    case 'hostMode':
      if (session) setSession({ netMode: msg.mode });
      break;
    case 'gameEnded':
      if (session && session.role === 'guest' && session.phase === 'waiting') {
        setSession(null);
      }
      if (msg.message) toast(msg.message);
      emit('lobby-msg', msg);
      break;
    default:
      emit('lobby-msg', msg);
  }
});

// --------------------------------------------------------------- sessions
function setSession(patch) {
  if (patch === null) {
    if (session?.tunnel) session.tunnel.close();
    session = null;
  } else {
    session = { ...(session || {}), ...patch };
  }
  emit('session', session ? { ...session, child: undefined, tunnel: undefined } : null);
}

function requireEmulator(system) {
  if (system === 'gc') {
    if (!emulators.exists(dolphinExe())) throw new Error('Dolphin is not set up yet. Open Settings → Emulators.');
  } else {
    if (!emulators.exists(retroarchExe())) throw new Error('RetroArch is not set up yet. Open Settings → Emulators.');
    if (!emuInfo.n64Core) throw new Error('The N64 core is missing. Open Settings → Emulators and click "Install N64 core".');
  }
}

function trackRecent(key) {
  settings.recent = [{ key, t: Date.now() }, ...(settings.recent || []).filter((r) => r.key !== key)].slice(0, 20);
  saveSettings();
  emit('settings', settings);
}

function spawnTracked(system, exe, args, extra) {
  const logFile = path.join(P.logs, `${system === 'gc' ? 'dolphin' : 'retroarch'}-last.log`);
  const folders = [USER, ...settings.romFolders];
  const child = emulators.launch(exe, args, { logFile, folders });
  child.on('error', (err) => {
    log('spawn error', err.message);
    toast(`Could not start the emulator: ${err.message}`, 'error');
  });
  child.on('exit', (code) => {
    log(`${system} exited with ${code}`);
    if (session && session.child === child) {
      const wasHost = session.role === 'host';
      setSession(null);
      if (wasHost && lobbyView && lobbyView.state !== 'waiting') lobby.send({ type: 'endGame' });
      if (code && code !== 0 && extra?.warnOnCrash !== false) toast(`The emulator closed unexpectedly (code ${code}). Logs: Settings → Open logs.`, 'warn');
    }
  });
  return child;
}

async function playSolo(key) {
  const game = library.byKey(key);
  if (!game) throw new Error('That game is no longer in your library. Try rescanning.');
  if (session) throw new Error('An emulator session is already running.');
  requireEmulator(game.system);
  trackRecent(key);
  if (game.system === 'gc') {
    dolphin.prepare({ userDir: P.dolphinUser, mode: 'solo', platform: process.platform, settings, game, romFolders: settings.romFolders });
    const child = spawnTracked('gc', dolphinExe(), dolphin.args({ userDir: P.dolphinUser, mode: 'solo', game }));
    setSession({ system: 'gc', role: 'solo', phase: 'playing', title: game.title, child, text: 'Playing solo in Dolphin.' });
  } else {
    const { appendConfig, baseConfig } = retroarch.prepare({ bundle: raBundle(), dataDir: P.retroarchData, mode: 'solo', settings, nickname: settings.name });
    const child = spawnTracked('n64', retroarchExe(), retroarch.args({ corePath: emuInfo.n64Core, romPath: game.path, appendConfig, baseConfig }));
    setSession({ system: 'n64', role: 'solo', phase: 'playing', title: game.title, child, text: 'Playing solo. Hold Right Ctrl + Esc to quit, Right Ctrl + F for fullscreen.' });
  }
}

async function onLaunch(msg) {
  if (session && session.child) {
    try { session.child.kill(); } catch { /* ignore */ }
    setSession(null);
  }
  const game = library.byKey(msg.game.key);
  if (!game) throw new Error(`You don't have the exact game this lobby needs (${describe(msg.game)}).`);
  requireEmulator(msg.system);
  trackRecent(game.key);
  notify('Match starting', `${msg.game.title} is launching`);
  const base = { system: msg.system, role: msg.role, title: game.title, code: msg.code, inputDelay: msg.inputDelay, game, hostOptions: msg.hostOptions };

  if (msg.system === 'gc') {
    if (msg.role === 'host') {
      const { exclusive } = dolphin.prepare({
        userDir: P.dolphinUser, mode: 'host', platform: process.platform, settings, game,
        romFolders: settings.romFolders, lobbyCode: msg.code, indexUrl: `${httpBase(serverUrl())}/dolphin`,
        nickname: settings.name, inputDelay: msg.inputDelay,
      });
      const child = spawnTracked('gc', dolphinExe(), dolphin.args({ userDir: P.dolphinUser, mode: 'host' }));
      setSession({ ...base, child, phase: 'dolphin', steps: dolphin.instructions('host', exclusive), text: 'Dolphin is open. Start hosting from its NetPlay window.' });
    } else {
      setSession({ ...base, phase: 'waiting', text: 'Waiting for the host to open their Dolphin session…' });
    }
    return;
  }

  // N64 / RetroArch
  if (msg.role === 'host') {
    const port = settings.netplay?.retroarchPort || 55435;
    const { appendConfig, baseConfig } = retroarch.prepare({ bundle: raBundle(),
      dataDir: P.retroarchData, mode: 'host', settings, nickname: settings.name,
      inputDelay: msg.inputDelay, hostOptions: msg.hostOptions,
    });
    const child = spawnTracked('n64', retroarchExe(), retroarch.args({
      corePath: emuInfo.n64Core, romPath: game.path, appendConfig, baseConfig, nickname: settings.name, net: { role: 'host', port },
    }));
    setSession({ ...base, child, port, phase: 'starting', text: 'Starting RetroArch and opening the netplay port…' });
    const up = await tunnel.waitForPort(port, 45000, () => session && session.child === child && child.exitCode === null);
    if (!session || session.child !== child) return;
    if (!up) throw new Error(`RetroArch did not open netplay port ${port}. Is something else using it?`);
    lobby.send({ type: 'hostReady', port, lanIps: emulators.lanAddresses() });
    setSession({ phase: 'playing', text: 'Hosting. Players are connecting. Hold Right Ctrl + Esc to quit.' });
  } else {
    setSession({ ...base, phase: 'waiting', text: 'Waiting for the host\'s emulator to come online…' });
  }
}

async function onConnectInfo(msg) {
  if (!session || session.role !== 'guest' || session.system !== 'n64' || session.child) return;
  const { game } = session;
  const { appendConfig, baseConfig } = retroarch.prepare({ bundle: raBundle(),
    dataDir: P.retroarchData, mode: 'guest', settings, nickname: settings.name,
    inputDelay: session.inputDelay, hostOptions: session.hostOptions,
  });
  let ip = msg.ip;
  let port = msg.port;
  let tun = null;
  if (msg.mode === 'relay') {
    tun = await tunnel.startGuest({ serverUrl: serverUrl(), pid: lobby.me.id, token: lobby.me.token, log });
    ip = '127.0.0.1';
    port = tun.port;
  }
  const child = spawnTracked('n64', retroarchExe(), retroarch.args({
    corePath: emuInfo.n64Core, romPath: game.path, appendConfig, baseConfig, nickname: settings.name, net: { role: 'guest', ip, port },
  }));
  setSession({
    child, tunnel: tun, netMode: msg.mode, phase: 'playing',
    text: msg.mode === 'relay' ? 'Connected through the relay. Hold Right Ctrl + Esc to quit.' : 'Connected directly to the host. Hold Right Ctrl + Esc to quit.',
  });
}

async function onDolphinSession(msg) {
  if (!session || session.role !== 'guest' || session.system !== 'gc') return;
  if (session.child) {
    // Dolphin is already open: show the new code so they can paste it
    setSession({ hostCode: msg.hostCode, text: `Host restarted their session. New host code: ${msg.hostCode}` });
    return;
  }
  dolphin.prepare({
    userDir: P.dolphinUser, mode: 'guest', platform: process.platform, settings, game: session.game,
    romFolders: settings.romFolders, indexUrl: `${httpBase(serverUrl())}/dolphin`, nickname: settings.name,
    inputDelay: session.inputDelay, hostCode: msg.hostCode, method: msg.method, port: msg.port,
  });
  const child = spawnTracked('gc', dolphinExe(), dolphin.args({ userDir: P.dolphinUser, mode: 'guest' }));
  setSession({ child, hostCode: msg.hostCode, phase: 'dolphin', steps: dolphin.instructions('guest'), text: 'Dolphin is open with the host\'s code filled in.' });
}

function stopSession() {
  if (session?.child) {
    try { session.child.kill(); } catch { /* ignore */ }
  }
  if (session?.role === 'host' && lobbyView && lobbyView.state !== 'waiting') lobby.send({ type: 'endGame' });
  setSession(null);
}

// -------------------------------------------------------- embedded server
async function applyEmbeddedServer() {
  const want = !!settings.embeddedServer?.enabled;
  if (!want && embedded) {
    await embedded.close();
    embedded = null;
  }
  if (want && !embedded) {
    const { createServer } = require('./lib/server-embedded');
    embedded = createServer({ log: (...a) => log('[server]', ...a) });
    try {
      await embedded.listen(settings.embeddedServer.port || 8080, '0.0.0.0');
    } catch (err) {
      embedded = null;
      toast(`Could not start the local server: ${err.message}`, 'error');
    }
  }
}

// ------------------------------------------------------------------- misc
/**
 * macOS marks everything in a downloaded app as quarantined. Once the player has opened
 * Netcade, the built-in emulators inside it are trusted too, so clear the flag on them
 * (otherwise macOS may block them the first time Netcade launches them).
 */
function clearMacQuarantine() {
  if (process.platform !== 'darwin' || !BUNDLE || !app.isPackaged) return;
  require('child_process').execFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', BUNDLE.dir], () => {});
}

function testServer(url) {
  return new Promise((resolve) => {
    let base;
    try { base = httpBase(url); } catch { return resolve({ ok: false, error: 'Invalid address' }); }
    const mod = base.startsWith('https') ? https : http;
    const req = mod.get(`${base}/health`, { timeout: 6000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve({ ok: j.name === 'netcade-server', info: j, error: j.name === 'netcade-server' ? null : 'That address is not a Netcade server' });
        } catch {
          resolve({ ok: false, error: 'That address is not a Netcade server' });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timed out' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function handleProtocolUrl(url) {
  const m = /^netcade:\/\/join\/([A-Za-z0-9]{4,8})/.exec(String(url || ''));
  if (!m) return;
  const code = m[1].toUpperCase();
  if (lobby.state === 'online') lobby.send({ type: 'join', code });
  else pendingJoin = code;
  emit('navigate', 'online');
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
}

// --------------------------------------------------------------------- IPC
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      log(`ipc ${channel} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

handle('state:get', async () => ({
  settings,
  games: library.games,
  errors: library.errors,
  emulators: emuInfo,
  server: { state: lobby.state, me: lobby.me, url: serverUrl() },
  lobby: lobbyView ? { ...lobbyView, myHas, myId: lobby.me?.id } : null,
  session: session ? { ...session, child: undefined, tunnel: undefined } : null,
  platform: process.platform,
  appVersion: APP_VERSION,
  lanIps: emulators.lanAddresses(),
  downloadPages: emulators.DOWNLOAD_PAGES,
  bundle: BUNDLE ? { builtAt: BUNDLE.builtAt, dolphin: BUNDLE.dolphin?.version, retroarch: BUNDLE.retroarch?.version, n64Core: BUNDLE.n64Core?.version } : null,
  defaultServerUrl: BUILD_CONFIG.defaultServerUrl || '',
}));

handle('settings:set', async (patch) => {
  const before = { name: settings.name, url: serverUrl(), emb: JSON.stringify(settings.embeddedServer), folders: JSON.stringify(settings.romFolders) };
  // arrays and control maps are replaced, not merged
  settings = deepMerge(settings, patch);
  for (const key of ['romFolders', 'favorites', 'recent']) if (patch && Array.isArray(patch[key])) settings[key] = patch[key];
  if (patch?.controls) {
    for (const sys of ['n64', 'gc']) {
      for (const mode of ['keyboard', 'gamepad']) {
        if (patch.controls[sys]?.[mode]) settings.controls[sys][mode] = patch.controls[sys][mode];
      }
    }
  }
  saveSettings();
  if (JSON.stringify(settings.embeddedServer) !== before.emb) await applyEmbeddedServer();
  if (settings.name !== before.name || serverUrl() !== before.url) {
    if (serverUrl() !== before.url) lobby.disconnect();
    sendHello();
  }
  if (JSON.stringify(settings.romFolders) !== before.folders) scanLibrary();
  if (patch && patch.emulatorSource !== undefined) await refreshEmulators();
  emit('settings', settings);
  return settings;
});

handle('library:addFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder with your N64 / GameCube games', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return settings.romFolders;
  settings.romFolders = [...new Set([...settings.romFolders, ...r.filePaths])];
  saveSettings();
  emit('settings', settings);
  scanLibrary();
  return settings.romFolders;
});

handle('library:removeFolder', async (folder) => {
  settings.romFolders = settings.romFolders.filter((f) => f !== folder);
  saveSettings();
  emit('settings', settings);
  scanLibrary();
  return settings.romFolders;
});

handle('library:rescan', () => scanLibrary());

handle('library:favorite', async (key) => {
  const fav = new Set(settings.favorites);
  if (fav.has(key)) fav.delete(key); else fav.add(key);
  settings.favorites = [...fav];
  saveSettings();
  emit('settings', settings);
  return settings.favorites;
});

handle('library:reveal', async (key) => {
  const g = library.byKey(key);
  if (g) shell.showItemInFolder(g.path);
});

handle('emu:browse', async (kind) => {
  const filters = process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [];
  const title = kind === 'core' ? 'Choose mupen64plus_next_libretro core file'
    : kind === 'dolphin' ? 'Find Dolphin (Dolphin.exe / Dolphin.app)' : 'Find RetroArch (retroarch.exe / RetroArch.app)';
  const r = await dialog.showOpenDialog(win, { title, properties: ['openFile'], filters: kind === 'core' ? [] : filters });
  if (r.canceled || !r.filePaths[0]) return emuInfo;
  let p = r.filePaths[0];
  if (process.platform === 'darwin' && p.endsWith('.app')) p = path.join(p, 'Contents', 'MacOS', kind === 'dolphin' ? 'Dolphin' : 'RetroArch');
  settings.emulatorSource = 'custom';   // choosing a file means "use my own install"
  if (kind === 'dolphin') settings.dolphinPath = p;
  else if (kind === 'retroarch') settings.retroarchPath = p;
  else settings.n64CorePath = p;
  saveSettings();
  return refreshEmulators();
});

handle('emu:detect', async () => {
  settings.dolphinPath = emulators.exists(settings.dolphinPath) ? settings.dolphinPath : '';
  settings.retroarchPath = emulators.exists(settings.retroarchPath) ? settings.retroarchPath : '';
  return refreshEmulators(true);
});

handle('emu:installCore', async () => {
  const dest = await emulators.installN64Core(P.cores, (got, total) => emit('core-progress', { got, total }));
  settings.n64CorePath = dest;
  saveSettings();
  return refreshEmulators();
});

handle('play:solo', (key) => playSolo(key));
handle('session:stop', () => stopSession());

handle('lobby:create', async ({ key, public: isPublic, maxPlayers, password, forceRelay }) => {
  const g = library.byKey(key);
  if (!g) throw new Error('Pick a game from your library first.');
  if (!lobby.send({ type: 'create', system: g.system, game: publicGame(g), public: !!isPublic, maxPlayers, password, forceRelay: forceRelay ?? settings.netplay.forceRelay })) {
    throw new Error('Not connected to the server. Check Settings → Online.');
  }
});

handle('lobby:setGame', async (key) => {
  const g = library.byKey(key);
  if (!g) throw new Error('Game not found');
  lobby.send({ type: 'setGame', system: g.system, game: publicGame(g) });
});

handle('lobby:send', async (msg) => {
  if (!msg || typeof msg.type !== 'string') throw new Error('bad message');
  const allowed = ['list', 'join', 'leave', 'chat', 'ready', 'kick', 'setOptions', 'start', 'endGame', 'reorder', 'dolphinManual'];
  if (!allowed.includes(msg.type)) throw new Error('not allowed');
  if (msg.type === 'start') msg.hostOptions = { n64Renderer: settings.graphics.n64Renderer };
  if (!lobby.send(msg)) throw new Error('Not connected to the server.');
});

handle('server:test', (url) => testServer(url));
handle('server:reconnect', async () => { lobby.disconnect(); sendHello(); });

handle('app:openExternal', async (url) => {
  if (/^https?:\/\//.test(url)) await shell.openExternal(url);
});
handle('app:openPath', async (which) => {
  const target = { logs: P.logs, data: USER, dolphin: P.dolphinUser, retroarch: P.retroarchData }[which];
  if (target) {
    fs.mkdirSync(target, { recursive: true });
    await shell.openPath(target);
  }
});
handle('app:copy', async (text) => clipboard.writeText(String(text)));

// -------------------------------------------------------------- lifecycle
function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0d14',
    title: 'Netcade',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleProtocolUrl(url);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleProtocolUrl(url);
  });

  app.whenReady().then(async () => {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    createWindow();
    clearMacQuarantine();
    await applyEmbeddedServer();
    refreshEmulators().catch((e) => log('emu refresh failed', e.message));
    if (settings.romFolders.length) scanLibrary().catch((e) => log('scan failed', e.message));
    sendHello();
    const url = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (url) handleProtocolUrl(url);
    try {
      if (app.isPackaged) {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }
    } catch { /* updater optional */ }
  });

  app.on('window-all-closed', () => {
    if (session?.child) { try { session.child.kill(); } catch { /* ignore */ } }
    app.quit();
  });
  app.on('activate', () => {
    if (!win) createWindow();
  });
}
