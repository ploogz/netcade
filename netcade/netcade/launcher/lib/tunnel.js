'use strict';
/**
 * Relay tunnels for N64 netplay when the host can't be reached directly (strict NAT, CGNAT,
 * no UPnP). RetroArch only ever sees a plain local TCP connection; the bytes travel through the
 * Netcade server over WebSockets.
 *
 * Guest side: listen on 127.0.0.1:<random>; each RetroArch connection becomes one relay socket.
 * Host side:  when the server says "tunnelOpen", dial the relay and the local RetroArch port.
 */
const net = require('net');
const { WebSocket } = require('ws');

function relayUrl(serverUrl, params) {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  u.pathname = '/relay';
  u.search = new URLSearchParams(params).toString();
  return u.toString();
}

function pipe(sock, ws) {
  const pending = [];
  sock.setNoDelay(true);
  sock.on('data', (d) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: true });
    else if (ws.readyState === WebSocket.CONNECTING) pending.push(d);
  });
  ws.on('open', () => {
    for (const d of pending) ws.send(d, { binary: true });
    pending.length = 0;
  });
  ws.on('message', (d) => {
    if (!sock.destroyed) sock.write(d);
  });
  const end = () => {
    if (!sock.destroyed) sock.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  };
  sock.on('close', end);
  sock.on('error', end);
  ws.on('close', end);
  ws.on('error', end);
}

/** Start the guest-side listener. Resolves to { port, close() }. */
function startGuest({ serverUrl, pid, token, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      log('relay: emulator connected, opening tunnel');
      const ws = new WebSocket(relayUrl(serverUrl, { role: 'guest', pid, token }), { perMessageDeflate: false });
      pipe(sock, ws);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close() {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

/** Host side: connect one tunnel id to the local emulator port. */
function openHostTunnel({ serverUrl, pid, token, cid, localPort, log = () => {} }) {
  const sock = net.connect({ host: '127.0.0.1', port: localPort });
  const ws = new WebSocket(relayUrl(serverUrl, { role: 'host', cid, pid, token }), { perMessageDeflate: false });
  pipe(sock, ws);
  log(`relay: tunnel ${cid} -> 127.0.0.1:${localPort}`);
  return { close: () => { sock.destroy(); ws.terminate(); } };
}

/** Wait until something is listening on 127.0.0.1:port. */
function waitForPort(port, timeoutMs = 30000, isAlive = () => true) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (!isAlive()) return resolve(false);
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 700);
      });
    };
    tryOnce();
  });
}

module.exports = { startGuest, openHostTunnel, waitForPort, relayUrl };
