'use strict';
/**
 * Netcade lobby server
 *
 *  - /ws            JSON WebSocket: lobbies, chat, ready checks, game matching, launch signalling
 *  - /relay         binary WebSocket tunnels (TCP relay for N64/RetroArch when direct fails)
 *  - /dolphin/v0/*  a private implementation of Dolphin's NetPlay session-index API. Dolphin
 *                   instances launched by Netcade point their "IndexServer" here, so when the
 *                   host clicks "Host" in Dolphin, this server learns the traversal host code
 *                   and pushes it straight to the other players' launchers.
 *  - /health        liveness probe
 *
 * No game data ever passes through this server except relayed netplay traffic.
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');

const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = 1;

const LIMITS = {
  maxNameLen: 24,
  maxChatLen: 300,
  maxTitleLen: 120,
  maxPlayers: 4,
  chatHistory: 60,
  maxLobbies: 2000,
  msgBurst: 40,          // messages allowed per window
  msgWindowMs: 5000,
  tunnelsPerLobby: 24,
  tunnelPairTimeoutMs: 15000,
  probeTimeoutMs: 2500,
  pingIntervalMs: 4000,
  deadAfterMs: 30000,
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function createServer(options = {}) {
  const opts = {
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === '1',
    log: options.log ?? ((...a) => console.log(new Date().toISOString(), ...a)),
    probe: options.probe ?? probeTcp,
  };

  /** @type {Map<string, Player>} */
  const players = new Map();
  /** @type {Map<string, Lobby>} */
  const lobbies = new Map();
  /** dolphin index secret -> lobby code */
  const dolphinSecrets = new Map();
  /** cid -> pending tunnel */
  const pendingTunnels = new Map();

  // ---------------------------------------------------------------- helpers
  const now = () => Date.now();
  const rid = (n = 12) => crypto.randomBytes(n).toString('base64url');

  function clientIp(req) {
    if (opts.trustProxy) {
      const fly = req.headers['fly-client-ip'];
      if (fly) return String(fly).trim();
      const cf = req.headers['cf-connecting-ip'];
      if (cf) return String(cf).trim();
      const xff = req.headers['x-forwarded-for'];
      if (xff) return String(xff).split(',')[0].trim();
    }
    return normalizeIp(req.socket.remoteAddress || '');
  }

  function normalizeIp(ip) {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  function cleanText(s, max) {
    return String(s ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, max);
  }

  function newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let c = '';
      const bytes = crypto.randomBytes(6);
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
      if (!lobbies.has(c)) return c;
    }
    throw new Error('could not allocate lobby code');
  }

  function send(player, msg) {
    if (player && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(lobby, msg, exceptId) {
    for (const id of lobby.members) {
      if (id !== exceptId) send(players.get(id), msg);
    }
  }

  function systemChat(lobby, text) {
    const entry = { from: null, name: 'Netcade', text, t: now(), system: true };
    lobby.chat.push(entry);
    if (lobby.chat.length > LIMITS.chatHistory) lobby.chat.shift();
    broadcast(lobby, { type: 'chat', ...entry });
  }

  function lobbyView(lobby) {
    const members = lobby.members.map((id) => {
      const p = players.get(id);
      return {
        id,
        name: p?.name ?? '?',
        ping: p?.ping ?? null,
        ready: lobby.ready.has(id),
        has: lobby.has.get(id) ?? { status: 'unknown' },
        isHost: id === lobby.hostId,
        versions: p?.versions ?? {},
        port: lobby.members.indexOf(id) + 1,
      };
    });
    const versionKey = lobby.system === 'gc' ? 'dolphin' : 'retroarch';
    const distinct = new Set(members.map((m) => m.versions[versionKey]).filter(Boolean));
    return {
      code: lobby.code,
      system: lobby.system,
      game: lobby.game,
      hostId: lobby.hostId,
      public: lobby.public,
      hasPassword: !!lobby.password,
      maxPlayers: lobby.maxPlayers,
      state: lobby.state,
      forceRelay: lobby.forceRelay,
      inputDelay: lobby.inputDelay,
      members,
      versionMismatch: distinct.size > 1,
      dolphin: lobby.dolphin ? { hostCode: lobby.dolphin.serverId, method: lobby.dolphin.method, port: lobby.dolphin.port } : null,
      netplay: lobby.netplay ? { mode: lobby.netplay.mode } : null,
      createdAt: lobby.createdAt,
    };
  }

  function pushLobby(lobby) {
    const view = lobbyView(lobby);
    broadcast(lobby, { type: 'lobby', lobby: view });
  }

  function publicList() {
    const out = [];
    for (const l of lobbies.values()) {
      if (!l.public) continue;
      out.push({
        code: l.code,
        system: l.system,
        title: l.game?.title ?? 'Unknown game',
        region: l.game?.region ?? '',
        gameKey: l.game?.key ?? '',
        rev: l.game?.rev ?? 0,
        gameId: l.game?.id ?? '',
        players: l.members.length,
        maxPlayers: l.maxPlayers,
        state: l.state,
        hasPassword: !!l.password,
        hostName: players.get(l.hostId)?.name ?? '?',
        hostPing: players.get(l.hostId)?.ping ?? null,
      });
    }
    out.sort((a, b) => (a.state === 'waiting' ? 0 : 1) - (b.state === 'waiting' ? 0 : 1) || b.players - a.players);
    return out.slice(0, 200);
  }

  function sanitizeGame(g) {
    if (!g || typeof g !== 'object') return null;
    return {
      key: cleanText(g.key, 80),          // identity used for matching (hash or game id)
      title: cleanText(g.title, LIMITS.maxTitleLen) || 'Unknown game',
      region: cleanText(g.region, 16),
      rev: Number.isFinite(+g.rev) ? +g.rev : 0,
      id: cleanText(g.id, 16),            // GC game ID (GALE01) / N64 cart code (NSME)
      size: Number.isFinite(+g.size) ? +g.size : 0,
    };
  }

  // ------------------------------------------------------------ lobby ops
  function leaveLobby(player, reason) {
    const code = player.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    player.lobbyCode = null;
    if (!lobby) return;
    lobby.members = lobby.members.filter((id) => id !== player.id);
    lobby.ready.delete(player.id);
    lobby.has.delete(player.id);

    if (lobby.members.length === 0) {
      destroyLobby(lobby);
      return;
    }
    if (lobby.hostId === player.id) {
      lobby.hostId = lobby.members[0];
      if (lobby.state !== 'waiting') endGame(lobby, 'The host left, so the match ended.');
      systemChat(lobby, `${player.name} left. ${players.get(lobby.hostId)?.name} is now the host.`);
    } else {
      systemChat(lobby, `${player.name} ${reason === 'kick' ? 'was removed' : 'left'}.`);
    }
    pushLobby(lobby);
  }

  function destroyLobby(lobby) {
    if (lobby.dolphin?.secret) dolphinSecrets.delete(lobby.dolphin.secret);
    for (const [cid, t] of pendingTunnels) {
      if (t.code === lobby.code) {
        t.guestWs.close(1000, 'lobby closed');
        pendingTunnels.delete(cid);
      }
    }
    lobbies.delete(lobby.code);
  }

  function endGame(lobby, msg) {
    lobby.state = 'waiting';
    lobby.netplay = null;
    if (lobby.dolphin?.secret) dolphinSecrets.delete(lobby.dolphin.secret);
    lobby.dolphin = null;
    lobby.ready.clear();
    broadcast(lobby, { type: 'gameEnded', message: msg || null });
  }

  // ------------------------------------------------------- message router
  const handlers = {
    hello(p, m) {
      p.name = cleanText(m.name, LIMITS.maxNameLen) || p.name;
      if (m.versions && typeof m.versions === 'object') {
        p.versions = {
          app: cleanText(m.versions.app, 40),
          dolphin: cleanText(m.versions.dolphin, 60),
          retroarch: cleanText(m.versions.retroarch, 60),
        };
      }
      if (p.lobbyCode) pushLobby(lobbies.get(p.lobbyCode));
    },

    list(p) {
      send(p, { type: 'lobbies', list: publicList() });
    },

    create(p, m) {
      if (lobbies.size >= LIMITS.maxLobbies) return send(p, { type: 'error', message: 'Server is full, try again later.' });
      const system = m.system === 'gc' ? 'gc' : m.system === 'n64' ? 'n64' : null;
      if (!system) return send(p, { type: 'error', message: 'Pick a game first.' });
      const game = sanitizeGame(m.game);
      if (!game) return send(p, { type: 'error', message: 'Pick a game first.' });
      leaveLobby(p);
      const code = newCode();
      const lobby = {
        code,
        system,
        game,
        hostId: p.id,
        members: [p.id],
        ready: new Set(),
        has: new Map([[p.id, { status: 'match' }]]),
        public: !!m.public,
        password: cleanText(m.password, 32) || '',
        maxPlayers: clampInt(m.maxPlayers, 2, LIMITS.maxPlayers, 4),
        forceRelay: !!m.forceRelay,
        inputDelay: m.inputDelay === undefined ? 'auto' : m.inputDelay,
        state: 'waiting',
        chat: [],
        createdAt: now(),
        dolphin: null,
        netplay: null,
        tunnels: 0,
      };
      lobbies.set(code, lobby);
      p.lobbyCode = code;
      send(p, { type: 'joined', code, chat: [] });
      systemChat(lobby, `Lobby created for ${game.title}. Share code ${code} to invite friends.`);
      pushLobby(lobby);
    },

    join(p, m) {
      const code = cleanText(m.code, 8).toUpperCase();
      const lobby = lobbies.get(code);
      if (!lobby) return send(p, { type: 'error', message: `No lobby with code ${code}.` });
      if (lobby.members.includes(p.id)) return pushLobby(lobby);
      if (lobby.password && lobby.password !== String(m.password ?? '')) {
        return send(p, { type: 'error', message: 'Wrong lobby password.', needPassword: true, code });
      }
      if (lobby.members.length >= lobby.maxPlayers) return send(p, { type: 'error', message: 'That lobby is full.' });
      if (lobby.state !== 'waiting') return send(p, { type: 'error', message: 'That match is already running. Try again when it ends.' });
      leaveLobby(p);
      lobby.members.push(p.id);
      p.lobbyCode = code;
      send(p, { type: 'joined', code, chat: lobby.chat });
      systemChat(lobby, `${p.name} joined.`);
      pushLobby(lobby);
    },

    leave(p) {
      leaveLobby(p);
      send(p, { type: 'left' });
    },

    chat(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby) return;
      const text = cleanText(m.text, LIMITS.maxChatLen);
      if (!text) return;
      const entry = { from: p.id, name: p.name, text, t: now(), system: false };
      lobby.chat.push(entry);
      if (lobby.chat.length > LIMITS.chatHistory) lobby.chat.shift();
      broadcast(lobby, { type: 'chat', ...entry });
    },

    ready(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.state !== 'waiting') return;
      if (m.ready) lobby.ready.add(p.id); else lobby.ready.delete(p.id);
      pushLobby(lobby);
    },

    has(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby) return;
      const status = ['match', 'missing', 'mismatch'].includes(m.status) ? m.status : 'unknown';
      lobby.has.set(p.id, { status, detail: cleanText(m.detail, 160) });
      if (status !== 'match') lobby.ready.delete(p.id);
      pushLobby(lobby);
    },

    kick(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || m.id === p.id) return;
      const target = players.get(m.id);
      if (!target || target.lobbyCode !== lobby.code) return;
      leaveLobby(target, 'kick');
      send(target, { type: 'kicked' });
    },

    setGame(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.state !== 'waiting') return;
      const system = m.system === 'gc' ? 'gc' : 'n64';
      const game = sanitizeGame(m.game);
      if (!game) return;
      lobby.system = system;
      lobby.game = game;
      lobby.ready.clear();
      for (const id of lobby.members) if (id !== lobby.hostId) lobby.has.set(id, { status: 'unknown' });
      systemChat(lobby, `Host switched the game to ${game.title}.`);
      pushLobby(lobby);
    },

    setOptions(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id) return;
      if (m.public !== undefined) lobby.public = !!m.public;
      if (m.maxPlayers !== undefined) lobby.maxPlayers = Math.max(lobby.members.length, clampInt(m.maxPlayers, 2, LIMITS.maxPlayers, lobby.maxPlayers));
      if (m.forceRelay !== undefined) lobby.forceRelay = !!m.forceRelay;
      if (m.inputDelay !== undefined) lobby.inputDelay = m.inputDelay === 'auto' ? 'auto' : clampInt(m.inputDelay, 0, 15, 2);
      if (m.password !== undefined) lobby.password = cleanText(m.password, 32);
      pushLobby(lobby);
    },

    reorder(p, m) {
      // host can move players between controller ports
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.state !== 'waiting') return;
      const order = Array.isArray(m.order) ? m.order : [];
      if (order.length !== lobby.members.length || !order.every((id) => lobby.members.includes(id))) return;
      lobby.members = order.slice();
      pushLobby(lobby);
    },

    start(p, m) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id) return;
      if (lobby.state !== 'waiting') return;
      const notReady = lobby.members.filter((id) => id !== lobby.hostId && !lobby.ready.has(id));
      if (notReady.length) {
        return send(p, { type: 'error', message: `Waiting on: ${notReady.map((id) => players.get(id)?.name).join(', ')}` });
      }
      const delay = resolveInputDelay(lobby);
      // emulation settings that must be identical for everyone (decided by the host)
      const hostOptions = {
        n64Renderer: m && m.hostOptions && m.hostOptions.n64Renderer === 'gliden64' ? 'gliden64' : 'parallel',
      };
      lobby.state = 'starting';
      lobby.netplay = null;
      lobby.dolphin = null;
      systemChat(lobby, lobby.members.length > 1 ? 'Starting the match…' : 'Starting (solo).');
      for (const id of lobby.members) {
        send(players.get(id), {
          type: 'launch',
          system: lobby.system,
          role: id === lobby.hostId ? 'host' : 'guest',
          code: lobby.code,
          port: lobby.members.indexOf(id) + 1,
          playerCount: lobby.members.length,
          inputDelay: delay,
          game: lobby.game,
          hostOptions,
        });
      }
      pushLobby(lobby);
    },

    async hostReady(p, m) {
      // N64 / RetroArch: the host's emulator is now listening on m.port.
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.system !== 'n64') return;
      const port = clampInt(m.port, 1, 65535, 55435);
      const lanIps = Array.isArray(m.lanIps) ? m.lanIps.slice(0, 4).map((s) => cleanText(s, 45)).filter((s) => net.isIP(s)) : [];
      let mode = 'relay';
      if (!lobby.forceRelay && net.isIP(p.ip)) {
        const reachable = await opts.probe(p.ip, port, LIMITS.probeTimeoutMs);
        if (reachable) mode = 'direct';
      }
      if (!lobbies.has(lobby.code)) return;
      lobby.netplay = { mode, ip: p.ip, port, lanIps };
      lobby.state = 'in-game';
      systemChat(lobby, mode === 'direct'
        ? 'Host is reachable directly. Connecting peer-to-peer.'
        : 'Host is behind a strict router. Connecting through the relay.');
      for (const id of lobby.members) {
        if (id === lobby.hostId) continue;
        sendConnectInfo(lobby, players.get(id));
      }
      send(p, { type: 'hostMode', mode });
      pushLobby(lobby);
    },

    dolphinManual(p, m) {
      // fallback: host typed the Dolphin host code by hand
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.system !== 'gc') return;
      const code = cleanText(m.hostCode, 64);
      if (!code) return;
      const isIp = /^[0-9a-fA-F:.]+$/.test(code) && code.includes('.');
      lobby.dolphin = { serverId: code, method: isIp ? 'direct' : 'traversal', port: clampInt(m.port, 1, 65535, 2626), secret: null, inGame: false, playerCount: 1 };
      lobby.state = 'in-game';
      announceDolphin(lobby);
    },

    endGame(p) {
      const lobby = lobbies.get(p.lobbyCode);
      if (!lobby || lobby.hostId !== p.id || lobby.state === 'waiting') return;
      endGame(lobby, 'The host ended the match.');
      systemChat(lobby, 'Match ended. Back in the lobby.');
      pushLobby(lobby);
    },

    pong(p, m) {
      const t = +m.t;
      if (Number.isFinite(t)) {
        const sample = Math.max(0, now() - t);
        p.ping = p.ping == null ? sample : Math.round(p.ping * 0.6 + sample * 0.4);
      }
      p.lastPong = now();
    },
  };

  function resolveInputDelay(lobby) {
    if (lobby.inputDelay !== 'auto') return lobby.inputDelay;
    // one frame per ~16.7ms of the worst round-trip, halved because each side only waits one way
    let worst = 0;
    for (const id of lobby.members) worst = Math.max(worst, players.get(id)?.ping ?? 0);
    return Math.min(10, Math.max(1, Math.ceil(worst / 2 / 16.7) + 1));
  }

  function sendConnectInfo(lobby, guest) {
    if (!guest || !lobby.netplay) return;
    const np = lobby.netplay;
    if (np.mode === 'direct') {
      // same household as the host? public IP hairpinning often fails, so use the LAN address
      const ip = guest.ip === np.ip && np.lanIps.length ? np.lanIps[0] : np.ip;
      send(guest, { type: 'connectInfo', mode: 'direct', ip, port: np.port });
    } else {
      send(guest, { type: 'connectInfo', mode: 'relay', port: np.port });
    }
  }

  function announceDolphin(lobby) {
    const d = lobby.dolphin;
    systemChat(lobby, d.method === 'traversal'
      ? `Host's Dolphin session is up (code ${d.serverId}). Guests are being connected.`
      : `Host's Dolphin session is up at ${d.serverId}. Guests are being connected.`);
    broadcast(lobby, { type: 'dolphinSession', hostCode: d.serverId, method: d.method, port: d.port }, lobby.hostId);
    pushLobby(lobby);
  }

  // ------------------------------------------------- Dolphin index (HTTP)
  function handleDolphin(req, res, url, ip) {
    const q = url.searchParams;
    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    const path = url.pathname.replace(/^\/dolphin/, '');

    if (path === '/v0/list') {
      const nameFilter = (q.get('name') || '').toUpperCase();
      const sessions = [];
      for (const l of lobbies.values()) {
        if (l.system !== 'gc' || !l.dolphin) continue;
        if (!l.public && nameFilter !== l.code) continue; // private lobbies only show to people who know the code
        if (nameFilter && !l.code.includes(nameFilter) && !l.game.title.toUpperCase().includes(nameFilter)) continue;
        sessions.push({
          name: l.code,
          region: 'NA',
          method: l.dolphin.method,
          game: l.dolphin.game || l.game.title,
          server_id: l.dolphin.serverId,
          password: false,
          player_count: l.dolphin.playerCount || 1,
          port: l.dolphin.port || 2626,
          in_game: !!l.dolphin.inGame,
          version: l.dolphin.version || '',
        });
      }
      return json({ status: 'OK', sessions });
    }

    if (path === '/v0/session/add') {
      const name = (q.get('name') || '').toUpperCase().trim();
      const lobby = lobbies.get(name);
      if (!lobby || lobby.system !== 'gc') return json({ status: 'NOT_A_NETCADE_LOBBY' });
      if (lobby.state === 'waiting') return json({ status: 'MATCH_NOT_STARTED' });
      const host = players.get(lobby.hostId);
      if (process.env.STRICT_INDEX_IP === '1' && host && host.ip !== ip) return json({ status: 'NOT_HOST' });
      if (q.get('password') === '1') {
        // Netcade never sets an index password, so the id would be encrypted and useless to us
        return json({ status: 'PASSWORD_NOT_SUPPORTED' });
      }
      const serverId = cleanText(q.get('server_id'), 64);
      if (!serverId) return json({ status: 'MISSING_SERVER_ID' });
      if (lobby.dolphin?.secret) dolphinSecrets.delete(lobby.dolphin.secret);
      const secret = rid(16);
      lobby.dolphin = {
        serverId,
        method: q.get('method') === 'direct' ? 'direct' : 'traversal',
        port: clampInt(q.get('port'), 1, 65535, 2626),
        game: cleanText(q.get('game'), 120),
        version: cleanText(q.get('version'), 60),
        playerCount: clampInt(q.get('player_count'), 0, 16, 1),
        inGame: q.get('in_game') === '1',
        secret,
        lastSeen: now(),
      };
      dolphinSecrets.set(secret, lobby.code);
      lobby.state = 'in-game';
      opts.log(`[dolphin] session for lobby ${lobby.code}: ${lobby.dolphin.method} ${serverId}`);
      announceDolphin(lobby);
      return json({ status: 'OK', secret });
    }

    if (path === '/v0/session/active') {
      const code = dolphinSecrets.get(q.get('secret') || '');
      const lobby = code && lobbies.get(code);
      if (!lobby || !lobby.dolphin) return json({ status: 'BAD_SECRET' });
      const wasInGame = lobby.dolphin.inGame;
      lobby.dolphin.playerCount = clampInt(q.get('player_count'), 0, 16, lobby.dolphin.playerCount);
      lobby.dolphin.inGame = q.get('in_game') === '1';
      lobby.dolphin.game = cleanText(q.get('game'), 120) || lobby.dolphin.game;
      lobby.dolphin.lastSeen = now();
      if (!wasInGame && lobby.dolphin.inGame) systemChat(lobby, 'Game is running. Have fun!');
      return json({ status: 'OK' });
    }

    if (path === '/v0/session/remove') {
      const code = dolphinSecrets.get(q.get('secret') || '');
      dolphinSecrets.delete(q.get('secret') || '');
      const lobby = code && lobbies.get(code);
      if (lobby && lobby.state !== 'waiting') {
        endGame(lobby, 'The host closed the Dolphin session.');
        systemChat(lobby, 'Host closed the Dolphin session. Back in the lobby.');
        pushLobby(lobby);
      }
      return json({ status: 'OK' });
    }

    return json({ status: 'NOT_FOUND' }, 404);
  }

  // ------------------------------------------------------------- HTTP
  const httpServer = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const ip = clientIp(req);
    if (url.pathname === '/health' || url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'netcade-server', version: SERVER_VERSION, protocol: PROTOCOL_VERSION, players: players.size, lobbies: lobbies.size }));
      return;
    }
    if (url.pathname.startsWith('/dolphin/')) return handleDolphin(req, res, url, ip);
    if (url.pathname === '/api/lobbies') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(publicList()));
      return;
    }
    res.writeHead(404).end('not found');
  });

  // ------------------------------------------------------------- WebSockets
  const wssControl = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const wssRelay = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname === '/ws') {
      wssControl.handleUpgrade(req, socket, head, (ws) => onControl(ws, req));
    } else if (url.pathname === '/relay') {
      wssRelay.handleUpgrade(req, socket, head, (ws) => onRelay(ws, req, url));
    } else {
      socket.destroy();
    }
  });

  function onControl(ws, req) {
    const player = {
      id: rid(9),
      token: rid(18),
      ws,
      ip: clientIp(req),
      name: 'Player',
      versions: {},
      lobbyCode: null,
      ping: null,
      lastPong: now(),
      bucket: { count: 0, start: now() },
    };
    players.set(player.id, player);
    send(player, { type: 'welcome', id: player.id, token: player.token, serverVersion: SERVER_VERSION, protocol: PROTOCOL_VERSION });

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const b = player.bucket;
      if (now() - b.start > LIMITS.msgWindowMs) { b.start = now(); b.count = 0; }
      if (++b.count > LIMITS.msgBurst) return; // silently drop floods
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const h = msg && typeof msg.type === 'string' && Object.prototype.hasOwnProperty.call(handlers, msg.type) && handlers[msg.type];
      if (!h) return;
      try {
        await h(player, msg);
      } catch (err) {
        opts.log('handler error', msg.type, err);
      }
    });

    ws.on('close', () => {
      leaveLobby(player);
      players.delete(player.id);
    });
    ws.on('error', () => {});
  }

  function onRelay(ws, req, url) {
    const q = url.searchParams;
    const role = q.get('role');
    const player = players.get(q.get('pid') || '');
    if (!player || player.token !== q.get('token')) return ws.close(4001, 'auth');
    const lobby = lobbies.get(player.lobbyCode || '');
    if (!lobby || lobby.system !== 'n64' || !lobby.netplay) return ws.close(4002, 'no session');

    if (role === 'guest') {
      if (player.id === lobby.hostId) return ws.close(4003, 'host cannot be guest');
      if (lobby.tunnels >= LIMITS.tunnelsPerLobby) return ws.close(4004, 'too many tunnels');
      const cid = rid(12);
      const pending = { cid, code: lobby.code, guestWs: ws, buffer: [], bytes: 0 };
      pendingTunnels.set(cid, pending);
      lobby.tunnels++;
      const onEarly = (d) => {
        pending.bytes += d.length;
        if (pending.bytes > 512 * 1024) return ws.close(4005, 'buffer overflow');
        pending.buffer.push(d);
      };
      ws.on('message', onEarly);
      pending.detachEarly = () => ws.off('message', onEarly);
      ws.on('close', () => {
        if (pendingTunnels.get(cid) === pending) pendingTunnels.delete(cid);
        if (pending.hostWs) pending.hostWs.close();
        const l = lobbies.get(pending.code);
        if (l) l.tunnels = Math.max(0, l.tunnels - 1);
      });
      ws.on('error', () => {});
      pending.timer = setTimeout(() => {
        if (pendingTunnels.get(cid) === pending) {
          pendingTunnels.delete(cid);
          ws.close(4006, 'host did not answer');
        }
      }, LIMITS.tunnelPairTimeoutMs);
      send(players.get(lobby.hostId), { type: 'tunnelOpen', cid });
      return;
    }

    if (role === 'host') {
      if (player.id !== lobby.hostId) return ws.close(4003, 'not host');
      const cid = q.get('cid') || '';
      const pending = pendingTunnels.get(cid);
      if (!pending || pending.code !== lobby.code) return ws.close(4007, 'unknown tunnel');
      pendingTunnels.delete(cid);
      clearTimeout(pending.timer);
      pending.detachEarly();
      pending.hostWs = ws;
      const g = pending.guestWs;
      for (const chunk of pending.buffer) ws.send(chunk, { binary: true });
      pending.buffer = [];
      g.on('message', (d) => { if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true }); });
      ws.on('message', (d) => { if (g.readyState === WebSocket.OPEN) g.send(d, { binary: true }); });
      ws.on('close', () => g.close());
      ws.on('error', () => {});
      return;
    }
    ws.close(4000, 'bad role');
  }

  // ------------------------------------------------------------- timers
  const pingTimer = setInterval(() => {
    const t = now();
    for (const p of players.values()) {
      if (t - p.lastPong > LIMITS.deadAfterMs) {
        p.ws.terminate();
        continue;
      }
      send(p, { type: 'ping', t });
    }
    // refresh lobby views so pings stay current (cheap: tiny payloads, small lobbies)
    for (const l of lobbies.values()) pushLobby(l);
    // expire stale dolphin sessions (Dolphin refreshes every 5s)
    for (const l of lobbies.values()) {
      if (l.dolphin?.secret && t - l.dolphin.lastSeen > 45000) {
        endGame(l, 'Lost contact with the host\'s Dolphin session.');
        systemChat(l, 'Lost contact with the host\'s Dolphin. Back in the lobby.');
        pushLobby(l);
      }
    }
  }, LIMITS.pingIntervalMs);
  pingTimer.unref();

  return {
    httpServer,
    listen(port, host) {
      return new Promise((resolve) => httpServer.listen(port, host, () => resolve(httpServer.address())));
    },
    close() {
      clearInterval(pingTimer);
      for (const p of players.values()) p.ws.terminate();
      wssControl.close();
      wssRelay.close();
      return new Promise((resolve) => httpServer.close(() => resolve()));
    },
    _state: { players, lobbies },
  };
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function probeTcp(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

module.exports = { createServer, probeTcp };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8080', 10);
  const srv = createServer();
  srv.listen(port, '0.0.0.0').then((addr) => {
    console.log(`Netcade server ${SERVER_VERSION} listening on :${addr.port}`);
  });
  const shutdown = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
