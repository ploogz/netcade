'use strict';
/**
 * Dolphin integration.
 *
 * Netcade runs Dolphin with its own user folder (-u) so it never disturbs the player's normal
 * Dolphin setup. Before each launch it writes:
 *   - Config/Dolphin.ini : game folders, graphics backend, fullscreen, and the [NetPlay] section
 *   - Config/GFX.ini     : resolution, widescreen hack, async shaders, vsync
 *   - Config/GCPadNew.ini: the player's controls (from the lobby's Controls panel)
 *
 * Online play uses Dolphin's own netplay (traversal + UPnP for NAT). The [NetPlay] IndexServer is
 * pointed at the Netcade server and the session name is the lobby code, so the moment the host
 * presses "Host" in Dolphin, every guest's launcher receives the host code automatically.
 */
const fs = require('fs');
const path = require('path');
const ini = require('./ini');
const { dolphinGCPad, resolve } = require('./inputMaps');

const BACKENDS = {
  auto: { win32: 'D3D12', darwin: 'Metal', linux: 'Vulkan' },
  vulkan: 'Vulkan', d3d12: 'D3D12', metal: 'Metal', opengl: 'OGL',
};

function backendFor(setting, platform) {
  if (!setting || setting === 'auto') return BACKENDS.auto[platform] || 'Vulkan';
  return BACKENDS[setting] || 'Vulkan';
}

/**
 * Put the hosted game alone in a folder so it is the only entry in Dolphin's "Host" list.
 * Uses a hard link (no copy, no admin rights) and falls back to the game's own folder.
 */
function soloFolderFor(gamePath, sessionDir) {
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    const linkPath = path.join(sessionDir, path.basename(gamePath));
    try {
      fs.linkSync(gamePath, linkPath);
      return { folder: sessionDir, recursive: false, exclusive: true };
    } catch {
      fs.symlinkSync(gamePath, linkPath);
      return { folder: sessionDir, recursive: false, exclusive: true };
    }
  } catch {
    return { folder: path.dirname(gamePath), recursive: false, exclusive: false };
  }
}

/**
 * Write all Dolphin config for a launch.
 * opts: { userDir, mode: 'solo'|'host'|'guest', platform, settings, game, romFolders,
 *         lobbyCode, indexUrl, nickname, inputDelay, hostCode, method, port }
 */
function prepare(opts) {
  const { userDir, mode, platform, settings } = opts;
  const cfgDir = path.join(userDir, 'Config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const g = settings.graphics || {};

  // ----- game folders
  let folders = (opts.romFolders || []).slice();
  let recursive = true;
  let exclusive = false;
  if (mode === 'host' && opts.game) {
    const solo = soloFolderFor(opts.game.path, path.join(userDir, 'NetcadeSession'));
    folders = [solo.folder];
    recursive = solo.recursive;
    exclusive = solo.exclusive;
  }
  const general = { ISOPaths: folders.length, RecursiveISOPaths: recursive ? 'True' : 'False' };
  for (let i = 0; i < 32; i++) general[`ISOPath${i}`] = i < folders.length ? folders[i] : null;

  // ----- netplay
  const netplay = {
    Nickname: (opts.nickname || 'Player').replace(/[\r\n]/g, ' '),
    UseUPNP: 'True',
    SyncSaves: 'True',
    SyncCodes: 'True',
    WriteSaveData: 'True',
    NetworkMode: 'fixeddelay',
    BufferSize: Math.max(1, Math.min(20, (opts.inputDelay | 0) || 4)),
    TraversalServer: 'stun.dolphin-emu.org',
    TraversalPort: 6262,
  };
  if (mode === 'host') {
    Object.assign(netplay, {
      TraversalChoice: settings.netplay?.dolphinDirect ? 'direct' : 'traversal',
      UseIndex: 'True',
      IndexName: opts.lobbyCode,
      IndexRegion: 'NA',
      IndexPassword: '',
      IndexServer: opts.indexUrl,
      HostPort: settings.netplay?.dolphinPort || 2626,
    });
  } else if (mode === 'guest') {
    const direct = opts.method === 'direct';
    Object.assign(netplay, {
      TraversalChoice: direct ? 'direct' : 'traversal',
      HostCode: direct ? '00000000' : opts.hostCode || '00000000',
      Address: direct ? String(opts.hostCode || '').split(':')[0] : '127.0.0.1',
      ConnectPort: opts.port || 2626,
      IndexServer: opts.indexUrl,
      UseIndex: 'False',
    });
  }

  ini.updateFile(path.join(cfgDir, 'Dolphin.ini'), {
    General: general,
    Core: { GFXBackend: backendFor(g.gcBackend, platform), SIDevice0: 6 },
    Display: { Fullscreen: g.fullscreen ? 'True' : 'False', RenderToMain: 'False' },
    Interface: { ConfirmStop: 'False', PauseOnFocusLost: 'False', ShowActiveTitle: 'True' },
    Analytics: { Enabled: 'False', PermissionAsked: 'True' },
    NetPlay: netplay,
  });

  ini.updateFile(path.join(cfgDir, 'GFX.ini'), {
    Settings: {
      InternalResolution: Math.max(1, Math.min(8, g.gcScale || 2)),
      wideScreenHack: g.widescreen ? 'True' : 'False',
      ShaderCompilationMode: 2,            // async ubershaders: no stutter while shaders compile
      WaitForShadersBeforeStarting: 'True',
      ShowFPS: g.showFps ? 'True' : 'False',
    },
    Hardware: { VSync: g.vsync === false ? 'False' : 'True' },
  });

  writeControls(cfgDir, settings, platform);

  return { exclusive, folders };
}

function writeControls(cfgDir, settings, platform) {
  const c = settings.controls?.gc || {};
  const mode = c.mode === 'gamepad' ? 'gamepad' : 'keyboard';
  const map = resolve('gc', mode, c[mode]);
  const dev = mode === 'keyboard'
    ? { kind: 'keyboard' }
    : c.device?.kind === 'sdl' || (platform !== 'win32')
      ? { kind: 'sdl', index: c.device?.index | 0, name: c.device?.name || 'Controller' }
      : { kind: 'xinput', index: c.device?.index | 0 };
  const section = ini.linesToObject(dolphinGCPad(map, dev, platform));
  ini.updateFile(path.join(cfgDir, 'GCPadNew.ini'), {}, { GCPad1: section });
}

/** Command-line arguments for each launch mode. */
function args(opts) {
  const a = ['-u', opts.userDir];
  if (opts.mode === 'solo') {
    a.push('-b', '-e', opts.game.path);
  }
  // host/guest: open Dolphin's main window; netplay is started from Tools -> Start NetPlay Session
  return a;
}

/** Plain-language steps shown in the launcher while Dolphin is open. */
function instructions(mode, exclusive) {
  if (mode === 'host') {
    return [
      'In Dolphin, open Tools → Start NetPlay Session…',
      'Go to the Host tab. Netcade already filled in everything.',
      exclusive ? 'Double-click your game (it is the only one listed).' : 'Double-click your game in the list.',
      'When everyone appears in Dolphin\'s NetPlay window, press Start.',
    ];
  }
  return [
    'In Dolphin, open Tools → Start NetPlay Session…',
    'Stay on the Connect tab. The host code is already filled in.',
    'Click Connect, then wait for the host to press Start.',
  ];
}

module.exports = { prepare, args, instructions, writeControls, backendFor };
