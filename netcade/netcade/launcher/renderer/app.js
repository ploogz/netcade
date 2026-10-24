/* global netcade, ControlsEditor */
(function () {
  'use strict';

  // ================================================================ helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SYS = { n64: 'N64', gc: 'GameCube' };

  const S = {
    settings: null, games: [], errors: [], emulators: { dolphin: {}, retroarch: {} }, server: { state: 'offline' },
    lobby: null, session: null, platform: 'win32', appVersion: '', lanIps: [], downloadPages: {},
    view: 'library', filter: 'all', search: '', chat: [], publicLobbies: [], scan: null, coreProgress: null,
    hostDraft: { key: '', public: false, maxPlayers: 4, password: '' },
  };
  const sig = {}; // render signatures per region, to avoid needless re-renders

  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, kind === 'error' ? 6500 : 4200);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4600);
  }

  /** Runs an action; on success returns its value (or true if it returned nothing), on failure toasts and returns undefined. */
  async function act(fn, okText) {
    try {
      const r = await fn();
      if (okText) toast(okText);
      return r === undefined ? true : r;
    } catch (err) {
      toast(err.message || String(err), 'error');
      return undefined;
    }
  }

  async function saveSettings(patch) {
    const s = await act(() => netcade.setSettings(patch));
    if (s) S.settings = s;
    return s;
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function coverStyle(g) {
    const h = hash(g.title || g.key || '?');
    const hue = h % 360;
    const base = g.system === 'gc' ? '252' : '36';
    return `--cover-bg: radial-gradient(120% 120% at 100% 0%, hsl(${hue} 70% 45% / .9) 0%, transparent 55%),
      linear-gradient(160deg, hsl(${base} 60% 22%) 0%, hsl(${(hue + 40) % 360} 45% 12%) 100%);`;
  }

  function monogram(title) {
    const words = String(title || '?').replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    const sig2 = words.filter((w) => !/^(the|of|a|and|in)$/i.test(w));
    const pick = (sig2.length ? sig2 : words).slice(0, 2).map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase()));
    return pick.join('');
  }

  function coverHtml(g, cls = '') {
    return `<div class="cover ${cls}" style="${coverStyle(g)}">
      <span class="badge ${g.system}">${SYS[g.system] || ''}</span>
      <span class="mono-mark">${esc(monogram(g.title))}</span>
      <span class="cover-title">${esc(g.title)}</span>
    </div>`;
  }

  function fmtSize(n) {
    if (!n) return '';
    if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
    if (n < 1e6) return Math.max(1, Math.round(n / 1e3)) + ' KB';
    return Math.round(n / 1e6) + ' MB';
  }

  function pingBars(ms) {
    if (ms == null) return '<span class="ping">—</span>';
    const q = ms < 60 ? 4 : ms < 110 ? 3 : ms < 180 ? 2 : 1;
    return `<span class="ping"><span class="bars q${q}"><i></i><i></i><i></i><i></i></span>${ms} ms</span>`;
  }

  const I = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
    host: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 15 6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m6 9 6 6 6-6"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    pad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8h12a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.6A3.5 3.5 0 0 1 2 13.5V12a4 4 0 0 1 4-4Z"/><path d="M7 11v3M5.5 12.5h3"/></svg>',
  };

  // ================================================================ navigation
  function show(view) {
    S.view = view;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    if (view === 'controls') pageEditor.mount(); else pageEditor.unmount();
    if (view === 'library') renderLibrary(true);
    if (view === 'online') { renderOnline(true); if (!S.lobby) refreshLobbies(); }
    if (view === 'settings') renderSettings();
    $('#main').scrollTop = 0;
  }

  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#statusPill').addEventListener('click', () => show('settings'));

  // ================================================================ sidebar
  function renderSidebar() {
    const st = S.server.state;
    $('#statusDot').className = `dot ${st}`;
    const url = S.server.url;
    $('#statusText').textContent = !url ? 'No server set'
      : st === 'online' ? `Online as ${S.settings?.name || ''}`
        : st === 'connecting' ? 'Connecting…' : st === 'reconnecting' ? 'Reconnecting…' : 'Offline';
    const badge = $('#navLobbyBadge');
    if (S.lobby) { badge.hidden = false; badge.textContent = `${S.lobby.members.length}/${S.lobby.maxPlayers}`; } else badge.hidden = true;
    const ms = $('#miniSession');
    if (S.session) {
      ms.innerHTML = `<div class="mini-session"><span class="live">${S.session.role === 'solo' ? 'Playing' : 'Online'}</span><strong>${esc(S.session.title || '')}</strong>${esc(S.session.phase === 'waiting' ? 'Waiting for host…' : SYS[S.session.system])}</div>`;
      ms.firstChild.onclick = () => show(S.session.role === 'solo' ? 'library' : 'online');
    } else ms.innerHTML = '';
  }

  // ================================================================ library
  function setupChecklist() {
    const hasGames = S.games.length > 0;
    const emusOk = S.emulators.dolphin?.ok || (S.emulators.retroarch?.ok && S.emulators.n64Core);
    const serverOk = !!S.server.url;
    if (hasGames && emusOk && serverOk && S.settings.onboarded) return '';
    if (hasGames && emusOk && serverOk) { saveSettings({ onboarded: true }); return ''; }
    const step = (n, done, title, text, btn) => `<div class="check ${done ? 'done' : ''}"><div class="num">${done ? '✓' : n}</div><div><strong>${title}</strong><span class="muted small">${text}</span>${done ? '' : `<div>${btn}</div>`}</div></div>`;
    return `<div class="checklist">
      ${step(1, hasGames, 'Add your games', 'Point Netcade at the folder where you keep your N64 and GameCube files.', '<button class="btn small primary" data-act="addFolder">Add folder</button>')}
      ${S.emulators.bundled
        ? step(2, emusOk, 'Emulators included', 'Dolphin and RetroArch come built in. Nothing else to install.', '<button class="btn small" data-goto="settings">Check emulator settings</button>')
        : step(2, emusOk, 'Set up emulators', 'Dolphin for GameCube, RetroArch for N64. Netcade finds them automatically.', '<button class="btn small" data-goto="settings">Open emulator settings</button>')}
      ${step(3, serverOk, 'Connect to a server', 'Use a hosted Netcade server, or run one from this PC.', '<button class="btn small" data-goto="settings">Set up online</button>')}
    </div>`;
  }

  function filteredGames() {
    const q = S.search.trim().toLowerCase();
    const fav = new Set(S.settings.favorites || []);
    const recent = (S.settings.recent || []).map((r) => r.key);
    let list = S.games.slice();
    if (S.filter === 'n64' || S.filter === 'gc') list = list.filter((g) => g.system === S.filter);
    if (S.filter === 'fav') list = list.filter((g) => fav.has(g.key));
    if (S.filter === 'recent') list = recent.map((k) => list.find((g) => g.key === k)).filter(Boolean);
    if (q) list = list.filter((g) => `${g.title} ${g.headerName} ${g.region} ${g.id} ${g.file}`.toLowerCase().includes(q));
    return list;
  }

  function renderLibrary(full) {
    const root = $('#view-library');
    if (full || !root.dataset.ready) {
      root.dataset.ready = '1';
      root.innerHTML = `
        <div class="view-head">
          <div><h1>Library</h1><div class="sub" id="libCount"></div></div>
          <div class="spacer"></div>
          <button class="btn" data-act="rescan">Rescan</button>
          <button class="btn primary" data-act="addFolder">Add game folder</button>
        </div>
        <div id="libChecklist"></div>
        <div class="lib-tools">
          <div class="search">${I.search}<input class="input" id="libSearch" placeholder="Search your games" value="${esc(S.search)}"></div>
          <div class="chips" id="libFilters">
            ${[['all', 'All'], ['n64', 'N64'], ['gc', 'GameCube'], ['fav', 'Favorites'], ['recent', 'Recently played']]
              .map(([v, l]) => `<button class="chip ${S.filter === v ? 'active' : ''}" data-filter="${v}">${l}</button>`).join('')}
          </div>
        </div>
        <div id="libScan"></div>
        <div id="libGrid"></div>`;
      $('#libSearch').addEventListener('input', (e) => { S.search = e.target.value; renderLibraryGrid(); });
    }
    $('#libChecklist').innerHTML = setupChecklist();
    renderLibraryGrid();
  }

  function renderLibraryGrid() {
    const n64 = S.games.filter((g) => g.system === 'n64').length;
    const gc = S.games.length - n64;
    const cnt = $('#libCount');
    if (cnt) cnt.textContent = S.games.length ? `${n64} N64 · ${gc} GameCube${S.errors.length ? ` · ${S.errors.length} unreadable` : ''}` : 'No games yet';
    const scan = $('#libScan');
    if (scan) {
      scan.innerHTML = S.scan && S.scan.total && S.scan.done < S.scan.total
        ? `<div class="stack" style="margin-bottom:16px"><div class="progress"><div style="width:${Math.round((S.scan.done / S.scan.total) * 100)}%"></div></div><span class="hint">Reading ${esc(S.scan.file)} (${S.scan.done}/${S.scan.total})</span></div>` : '';
    }
    const grid = $('#libGrid');
    if (!grid) return;
    if (!S.settings.romFolders.length) {
      grid.innerHTML = `<div class="empty"><h2>Bring your games</h2><p>Netcade reads <b>.z64 .n64 .v64</b> (N64) and <b>.iso .gcm .rvz .ciso</b> (GameCube) files from folders you choose.<br>Your files never leave your computer.</p><button class="btn primary big" data-act="addFolder">Add game folder</button></div>`;
      return;
    }
    const list = filteredGames();
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><h2>${S.games.length ? 'Nothing matches' : 'No games found yet'}</h2><p>${S.games.length ? 'Try a different search or filter.' : 'Check that your folder contains supported files, then rescan.'}</p></div>`;
      return;
    }
    const fav = new Set(S.settings.favorites || []);
    grid.innerHTML = `<div class="grid">${list.map((g) => `
      <div class="card" data-key="${esc(g.key)}">
        <button class="fav ${fav.has(g.key) ? 'on' : ''}" data-act="fav" title="Favorite">${I.star}</button>
        ${coverHtml(g)}
        <div class="card-body">
          <div class="card-meta">
            <span class="tag">${esc(g.region)}</span>
            ${g.rev ? `<span class="tag">Rev ${g.rev}</span>` : ''}
            ${g.disc ? `<span class="tag">Disc ${g.disc + 1}</span>` : ''}
            ${g.id ? `<span class="tag mono">${esc(g.id)}</span>` : ''}
            <span class="tag">${fmtSize(g.size)}</span>
          </div>
          <div class="card-actions">
            <button class="btn" data-act="play" title="Play by yourself">${I.play}Play</button>
            <button class="btn primary" data-act="host" title="Create an online lobby">${I.host}Host</button>
          </div>
        </div>
      </div>`).join('')}</div>`;
  }

  $('#view-library').addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) return show(goto.dataset.goto);
    const f = e.target.closest('[data-filter]');
    if (f) {
      S.filter = f.dataset.filter;
      document.querySelectorAll('#libFilters .chip').forEach((c) => c.classList.toggle('active', c === f));
      return renderLibraryGrid();
    }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const key = t.closest('[data-key]')?.dataset.key;
    switch (t.dataset.act) {
      case 'addFolder': await act(() => netcade.library.addFolder()); break;
      case 'rescan': await act(() => netcade.library.rescan(), 'Library rescanned.'); break;
      case 'fav': { const favs = await act(() => netcade.library.favorite(key)); if (favs) { S.settings.favorites = favs; renderLibraryGrid(); } break; }
      case 'play': await act(() => netcade.play(key)); break;
      case 'host': openHostModal(key); break;
      default:
    }
  });
  $('#view-library').addEventListener('contextmenu', (e) => {
    const key = e.target.closest('[data-key]')?.dataset.key;
    if (key) { e.preventDefault(); netcade.library.reveal(key); }
  });

  // ================================================================ host modal
  function openHostModal(key) {
    if (!S.server.url) { toast('Set up a server first (Settings → Online).', 'warn'); show('settings'); return; }
    if (S.server.state !== 'online') { toast('Not connected to the server yet.', 'warn'); return; }
    const g = S.games.find((x) => x.key === key);
    if (!g) return;
    const d = S.hostDraft;
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal">
      <h2>Host ${esc(g.title)}</h2>
      <div class="stack">
        <label class="toggle"><input type="checkbox" id="hmPublic" ${d.public ? 'checked' : ''}><span class="track"></span>List in public lobbies</label>
        <div class="form-grid">
          <label class="field">Players
            <select class="input" id="hmMax">${[2, 3, 4].map((n) => `<option ${n === d.maxPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select>
          </label>
          <label class="field">Password (optional)
            <input class="input" id="hmPass" value="${esc(d.password)}" maxlength="32" placeholder="Anyone with the code">
          </label>
        </div>
        <p class="hint">Friends join with the 6-letter lobby code or an invite link. They need their own copy of this exact game; Netcade checks it for them.</p>
        <div class="row" style="justify-content:flex-end">
          <button class="btn ghost" id="hmCancel">Cancel</button>
          <button class="btn primary" id="hmCreate">${I.host}Create lobby</button>
        </div>
      </div></div></div>`;
    const close = () => { root.innerHTML = ''; };
    $('#hmCancel').onclick = close;
    root.firstChild.addEventListener('click', (e) => { if (e.target === root.firstChild) close(); });
    $('#hmCreate').onclick = async () => {
      S.hostDraft = { key, public: $('#hmPublic').checked, maxPlayers: +$('#hmMax').value, password: $('#hmPass').value };
      const ok = await act(() => netcade.lobby.create({ key, public: S.hostDraft.public, maxPlayers: S.hostDraft.maxPlayers, password: S.hostDraft.password }));
      if (ok !== undefined) { close(); show('online'); }
    };
  }

  // ================================================================ online
  async function refreshLobbies() {
    if (S.server.state === 'online') await act(() => netcade.lobby.send({ type: 'list' }));
  }

  function renderOnline(full) {
    const root = $('#view-online');
    const mode = !S.server.url ? 'noserver' : S.lobby ? `lobby:${S.lobby.code}` : 'browse';
    if (full || root.dataset.mode !== mode) {
      root.dataset.mode = mode;
      for (const k of Object.keys(sig)) delete sig[k];
      if (mode === 'noserver') root.innerHTML = noServerHtml();
      else if (mode === 'browse') root.innerHTML = browseHtml();
      else root.innerHTML = lobbyHtml();
      if (mode.startsWith('lobby')) renderChat(true);
    }
    if (mode === 'browse') renderPublicList();
    if (mode.startsWith('lobby')) renderLobbyParts();
  }

  function noServerHtml() {
    return `<div class="view-head"><div><h1>Play online</h1><div class="sub">Lobbies, chat and matchmaking run on a small Netcade server.</div></div></div>
      <div class="empty"><h2>Connect to a server first</h2>
      <p>Paste the address of a Netcade server your group uses, or run one on this PC with one click.</p>
      <button class="btn primary big" data-goto="settings">Set up online play</button></div>`;
  }

  function browseHtml() {
    const games = S.games;
    const d = S.hostDraft;
    return `<div class="view-head"><div><h1>Play online</h1><div class="sub">Join a friend with their code, host your own lobby, or jump into a public one.</div></div></div>
      <div class="online-grid">
        <div class="stack">
          <div class="panel">
            <h2>Join with a code</h2>
            <input class="input code" id="joinCode" maxlength="6" placeholder="ABC123" autocomplete="off" spellcheck="false">
            <div class="row" style="margin-top:12px"><button class="btn primary" data-act="join" style="flex:1;justify-content:center">Join lobby</button></div>
            <p class="hint">Invite links (netcade://join/CODE) open this screen automatically.</p>
          </div>
          <div class="panel">
            <h2>Host a game</h2>
            ${games.length ? `
            <div class="stack">
              <label class="field">Game
                <select class="input" id="hostGame">${games.map((g) => `<option value="${esc(g.key)}" ${g.key === d.key ? 'selected' : ''}>${esc(g.title)} · ${SYS[g.system]} · ${esc(g.region)}${g.rev ? ` Rev ${g.rev}` : ''}</option>`).join('')}</select>
              </label>
              <div class="form-grid">
                <label class="field">Players
                  <select class="input" id="hostMax">${[2, 3, 4].map((n) => `<option ${n === d.maxPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select>
                </label>
                <label class="field">Password (optional)<input class="input" id="hostPass" maxlength="32" value="${esc(d.password)}"></label>
              </div>
              <label class="toggle"><input type="checkbox" id="hostPublic" ${d.public ? 'checked' : ''}><span class="track"></span>List in public lobbies</label>
              <button class="btn primary" data-act="create" style="justify-content:center">${I.host}Create lobby</button>
            </div>` : '<p class="muted">Add games to your library to host.</p><button class="btn" data-goto="library">Go to library</button>'}
          </div>
        </div>
        <div class="panel">
          <div class="row" style="margin-bottom:10px"><h2 style="margin:0">Public lobbies</h2><div class="spacer"></div><button class="btn small" data-act="refresh">Refresh</button></div>
          <div id="publicList"></div>
        </div>
      </div>`;
  }

  function renderPublicList() {
    const el = $('#publicList');
    if (!el) return;
    if (S.server.state !== 'online') { el.innerHTML = '<p class="muted">Connecting to the server…</p>'; return; }
    if (!S.publicLobbies.length) { el.innerHTML = '<div class="empty" style="padding:30px"><p>No public lobbies right now.<br>Host one and tick "List in public lobbies".</p></div>'; return; }
    const keys = new Set(S.games.map((g) => g.key));
    el.innerHTML = `<table class="lobby-list"><thead><tr><th>Game</th><th>Host</th><th>Players</th><th>Ping</th><th></th></tr></thead><tbody>
      ${S.publicLobbies.map((l) => `<tr>
        <td><div class="row" style="gap:8px"><span class="badge ${l.system}">${SYS[l.system]}</span><b>${esc(l.title)}</b>${l.hasPassword ? I.lock : ''}</div>
          <div class="hint">${esc(l.region)}${l.rev ? ` · Rev ${l.rev}` : ''} · ${keys.has(l.gameKey) ? '<span class="ok-text">In your library</span>' : '<span class="warn-text">Not in your library</span>'}</div></td>
        <td>${esc(l.hostName)}</td>
        <td class="mono">${l.players}/${l.maxPlayers}${l.state !== 'waiting' ? ' <span class="tag">playing</span>' : ''}</td>
        <td>${pingBars(l.hostPing)}</td>
        <td style="text-align:right"><button class="btn small ${keys.has(l.gameKey) ? 'primary' : ''}" data-act="joinPublic" data-code="${l.code}" data-pw="${l.hasPassword ? 1 : 0}" ${l.state !== 'waiting' || l.players >= l.maxPlayers ? 'disabled' : ''}>Join</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  function lobbyHtml() {
    return `<div id="lobbyHead"></div>
      <div id="lobbyBanners"></div>
      <div class="lobby-grid">
        <div class="stack">
          <div id="sessionCard"></div>
          <div class="panel">
            <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Players</h2><div class="spacer"></div>
              <button class="btn small" data-act="openControls">${I.pad}Controls</button></div>
            <div class="players" id="players"></div>
          </div>
          <div id="lobbyControls"></div>
        </div>
        <div class="panel chat">
          <div class="chat-head"><h2 style="margin:0">Chat</h2><span class="hint" id="chatCount"></span></div>
          <div class="chat-log" id="chatLog"></div>
          <div class="chat-input"><input class="input" id="chatInput" maxlength="300" placeholder="Say something…" autocomplete="off"><button class="btn" data-act="sendChat">Send</button></div>
        </div>
      </div>`;
  }

  function isHost() {
    return S.lobby && S.lobby.hostId === S.lobby.myId;
  }

  function renderLobbyParts() {
    const L = S.lobby;
    if (!L) return;
    const me = L.members.find((m) => m.id === L.myId);
    const host = isHost();

    // ----- header
    const headSig = JSON.stringify([L.code, L.game, L.system, L.state, host]);
    if (sig.head !== headSig) {
      sig.head = headSig;
      $('#lobbyHead').innerHTML = `<div class="lobby-head">
        ${coverHtml({ ...L.game, system: L.system })}
        <div>
          <div class="row" style="gap:8px;margin-bottom:6px"><span class="badge ${L.system}">${SYS[L.system]}</span>
            <span class="tag">${esc(L.game.region)}${L.game.rev ? ` · Rev ${L.game.rev}` : ''}</span>
            ${L.state !== 'waiting' ? '<span class="live">Match running</span>' : ''}</div>
          <div class="lobby-title">${esc(L.game.title)}</div>
          <div class="row" style="margin-top:12px">
            <button class="btn small" data-act="copyInvite">${I.copy}Copy invite link</button>
            <button class="btn small ghost danger" data-act="leave">Leave lobby</button>
          </div>
        </div>
        <div class="code-box"><div class="label">Lobby code</div><div class="code">${esc(L.code)}</div>
          <button class="btn small ghost" data-act="copyCode">${I.copy}Copy code</button></div>
      </div>`;
    }

    // ----- banners
    const banners = [];
    if (!host && L.myHas && L.myHas.status !== 'match') {
      banners.push(`<div class="banner ${L.myHas.status === 'missing' ? 'bad' : 'warn'}">${I.warn}<div><b>${L.myHas.status === 'missing' ? "You don't have this game." : 'Your copy is a different version.'}</b><br>${esc(L.myHas.detail)}<br><span class="small">Add the right file to one of your game folders and Netcade will notice automatically after a rescan.</span></div></div>`);
    }
    if (L.versionMismatch) {
      banners.push(`<div class="banner warn">${I.warn}<div><b>Players have different ${L.system === 'gc' ? 'Dolphin' : 'RetroArch'} versions.</b> Netplay needs everyone on the same version. Check the versions under each name.</div></div>`);
    }
    const emuMissing = L.system === 'gc' ? !S.emulators.dolphin?.ok : !(S.emulators.retroarch?.ok && S.emulators.n64Core);
    if (emuMissing) banners.push(`<div class="banner bad">${I.warn}<div><b>${L.system === 'gc' ? 'Dolphin' : 'RetroArch or its N64 core'} isn't set up on this PC.</b> <a href="#" data-goto="settings">Open emulator settings</a></div></div>`);
    const bSig = banners.join('');
    if (sig.banners !== bSig) { sig.banners = bSig; $('#lobbyBanners').innerHTML = bSig; }

    // ----- players
    const slots = [];
    L.members.forEach((m, idx) => {
      const has = m.has?.status || 'unknown';
      const verKey = L.system === 'gc' ? 'dolphin' : 'retroarch';
      const detail = m.isHost ? 'Hosting'
        : has === 'match' ? 'Has the game'
          : has === 'missing' ? 'Missing the game'
            : has === 'mismatch' ? 'Different version of the game' : 'Checking library…';
      const dcls = has === 'missing' ? 'bad' : has === 'mismatch' ? 'warn' : '';
      slots.push(`<div class="player ${m.id === L.myId ? 'me' : ''}">
        <div class="port">P<b>${idx + 1}</b></div>
        <div>
          <div class="name">${esc(m.name)}${m.id === L.myId ? ' <span class="tag">You</span>' : ''}</div>
          <div class="detail ${dcls}">${esc(detail)}${m.versions?.[verKey] ? ` · <span class="mono">${esc(L.system === 'gc' ? 'Dolphin' : 'RetroArch')} ${esc(m.versions[verKey])}</span>` : ''}</div>
        </div>
        ${pingBars(m.ping)}
        <div class="row" style="gap:4px">
          ${m.isHost ? '<span class="ready-pill host">Host</span>' : `<span class="ready-pill ${m.ready ? 'yes' : 'no'}">${m.ready ? 'Ready' : 'Not ready'}</span>`}
          ${host && L.state === 'waiting' ? `
            <button class="icon-btn" title="Move up" data-act="move" data-id="${m.id}" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>${I.up}</button>
            <button class="icon-btn" title="Move down" data-act="move" data-id="${m.id}" data-dir="1" ${idx === L.members.length - 1 ? 'disabled' : ''}>${I.down}</button>
            ${m.isHost ? '' : `<button class="icon-btn" title="Remove from lobby" data-act="kick" data-id="${m.id}">${I.x}</button>`}` : ''}
        </div>
      </div>`);
    });
    for (let i = L.members.length; i < L.maxPlayers; i++) {
      slots.push(`<div class="empty-slot"><div class="port">P<b>${i + 1}</b></div><span>Open slot</span><div class="spacer"></div><button class="btn small ghost" data-act="copyInvite">${I.copy}Invite</button></div>`);
    }
    const pSig = slots.join('');
    if (sig.players !== pSig) { sig.players = pSig; $('#players').innerHTML = pSig; }

    // ----- host / guest controls
    const guests = L.members.filter((m) => !m.isHost);
    const notReady = guests.filter((m) => !m.ready);
    const missing = guests.filter((m) => m.has?.status && m.has.status !== 'match');
    let ctl;
    if (L.state !== 'waiting') {
      ctl = `<div class="panel"><div class="row"><span class="live">Match running</span><div class="spacer"></div>
        ${host ? '<button class="btn danger" data-act="endGame">End match for everyone</button>' : ''}</div>
        <p class="hint">Closing your emulator ${host ? 'also ends the match for everyone.' : 'drops you out; the host can restart the match from the lobby.'}</p></div>`;
    } else if (host) {
      const startReason = missing.length ? `${missing.map((m) => m.name).join(', ')} can't play this game yet`
        : notReady.length ? `Waiting for ${notReady.map((m) => m.name).join(', ')} to ready up` : '';
      ctl = `<div class="panel">
        <h2>Match settings</h2>
        <div class="form-grid">
          <label class="field">Input delay
            <select class="input" data-opt="inputDelay">
              <option value="auto" ${L.inputDelay === 'auto' ? 'selected' : ''}>Auto (based on ping)</option>
              ${[0, 1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}" ${L.inputDelay === n ? 'selected' : ''}>${n} frame${n === 1 ? '' : 's'}</option>`).join('')}
            </select>
          </label>
          <label class="field">Players
            <select class="input" data-opt="maxPlayers">${[2, 3, 4].map((n) => `<option ${n === L.maxPlayers ? 'selected' : ''} ${n < L.members.length ? 'disabled' : ''}>${n}</option>`).join('')}</select>
          </label>
          <label class="field" style="grid-column: span 2">Game
            <select class="input" data-act-change="setGame">
              ${S.games.map((g) => `<option value="${esc(g.key)}" ${g.key === L.game.key ? 'selected' : ''}>${esc(g.title)} · ${SYS[g.system]} · ${esc(g.region)}${g.rev ? ` Rev ${g.rev}` : ''}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="row" style="margin-top:14px;gap:22px">
          <label class="toggle"><input type="checkbox" data-opt="public" ${L.public ? 'checked' : ''}><span class="track"></span>Public lobby</label>
          ${L.system === 'n64' ? `<label class="toggle" title="Route traffic through the server even if a direct connection would work"><input type="checkbox" data-opt="forceRelay" ${L.forceRelay ? 'checked' : ''}><span class="track"></span>Always use relay</label>` : ''}
        </div>
        <div class="hr"></div>
        <div class="row"><button class="btn primary big" data-act="start" ${startReason ? 'disabled' : ''}>${I.play}${L.members.length > 1 ? 'Start match' : 'Start (solo test)'}</button>
          <span class="hint">${esc(startReason || (L.members.length > 1 ? 'Everyone is ready.' : 'Invite friends with the code, or start alone to test your setup.'))}</span></div>
      </div>`;
    } else {
      const canReady = L.myHas?.status === 'match' && !emuMissing;
      ctl = `<div class="panel"><div class="row">
        <button class="btn big ${me?.ready ? '' : 'primary'}" data-act="ready" ${canReady ? '' : 'disabled'}>${me?.ready ? 'Not ready' : `${I.ok}Ready up`}</button>
        <span class="hint">${canReady ? (me?.ready ? 'Waiting for the host to start the match.' : 'Set your controls, then ready up.') : 'You need the exact game and a working emulator to ready up.'}</span>
      </div></div>`;
    }
    if (sig.ctl !== ctl) { sig.ctl = ctl; $('#lobbyControls').innerHTML = ctl; }

    renderSessionCard();
    const chatCount = $('#chatCount');
    if (chatCount) chatCount.textContent = `${L.members.length} in lobby`;
  }

  function renderSessionCard() {
    const el = $('#sessionCard');
    if (!el) return;
    const s = S.session;
    const L = S.lobby;
    let html = '';
    if (s && s.role !== 'solo') {
      const showManual = s.system === 'gc' && s.role === 'host' && L && !L.dolphin && s.phase === 'dolphin';
      const net = s.netMode ? `<span class="tag">${s.netMode === 'direct' ? 'Direct connection' : 'Via relay'}</span>` : '';
      html = `<div class="panel session-card">
        <div class="row"><span class="live">${s.phase === 'waiting' ? 'Starting' : 'Live'}</span> ${net}<div class="spacer"></div>
          ${s.phase !== 'waiting' ? '<button class="btn small danger" data-act="stopSession">Close emulator</button>' : ''}</div>
        <h2 style="margin:10px 0 0">${esc(s.text || '')}</h2>
        ${s.steps ? `<ol>${s.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
        ${s.system === 'gc' && s.role === 'guest' && s.hostCode ? `<div class="row" style="margin-top:12px"><span class="muted small">Host code</span><span class="mono" style="font-size:18px;color:var(--signal)">${esc(s.hostCode)}</span><button class="btn small" data-act="copyText" data-text="${esc(s.hostCode)}">${I.copy}Copy</button></div>` : ''}
        ${showManual ? `<div class="hr"></div><p class="hint">Guests not connecting after you clicked Host? Copy the host code from Dolphin's NetPlay window and paste it here.</p>
          <div class="row"><input class="input mono" id="manualCode" placeholder="e.g. 4f2a91bc" maxlength="40"><button class="btn small" data-act="manualCode">Send to guests</button></div>` : ''}
      </div>`;
    } else if (s && s.phase === 'error') {
      html = `<div class="banner bad">${I.warn}<div>${esc(s.text)}</div></div>`;
    }
    if (sig.session !== html) { sig.session = html; el.innerHTML = html; }
  }

  function renderChat(full) {
    const log = $('#chatLog');
    if (!log) return;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const line = (m) => {
      const t = new Date(m.t || Date.now());
      const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      if (m.system) return `<div class="msg system">${esc(m.text)}<span class="t">${time}</span></div>`;
      const color = `hsl(${hash(m.from || m.name) % 360} 80% 72%)`;
      return `<div class="msg"><span class="who" style="color:${color}">${esc(m.name)}</span>${esc(m.text)}<span class="t">${time}</span></div>`;
    };
    if (full) log.innerHTML = S.chat.map(line).join('');
    else if (S.chat.length) log.insertAdjacentHTML('beforeend', line(S.chat[S.chat.length - 1]));
    if (stick || full) log.scrollTop = log.scrollHeight;
  }

  async function sendChat() {
    const inp = $('#chatInput');
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    await act(() => netcade.lobby.send({ type: 'chat', text }));
  }

  function inviteText() {
    return `Join my Netcade lobby for ${S.lobby.game.title}: code ${S.lobby.code} (or open netcade://join/${S.lobby.code})`;
  }

  $('#view-online').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'chatInput') sendChat();
    if (e.key === 'Enter' && e.target.id === 'joinCode') $('[data-act="join"]').click();
  });

  $('#view-online').addEventListener('input', (e) => {
    if (e.target.id === 'joinCode') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('#view-online').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.opt) {
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.opt === 'maxPlayers') v = +v;
      if (t.dataset.opt === 'inputDelay') v = v === 'auto' ? 'auto' : +v;
      await act(() => netcade.lobby.send({ type: 'setOptions', [t.dataset.opt]: v }));
    }
    if (t.dataset.actChange === 'setGame') await act(() => netcade.lobby.setGame(t.value));
  });

  $('#view-online').addEventListener('click', async (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) { e.preventDefault(); return show(goto.dataset.goto); }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const L = S.lobby;
    switch (t.dataset.act) {
      case 'join': {
        const code = $('#joinCode').value.trim();
        if (code.length < 6) return toast('Lobby codes are 6 characters.', 'warn');
        await act(() => netcade.lobby.send({ type: 'join', code }));
        break;
      }
      case 'joinPublic':
        if (t.dataset.pw === '1') return askPassword(t.dataset.code);
        await act(() => netcade.lobby.send({ type: 'join', code: t.dataset.code }));
        break;
      case 'refresh': await refreshLobbies(); break;
      case 'create': {
        const key = $('#hostGame').value;
        S.hostDraft = { key, public: $('#hostPublic').checked, maxPlayers: +$('#hostMax').value, password: $('#hostPass').value };
        await act(() => netcade.lobby.create({ key, public: S.hostDraft.public, maxPlayers: S.hostDraft.maxPlayers, password: S.hostDraft.password }));
        break;
      }
      case 'leave': await act(() => netcade.lobby.send({ type: 'leave' })); break;
      case 'copyCode': await act(() => netcade.copy(L.code), 'Lobby code copied.'); break;
      case 'copyInvite': await act(() => netcade.copy(inviteText()), 'Invite copied. Paste it to your friends.'); break;
      case 'copyText': await act(() => netcade.copy(t.dataset.text), 'Copied.'); break;
      case 'sendChat': await sendChat(); break;
      case 'ready': {
        const me = L.members.find((m) => m.id === L.myId);
        await act(() => netcade.lobby.send({ type: 'ready', ready: !me?.ready }));
        break;
      }
      case 'start': await act(() => netcade.lobby.send({ type: 'start' })); break;
      case 'endGame': await act(() => netcade.lobby.send({ type: 'endGame' })); break;
      case 'kick': await act(() => netcade.lobby.send({ type: 'kick', id: t.dataset.id })); break;
      case 'move': {
        const order = L.members.map((m) => m.id);
        const i = order.indexOf(t.dataset.id);
        const j = i + +t.dataset.dir;
        if (j < 0 || j >= order.length) return;
        [order[i], order[j]] = [order[j], order[i]];
        await act(() => netcade.lobby.send({ type: 'reorder', order }));
        break;
      }
      case 'stopSession': await act(() => netcade.stopSession()); break;
      case 'manualCode': {
        const code = $('#manualCode').value.trim();
        if (code) await act(() => netcade.lobby.send({ type: 'dolphinManual', hostCode: code }), 'Sent to guests.');
        break;
      }
      case 'openControls': openDrawer(); break;
      default:
    }
  });

  function askPassword(code) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal"><h2>Lobby password</h2>
      <input class="input" id="pwInput" type="password" style="width:100%" placeholder="Password">
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn ghost" id="pwCancel">Cancel</button><button class="btn primary" id="pwOk">Join</button></div></div></div>`;
    const close = () => { root.innerHTML = ''; };
    $('#pwInput').focus();
    $('#pwCancel').onclick = close;
    const go = async () => { const pw = $('#pwInput').value; close(); await act(() => netcade.lobby.send({ type: 'join', code, password: pw })); };
    $('#pwOk').onclick = go;
    $('#pwInput').onkeydown = (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') close(); };
  }

  // ================================================================ controls (page + lobby drawer)
  const editorOpts = (extra) => ({
    getSettings: () => S.settings,
    save: async (patch) => { await saveSettings(patch); },
    toast,
    platform: S.platform,
    ...extra,
  });
  const pageEditor = new ControlsEditor($('#view-controls'), editorOpts({}));
  let drawerEditor = null;

  function openDrawer() {
    const sys = S.lobby ? S.lobby.system : 'n64';
    const drawer = $('#drawer');
    drawer.innerHTML = '<div style="display:flex;justify-content:flex-end"><button class="btn ghost" id="drawerClose">Done</button></div><div id="drawerBody"></div>';
    drawerEditor = new ControlsEditor($('#drawerBody'), editorOpts({ system: sys, lockSystem: true, platform: S.platform }));
    drawerEditor.mount(sys);
    drawer.classList.add('open');
    $('#drawerBack').classList.add('open');
    $('#drawerClose').onclick = closeDrawer;
  }

  function closeDrawer() {
    if (drawerEditor) drawerEditor.unmount();
    drawerEditor = null;
    $('#drawer').classList.remove('open');
    $('#drawerBack').classList.remove('open');
  }
  $('#drawerBack').addEventListener('click', closeDrawer);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerEditor && !drawerEditor.listening) closeDrawer();
  });

  // ================================================================ settings
  function renderSettings() {
    const s = S.settings;
    const g = s.graphics;
    const root = $('#view-settings');
    const embedded = s.embeddedServer?.enabled;
    root.innerHTML = `
      <div class="view-head"><div><h1>Settings</h1><div class="sub">Netcade ${esc(S.appVersion)}</div></div></div>
      <div class="settings-grid">
        <div class="panel">
          <h2>Profile & online</h2>
          <div class="stack">
            <label class="field">Your name in lobbies<input class="input" data-set="name" maxlength="24" value="${esc(s.name)}"></label>
            <div class="seg" style="align-self:flex-start">
              <button data-act="serverMode" data-v="remote" class="${embedded ? '' : 'active'}">Use a server</button>
              <button data-act="serverMode" data-v="local" class="${embedded ? 'active' : ''}">Run server on this PC</button>
            </div>
            ${embedded ? `
              <label class="field">Port<input class="input" data-set="embeddedServer.port" type="number" min="1024" max="65535" value="${s.embeddedServer.port || 8080}"></label>
              <div class="banner ok">${I.ok}<div>Server running on this PC. Friends on your network use <span class="mono selectable">${S.lanIps.map((ip) => `http://${esc(ip)}:${s.embeddedServer.port || 8080}`).join(', ') || 'your LAN address'}</span>.<br>
              For friends over the internet, forward TCP port ${s.embeddedServer.port || 8080} on your router and share <span class="mono">http://&lt;your public IP&gt;:${s.embeddedServer.port || 8080}</span>, or deploy the server to the cloud (see README).</div></div>` : `
              <label class="field">Server address
                <div class="row"><input class="input" style="flex:1" data-set="serverUrl" placeholder="https://your-netcade-server.fly.dev" value="${esc(s.serverUrl)}">
                <button class="btn" data-act="testServer">Test</button></div>
              </label>
              <span class="hint" id="serverTest">${S.server.state === 'online' ? '<span class="ok-text">Connected.</span>' : S.server.url ? 'Not connected.' : 'Deploy the included server (README → "Run your own server") and paste its address here.'}</span>`}
          </div>
        </div>

        <div class="panel">
          <h2>Game folders</h2>
          <div class="stack" id="setFolders">${foldersHtml()}</div>
          <div class="row" style="margin-top:12px"><button class="btn primary" data-act="addFolder">Add folder</button><button class="btn" data-act="rescan">Rescan</button></div>
          ${S.errors.length ? `<details style="margin-top:12px"><summary class="hint">${S.errors.length} file(s) couldn't be read</summary><div class="stack small" style="margin-top:8px">${S.errors.slice(0, 30).map((e) => `<div><span class="path">${esc(e.file)}</span><br><span class="bad-text">${esc(e.error)}</span></div>`).join('')}</div></details>` : ''}
        </div>

        <div class="panel" id="setEmus">${emusHtml()}</div>

        <div class="panel">
          <h2>Graphics</h2>
          <div class="stack">
            <label class="field">Preset
              <select class="input" data-act-change="preset">
                ${[['performance', 'Performance (older PCs)'], ['balanced', 'Balanced'], ['quality', 'Quality (strong GPU)'], ['custom', 'Custom']]
                  .map(([v, l]) => `<option value="${v}" ${g.preset === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </label>
            <div class="form-grid">
              <label class="field">N64 renderer
                <select class="input" data-set="graphics.n64Renderer">
                  <option value="parallel" ${g.n64Renderer === 'parallel' ? 'selected' : ''}>ParaLLEl-RDP (Vulkan, accurate)</option>
                  <option value="gliden64" ${g.n64Renderer === 'gliden64' ? 'selected' : ''}>GLideN64 (OpenGL, fast, widescreen)</option>
                </select>
              </label>
              <label class="field">N64 resolution
                <select class="input" data-set="graphics.n64Scale" data-num="1">${[1, 2, 4, 8].map((n) => `<option value="${n}" ${g.n64Scale === n ? 'selected' : ''}>${n}× native</option>`).join('')}</select>
              </label>
              <label class="field">GameCube backend
                <select class="input" data-set="graphics.gcBackend">
                  ${[['auto', 'Automatic'], ['vulkan', 'Vulkan'], ...(S.platform === 'win32' ? [['d3d12', 'Direct3D 12']] : []), ...(S.platform === 'darwin' ? [['metal', 'Metal']] : []), ['opengl', 'OpenGL']]
                    .map(([v, l]) => `<option value="${v}" ${g.gcBackend === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
              </label>
              <label class="field">GameCube resolution
                <select class="input" data-set="graphics.gcScale" data-num="1">${[1, 2, 3, 4, 6].map((n) => `<option value="${n}" ${g.gcScale === n ? 'selected' : ''}>${n}× native${n === 3 ? ' (1080p)' : n === 6 ? ' (4K)' : ''}</option>`).join('')}</select>
              </label>
            </div>
            <div class="row" style="gap:22px">
              <label class="toggle"><input type="checkbox" data-set="graphics.fullscreen" ${g.fullscreen ? 'checked' : ''}><span class="track"></span>Fullscreen</label>
              <label class="toggle"><input type="checkbox" data-set="graphics.vsync" ${g.vsync !== false ? 'checked' : ''}><span class="track"></span>V-Sync</label>
              <label class="toggle"><input type="checkbox" data-set="graphics.widescreen" ${g.widescreen ? 'checked' : ''}><span class="track"></span>Widescreen hack</label>
              <label class="toggle"><input type="checkbox" data-set="graphics.showFps" ${g.showFps ? 'checked' : ''}><span class="track"></span>Show FPS</label>
            </div>
            <span class="hint">In online N64 matches everyone uses the host's renderer so the games stay in sync. Widescreen on N64 needs GLideN64.</span>
          </div>
        </div>

        <div class="panel">
          <h2>Netplay</h2>
          <div class="stack">
            <label class="toggle"><input type="checkbox" data-set="netplay.forceRelay" ${s.netplay.forceRelay ? 'checked' : ''}><span class="track"></span>Always use the relay for N64 lobbies I host</label>
            <label class="toggle"><input type="checkbox" data-set="netplay.dolphinDirect" ${s.netplay.dolphinDirect ? 'checked' : ''}><span class="track"></span>GameCube: host by direct IP instead of Dolphin's traversal server</label>
            <label class="toggle"><input type="checkbox" data-set="netplay.notify" ${s.netplay.notify ? 'checked' : ''}><span class="track"></span>Desktop notifications (joins, chat, match start)</label>
            <div class="form-grid">
              <label class="field">N64 netplay port<input class="input" type="number" data-set="netplay.retroarchPort" data-num="1" value="${s.netplay.retroarchPort}"></label>
              <label class="field">GameCube host port<input class="input" type="number" data-set="netplay.dolphinPort" data-num="1" value="${s.netplay.dolphinPort}"></label>
            </div>
            <span class="hint">Netcade tries UPnP to open ports automatically. If direct connections fail, N64 falls back to the relay; GameCube uses Dolphin's traversal server.</span>
          </div>
        </div>

        <div class="panel">
          <h2>Troubleshooting</h2>
          <div class="row">
            <button class="btn" data-act="openPath" data-v="logs">Open logs</button>
            <button class="btn" data-act="openPath" data-v="dolphin">Open Netcade's Dolphin folder</button>
            <button class="btn" data-act="openPath" data-v="retroarch">Open N64 saves folder</button>
          </div>
          <p class="hint" style="margin-top:12px">Netcade uses its own Dolphin user folder, so your normal Dolphin settings and saves are untouched. Netcade never uploads or shares game files: every player uses their own copy.</p>
        </div>
      </div>`;
  }

  function foldersHtml() {
    const s = S.settings;
    if (!s.romFolders.length) return '<p class="muted">No folders yet.</p>';
    return s.romFolders.map((f) => `<div class="folder"><span class="path">${esc(f)}</span><button class="icon-btn" title="Remove" data-act="removeFolder" data-folder="${esc(f)}">${I.x}</button></div>`).join('');
  }

  function emusHtml() {
    const e = S.emulators;
    const cp = S.coreProgress;
    if (e.bundled) {
      const row = (cls, short, name, info, extra = '') => `<div class="emu">
        <div class="emu-icon ${cls}">${short}</div>
        <div>
          <div class="row" style="gap:8px"><b>${name}</b>${info.ok ? `<span class="ok-text small">● Built in${info.version ? ` · ${esc(info.version)}` : ''}</span>` : '<span class="bad-text small">● Missing from this install</span>'}</div>
          ${extra}
        </div></div>`;
      return `<div class="row" style="margin-bottom:12px"><h2 style="margin:0">Emulators</h2></div>
        ${row('gc', 'GC', 'Dolphin', e.dolphin || {})}
        ${row('n64', '64', 'RetroArch', e.retroarch || {}, e.n64CoreVersion ? `<div class="hint">N64 core: ${esc(e.n64CoreVersion)}</div>` : '')}
        <p class="hint">Netcade ships its own copies of both emulators, so everyone on the same Netcade version matches automatically and nothing else needs installing. They keep their own settings and saves, separate from any emulators you installed yourself.</p>
        <button class="btn small ghost" data-act="emuSource" data-v="custom">Use my own Dolphin / RetroArch instead…</button>`;
    }
    const card = (cls, short, name, info, kind, extra = '') => `<div class="emu">
      <div class="emu-icon ${cls}">${short}</div>
      <div>
        <div class="row" style="gap:8px"><b>${name}</b>${info.ok ? `<span class="ok-text small">● Found${info.version ? ` · ${esc(info.version)}` : ''}</span>` : '<span class="bad-text small">● Not found</span>'}</div>
        <div class="path">${esc(info.path || 'Not set')}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn small" data-act="browse" data-kind="${kind}">Browse…</button>
          ${info.ok ? '' : `<button class="btn small primary" data-act="download" data-kind="${kind}">Download</button>`}
        </div>
        ${extra}
      </div></div>`;
    const core = `<div style="margin-top:10px" class="row">
      <span class="small ${e.n64Core ? 'ok-text' : 'warn-text'}">${e.n64Core ? '● N64 core installed' : '● N64 core (Mupen64Plus-Next) missing'}</span>
      ${e.n64Core ? `<button class="btn small ghost" data-act="installCore">Update core</button>` : `<button class="btn small primary" data-act="installCore" ${cp ? 'disabled' : ''}>${cp ? `Downloading… ${cp.total ? Math.round((cp.got / cp.total) * 100) + '%' : ''}` : 'Install N64 core'}</button>`}
      <button class="btn small ghost" data-act="browse" data-kind="core">Choose file…</button></div>`;
    const back = e.bundleAvailable ? `<div class="banner ok" style="margin-bottom:12px">${I.ok}<div>You're using your own emulator installs. <a href="#" data-act="emuSource" data-v="bundled">Switch back to the built-in emulators</a> (recommended for online play).</div></div>` : '';
    return `${back}<div class="row" style="margin-bottom:12px"><h2 style="margin:0">Emulators</h2><div class="spacer"></div><button class="btn small" data-act="detect">Auto-detect</button></div>
      ${card('gc', 'GC', 'Dolphin', e.dolphin || {}, 'dolphin')}
      ${card('n64', '64', 'RetroArch', e.retroarch || {}, 'retroarch', core)}
      <p class="hint">Everyone in a lobby needs the same emulator version. Using the latest stable release of each keeps that easy.</p>`;
  }

  const PRESETS = {
    performance: { n64Renderer: 'gliden64', n64Scale: 1, gcScale: 1 },
    balanced: { n64Renderer: 'parallel', n64Scale: 2, gcScale: 2 },
    quality: { n64Renderer: 'parallel', n64Scale: 4, gcScale: 4 },
  };

  function setPath(obj, dotted, value) {
    const parts = dotted.split('.');
    const patch = {};
    let cur = patch;
    parts.forEach((p, i) => { cur[p] = i === parts.length - 1 ? value : {}; cur = cur[p]; });
    return patch;
  }

  $('#view-settings').addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.set) {
      let v = t.type === 'checkbox' ? t.checked : t.value;
      if (t.dataset.num || t.type === 'number') v = +v;
      if (t.dataset.set === 'serverUrl') v = v.trim();
      const patch = setPath({}, t.dataset.set, v);
      if (t.dataset.set.startsWith('graphics.') && !['graphics.fullscreen', 'graphics.vsync', 'graphics.showFps'].includes(t.dataset.set)) patch.graphics.preset = 'custom';
      await saveSettings(patch);
      if (t.dataset.set === 'graphics.n64Renderer' || patch.graphics?.preset) renderSettings();
    }
    if (t.dataset.actChange === 'preset') {
      const p = PRESETS[t.value];
      await saveSettings({ graphics: { preset: t.value, ...(p || {}) } });
      renderSettings();
    }
  });

  $('#view-settings').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    switch (t.dataset.act) {
      case 'serverMode': await saveSettings({ embeddedServer: { enabled: t.dataset.v === 'local' } }); renderSettings(); break;
      case 'testServer': {
        const url = $('[data-set="serverUrl"]').value.trim();
        $('#serverTest').textContent = 'Testing…';
        const r = await act(() => netcade.server.test(url));
        $('#serverTest').innerHTML = r?.ok ? `<span class="ok-text">Works! ${r.info.players} player(s) online.</span>` : `<span class="bad-text">${esc(r?.error || 'Failed')}</span>`;
        if (r?.ok && url !== S.settings.serverUrl) await saveSettings({ serverUrl: url });
        break;
      }
      case 'addFolder': await act(() => netcade.library.addFolder()); renderSettings(); break;
      case 'removeFolder': await act(() => netcade.library.removeFolder(t.dataset.folder)); renderSettings(); break;
      case 'rescan': await act(() => netcade.library.rescan(), 'Library rescanned.'); renderSettings(); break;
      case 'browse': { const r = await act(() => netcade.emu.browse(t.dataset.kind)); if (r) { S.emulators = r; $('#setEmus').innerHTML = emusHtml(); } break; }
      case 'emuSource': {
        e.preventDefault();
        if (t.dataset.v === 'custom' && !confirm('Use your own Dolphin and RetroArch installs?\n\nOnline matches only work when everyone uses the same emulator versions, which the built-in copies guarantee.')) break;
        await saveSettings({ emulatorSource: t.dataset.v });
        const st = await netcade.getState();
        S.emulators = st.emulators;
        $('#setEmus').innerHTML = emusHtml();
        break;
      }
      case 'detect': { const r = await act(() => netcade.emu.detect()); if (r) { S.emulators = r; $('#setEmus').innerHTML = emusHtml(); toast(r.dolphin.ok || r.retroarch.ok ? 'Detection finished.' : 'No emulators found. Install them, or use Browse.'); } break; }
      case 'download': await netcade.openExternal(S.downloadPages[t.dataset.kind]); break;
      case 'installCore': {
        S.coreProgress = { got: 0, total: 0 };
        $('#setEmus').innerHTML = emusHtml();
        const r = await act(() => netcade.emu.installCore(), 'N64 core installed.');
        S.coreProgress = null;
        if (r) S.emulators = r;
        $('#setEmus').innerHTML = emusHtml();
        break;
      }
      case 'openPath': await netcade.openPath(t.dataset.v); break;
      default:
    }
  });

  // ================================================================ events from main
  netcade.on('server-status', (st) => {
    S.server = { ...S.server, ...st };
    renderSidebar();
    if (S.view === 'online') renderOnline();
    if (S.view === 'settings' && $('#serverTest')) $('#serverTest').innerHTML = st.state === 'online' ? '<span class="ok-text">Connected.</span>' : esc(st.error || st.state);
  });
  netcade.on('lobby', (l) => {
    const was = S.lobby;
    S.lobby = l;
    if (!l && was) closeDrawer();
    renderSidebar();
    if (S.view === 'online') renderOnline();
  });
  netcade.on('lobby-msg', (m) => {
    if (m.type === 'lobbies') { S.publicLobbies = m.list; if (S.view === 'online') renderPublicList(); }
    if (m.type === 'joined') { S.chat = m.chat || []; show('online'); renderChat(true); }
    if (m.type === 'chat') { S.chat.push(m); if (S.chat.length > 200) S.chat.shift(); renderChat(false); }
    if (m.type === 'error') {
      if (m.needPassword) askPassword(m.code);
      else toast(m.message, 'error');
    }
    if (m.type === 'left') { S.chat = []; refreshLobbies(); }
  });
  netcade.on('session', (s) => {
    S.session = s;
    renderSidebar();
    if (S.view === 'online') renderSessionCard();
  });
  netcade.on('library', (lib) => {
    S.games = lib.games;
    S.errors = lib.errors || [];
    S.scan = null;
    if (S.view === 'library') renderLibrary();
    if (S.view === 'online' && !S.lobby) renderOnline(true);
  });
  netcade.on('library-progress', (p) => {
    S.scan = p;
    if (S.view === 'library') renderLibraryGrid();
  });
  netcade.on('settings', (s) => {
    S.settings = s;
    renderSidebar();
  });
  netcade.on('emulators', (e) => {
    S.emulators = e;
    if (S.view === 'settings' && $('#setEmus')) $('#setEmus').innerHTML = emusHtml();
    if (S.view === 'library') $('#libChecklist').innerHTML = setupChecklist();
  });
  netcade.on('core-progress', (p) => {
    S.coreProgress = p;
    if (S.view === 'settings' && $('#setEmus')) $('#setEmus').innerHTML = emusHtml();
  });
  netcade.on('toast', (t) => toast(t.text, t.kind));
  netcade.on('navigate', (v) => show(v));

  // ================================================================ boot
  (async () => {
    const st = await netcade.getState();
    Object.assign(S, st);
    S.server = st.server;
    pageEditor.opts.platform = S.platform;
    renderSidebar();
    show('library');
    setInterval(() => { if (S.view === 'online' && !S.lobby) refreshLobbies(); }, 15000);
  })();
})();
