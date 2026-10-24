'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rom = require('../lib/romInfo');
const IM = require('../lib/inputMaps');
const ini = require('../lib/ini');
const dolphin = require('../lib/dolphin');
const retroarch = require('../lib/retroarch');
const { Library } = require('../lib/library');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-test-'));

// ---------------------------------------------------------------- fixtures
function makeZ64(name, code = 'NSME', rev = 0, size = 1024 * 1024) {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(0x80371240, 0);
  b.writeUInt32BE(0x12345678, 0x10);
  b.writeUInt32BE(0x9abcdef0, 0x14);
  Buffer.from(name.padEnd(20, ' ')).copy(b, 0x20);
  Buffer.from(code).copy(b, 0x3b);
  b[0x3f] = rev;
  for (let i = 0x1000; i < size; i += 4) b.writeUInt32BE((i * 2654435761) >>> 0, i);
  return b;
}
function toV64(b) { return rom.toZ64(Buffer.from(b), 'v64'); }   // swap is its own inverse
function toN64(b) { return rom.toZ64(Buffer.from(b), 'n64'); }

function makeGcIso(id = 'GALE01', rev = 2, name = 'Super Smash Bros Melee') {
  const b = Buffer.alloc(0x10000);
  Buffer.from(id).copy(b, 0);
  b[6] = 0; b[7] = rev;
  b.writeUInt32BE(0xc2339f3d, 0x1c);
  Buffer.from(name).copy(b, 0x20);
  return b;
}
function makeRvz(iso) {
  const b = Buffer.alloc(0x400);
  Buffer.from('RVZ\x01', 'latin1').copy(b, 0);
  iso.subarray(0, 0x80).copy(b, 0x58);
  return b;
}
function makeCiso(iso) {
  const b = Buffer.alloc(0x8000 + 0x1000);
  Buffer.from('CISO').copy(b, 0);
  iso.subarray(0, 0x440).copy(b, 0x8000);
  return b;
}

// ---------------------------------------------------------------- romInfo
test('N64 dumps in all three byte orders hash identically', async () => {
  const z = makeZ64('SUPER MARIO 64');
  const dir = path.join(tmp, 'n64');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Super Mario 64 (USA).z64'), z);
  fs.writeFileSync(path.join(dir, 'sm64.v64'), toV64(z));
  fs.writeFileSync(path.join(dir, 'sm64.n64'), toN64(z));
  const a = await rom.readRomInfo(path.join(dir, 'Super Mario 64 (USA).z64'));
  const b = await rom.readRomInfo(path.join(dir, 'sm64.v64'));
  const c = await rom.readRomInfo(path.join(dir, 'sm64.n64'));
  assert.equal(a.format, 'z64');
  assert.equal(b.format, 'v64');
  assert.equal(c.format, 'n64');
  assert.equal(a.key, b.key);
  assert.equal(a.key, c.key);
  assert.equal(a.title, 'Super Mario 64');
  assert.equal(a.region, 'USA');
  assert.equal(a.id, 'NSME');
  assert.equal(b.title, 'Super Mario 64', 'short filename falls back to the header name');
});

test('GameCube header read from ISO, RVZ and CISO', async () => {
  const iso = makeGcIso();
  const dir = path.join(tmp, 'gc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Melee (USA) (Rev 2).iso'), iso);
  fs.writeFileSync(path.join(dir, 'Melee (USA) (Rev 2).rvz'), makeRvz(iso));
  fs.writeFileSync(path.join(dir, 'melee.ciso'), makeCiso(iso));
  const a = await rom.readRomInfo(path.join(dir, 'Melee (USA) (Rev 2).iso'));
  const b = await rom.readRomInfo(path.join(dir, 'Melee (USA) (Rev 2).rvz'));
  const c = await rom.readRomInfo(path.join(dir, 'melee.ciso'));
  for (const g of [a, b, c]) {
    assert.equal(g.key, 'gc:GALE01:2:0');
    assert.equal(g.region, 'USA');
    assert.equal(g.rev, 2);
  }
  assert.equal(a.title, 'Super Smash Bros Melee', 'terse filename -> disc header name');
  assert.equal(b.format, 'rvz');
  assert.equal(c.format, 'ciso');
});

test('Wii discs and junk are rejected', async () => {
  const wii = makeGcIso('RMCE01');
  wii.writeUInt32BE(0, 0x1c);
  wii.writeUInt32BE(0x5d1c9ea3, 0x18);
  const f = path.join(tmp, 'wii.iso');
  fs.writeFileSync(f, wii);
  await assert.rejects(rom.readRomInfo(f), /Wii/);
  const junk = path.join(tmp, 'junk.z64');
  fs.writeFileSync(junk, Buffer.alloc(4096));
  await assert.rejects(rom.readRomInfo(junk), /bad header/);
});

test('matchGame explains exact, version and missing cases', () => {
  const lib = [
    { system: 'gc', key: 'gc:GALE01:0:0', id: 'GALE01', title: 'Melee', region: 'USA', rev: 0 },
    { system: 'n64', key: 'n64:aaa', id: 'NSME', title: 'Super Mario 64', region: 'USA', rev: 0 },
  ];
  assert.equal(rom.matchGame({ key: 'n64:aaa', title: 'x' }, lib, 'n64').status, 'match');
  const v = rom.matchGame({ key: 'gc:GALE01:2:0', id: 'GALE01', title: 'Melee', region: 'USA', rev: 2 }, lib, 'gc');
  assert.equal(v.status, 'mismatch');
  assert.match(v.detail, /Rev 0 vs Rev 2/);
  const r = rom.matchGame({ key: 'n64:bbb', id: 'NSMJ', title: 'Super Mario 64', region: 'Japan', rev: 0 }, lib, 'n64');
  assert.equal(r.status, 'mismatch');
  assert.match(r.detail, /region USA vs Japan/);
  assert.equal(rom.matchGame({ key: 'n64:zzz', id: 'NZLE', title: 'Zelda', region: 'USA' }, lib, 'n64').status, 'missing');
});

test('library scan finds games recursively and caches results', async () => {
  const cache = path.join(tmp, 'cache.json');
  const lib = new Library(cache);
  const res = await lib.scan([tmp]);
  const keys = new Set(res.games.map((g) => g.key));
  assert.ok(keys.has('gc:GALE01:2:0'));
  assert.ok([...keys].some((k) => k.startsWith('n64:')));
  assert.ok(res.errors.length >= 2, 'wii + junk reported');
  const again = new Library(cache);
  assert.equal(again.games.length, res.games.length);
});

// ---------------------------------------------------------------- input maps
test('default bindings have no conflicts and pass validation', () => {
  for (const sys of ['n64', 'gc']) {
    for (const mode of ['keyboard', 'gamepad']) {
      const map = IM.resolve(sys, mode, {});
      assert.deepEqual(IM.conflicts(sys, map), [], `${sys}/${mode} conflicts`);
      for (const [id, bd] of Object.entries(map)) assert.equal(IM.validate(sys, mode, id, bd), null, `${sys}/${mode}/${id}`);
    }
  }
});

test('N64 rules: stick stays on left stick, only C buttons on right stick', () => {
  assert.match(IM.validate('n64', 'gamepad', 'su', { t: 'btn', i: 12 }), /left stick/);
  assert.match(IM.validate('n64', 'gamepad', 'a', { t: 'axis', i: 0, d: 1 }), /reserved/);
  assert.match(IM.validate('n64', 'gamepad', 'z', { t: 'axis', i: 2, d: 1 }), /C buttons/);
  assert.equal(IM.validate('n64', 'gamepad', 'cu', { t: 'btn', i: 3 }), null);
  assert.match(IM.validate('gc', 'keyboard', 'a', { t: 'btn', i: 0 }), /press a key/);
});

test('RetroArch keyboard config uses alt-map RetroPad slots and RetroArch key names', () => {
  const map = IM.resolve('n64', 'keyboard', { a: { t: 'key', code: 'Digit1' }, start: { t: 'key', code: 'NumpadEnter' } });
  const cfg = IM.retroarchKeyboardConfig(map);
  assert.equal(cfg.input_player1_b, 'num1');          // N64 A -> RetroPad B
  assert.equal(cfg.input_player1_y, 'j');             // N64 B -> RetroPad Y
  assert.equal(cfg.input_player1_l2, 'space');        // Z
  assert.equal(cfg.input_player1_select, 'q');        // N64 L -> Select under alt-map
  assert.equal(cfg.input_player1_r2, 'e');            // N64 R
  assert.equal(cfg.input_player1_x, 'up');            // C-Up
  assert.equal(cfg.input_player1_start, 'kp_enter');
  assert.equal(cfg.input_player1_l_y_minus, 'w');
  assert.equal(cfg.input_player1_l3, 'nul');
});

test('RetroArch remap routes physical buttons to N64 functions', () => {
  const map = IM.resolve('n64', 'gamepad', { cu: { t: 'btn', i: 3 }, a: { t: 'btn', i: 1 } });
  const { text, warnings } = IM.retroarchRemap(map);
  const get = (n) => +new RegExp(`input_player1_btn_${n} = "(-?\\d+)"`).exec(text)[1];
  assert.equal(warnings.length, 0);
  assert.equal(get('a'), 0);     // physical right face (std 1 -> RetroPad A) now gives N64 A (RetroPad B)
  assert.equal(get('x'), 9);     // physical top face -> C-Up (RetroPad X)
  assert.equal(get('y'), 1);     // physical left face -> N64 B (RetroPad Y), default
  assert.equal(get('b'), -1);    // physical bottom face no longer bound to anything
  assert.equal(get('l2'), 12);   // LT -> Z
  assert.match(text, /input_player1_stk_r_x\+ = "20"/);
});

test('Dolphin GCPad section for XInput, SDL and keyboard on each OS', () => {
  const pad = IM.resolve('gc', 'gamepad', {});
  const x = ini.linesToObject(IM.dolphinGCPad(pad, { kind: 'xinput', index: 0 }, 'win32'));
  assert.equal(x.Device, 'XInput/0/Gamepad');
  assert.equal(x['Buttons/A'], '`Button A`');
  assert.equal(x['Buttons/B'], '`Button X`');      // GC B on the left face button
  assert.equal(x['Main Stick/Up'], '`Left Y+`');   // Dolphin Y+ is up
  assert.equal(x['Main Stick/Down'], '`Left Y-`');
  assert.equal(x['C-Stick/Right'], '`Right X+`');
  assert.equal(x['Triggers/L-Analog'], '`Trigger L`');
  assert.equal(x['Rumble/Motor'], '`Motor L` | `Motor R`');
  const s = ini.linesToObject(IM.dolphinGCPad(pad, { kind: 'sdl', index: 1, name: 'PS5 Controller' }, 'linux'));
  assert.equal(s.Device, 'SDL/1/PS5 Controller');
  const kb = IM.resolve('gc', 'keyboard', { a: { t: 'key', code: 'Enter' } });
  const w = ini.linesToObject(IM.dolphinGCPad(kb, { kind: 'keyboard' }, 'win32'));
  assert.equal(w.Device, 'DInput/0/Keyboard Mouse');
  assert.equal(w['Buttons/A'], '`RETURN`');
  assert.equal(w['Main Stick/Modifier'], '`LSHIFT`');
  const m = ini.linesToObject(IM.dolphinGCPad(kb, { kind: 'keyboard' }, 'darwin'));
  assert.equal(m.Device, 'Quartz/0/Keyboard & Mouse');
  assert.equal(m['Buttons/A'], '`Return`');
  assert.equal(m['C-Stick/Up'], '`Up Arrow`');
  const l = ini.linesToObject(IM.dolphinGCPad(kb, { kind: 'keyboard' }, 'linux'));
  assert.equal(l.Device, 'XInput2/0/Virtual core pointer');
  assert.equal(l['Buttons/B'], '`j`');
  assert.equal(l['Main Stick/Modifier'], '`Shift_L`');
});

test('guessSdlName maps common controllers', () => {
  assert.equal(IM.guessSdlName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), 'PS5 Controller');
  assert.equal(IM.guessSdlName('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)'), 'Nintendo Switch Pro Controller');
  assert.equal(IM.guessSdlName('Some Pad (Vendor: 1234 Product: 5678)'), 'Some Pad');
});

// ---------------------------------------------------------------- config writers
test('ini merge preserves unknown keys', () => {
  const f = path.join(tmp, 'Dolphin.ini');
  fs.writeFileSync(f, '[General]\nUserKey = keep\n[Interface]\nThemeName = Clean\n');
  ini.updateFile(f, { General: { ISOPaths: 1 }, NetPlay: { Nickname: 'Matt' } });
  const parsed = ini.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(parsed.sections.get('General').get('UserKey'), 'keep');
  assert.equal(parsed.sections.get('General').get('ISOPaths'), '1');
  assert.equal(parsed.sections.get('Interface').get('ThemeName'), 'Clean');
  assert.equal(parsed.sections.get('NetPlay').get('Nickname'), 'Matt');
});

const SETTINGS = {
  graphics: { fullscreen: true, vsync: true, widescreen: false, n64Renderer: 'parallel', n64Scale: 4, gcBackend: 'auto', gcScale: 3 },
  controls: { n64: { mode: 'gamepad', keyboard: {}, gamepad: {} }, gc: { mode: 'gamepad', keyboard: {}, gamepad: {}, device: { kind: 'xinput', index: 0 } } },
  netplay: { dolphinPort: 2626 },
};

test('Dolphin host config points the session index at the lobby server', () => {
  const userDir = path.join(tmp, 'dolphin-user');
  const gamePath = path.join(tmp, 'gc', 'Melee (USA) (Rev 2).iso');
  const r = dolphin.prepare({
    userDir, mode: 'host', platform: 'win32', settings: SETTINGS, game: { path: gamePath },
    romFolders: [tmp], lobbyCode: 'ABC234', indexUrl: 'https://lobby.example/dolphin', nickname: 'Matt', inputDelay: 3,
  });
  const d = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'Dolphin.ini'), 'utf8')).sections;
  assert.equal(d.get('NetPlay').get('IndexName'), 'ABC234');
  assert.equal(d.get('NetPlay').get('IndexServer'), 'https://lobby.example/dolphin');
  assert.equal(d.get('NetPlay').get('UseIndex'), 'True');
  assert.equal(d.get('NetPlay').get('IndexPassword'), '');
  assert.equal(d.get('NetPlay').get('TraversalChoice'), 'traversal');
  assert.equal(d.get('NetPlay').get('BufferSize'), '3');
  assert.equal(d.get('Core').get('GFXBackend'), 'D3D12');
  assert.equal(d.get('Display').get('Fullscreen'), 'True');
  assert.equal(d.get('Analytics').get('PermissionAsked'), 'True');
  assert.equal(r.exclusive, true, 'hosted game linked alone into the session folder');
  assert.ok(fs.existsSync(path.join(userDir, 'NetcadeSession', 'Melee (USA) (Rev 2).iso')));
  const gfx = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'GFX.ini'), 'utf8')).sections;
  assert.equal(gfx.get('Settings').get('InternalResolution'), '3');
  assert.equal(gfx.get('Settings').get('ShaderCompilationMode'), '2');
  const pad = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'GCPadNew.ini'), 'utf8')).sections;
  assert.equal(pad.get('GCPad1').get('Device'), 'XInput/0/Gamepad');
  assert.deepEqual(dolphin.args({ userDir, mode: 'host' }), ['-u', userDir]);
});

test('Dolphin guest config pre-fills the host code', () => {
  const userDir = path.join(tmp, 'dolphin-guest');
  dolphin.prepare({
    userDir, mode: 'guest', platform: 'linux', settings: SETTINGS, romFolders: [tmp],
    indexUrl: 'https://lobby.example/dolphin', nickname: 'Sam', hostCode: '4f2a91bc', method: 'traversal', port: 2626,
  });
  const d = ini.parse(fs.readFileSync(path.join(userDir, 'Config', 'Dolphin.ini'), 'utf8')).sections;
  assert.equal(d.get('NetPlay').get('HostCode'), '4f2a91bc');
  assert.equal(d.get('NetPlay').get('TraversalChoice'), 'traversal');
  assert.equal(d.get('General').get('ISOPath0'), tmp);
  assert.equal(d.get('Core').get('GFXBackend'), 'Vulkan');
});

test('RetroArch append config and arguments', () => {
  const dataDir = path.join(tmp, 'ra');
  const r = retroarch.prepare({ dataDir, mode: 'host', settings: SETTINGS, nickname: 'Matt', inputDelay: 2, hostOptions: { n64Renderer: 'gliden64' } });
  const cfg = fs.readFileSync(r.appendConfig, 'utf8');
  assert.match(cfg, /netplay_public_announce = "false"/);
  assert.match(cfg, /netplay_input_latency_frames_min = "2"/);
  assert.match(cfg, /video_driver = "glcore"/, 'host renderer choice wins');
  assert.match(cfg, /config_save_on_exit = "false"/);
  assert.match(cfg, /input_enable_hotkey = "rctrl"/);
  const opts = fs.readFileSync(path.join(dataDir, 'netcade-core-options.opt'), 'utf8');
  assert.match(opts, /mupen64plus-alt-map = "True"/);
  assert.match(opts, /mupen64plus-rdp-plugin = "gliden64"/);
  assert.ok(fs.existsSync(path.join(dataDir, 'remaps', 'Mupen64Plus-Next', 'Mupen64Plus-Next.rmp')));
  const a = retroarch.args({ corePath: '/c.so', romPath: '/g.z64', appendConfig: r.appendConfig, nickname: 'Matt', net: { role: 'guest', ip: '1.2.3.4', port: 55435 } });
  assert.deepEqual(a, ['-L', '/c.so', '--appendconfig', r.appendConfig, '--connect', '1.2.3.4', '--port', '55435', '--nick', 'Matt', '/g.z64']);
});

// ---------------------------------------------------------------- built-in emulators
test('bundled emulators are found from the vendor manifest', () => {
  const emulators = require('../lib/emulators');
  const appPath = path.join(tmp, 'app');
  const tag = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  const v = path.join(appPath, 'vendor', `${tag}-${process.arch}`);
  fs.mkdirSync(path.join(v, 'dolphin'), { recursive: true });
  fs.mkdirSync(path.join(v, 'cores'), { recursive: true });
  fs.writeFileSync(path.join(v, 'dolphin', 'AppRun'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(v, 'cores', 'core.so'), 'x');
  fs.writeFileSync(path.join(v, 'manifest.json'), JSON.stringify({
    builtAt: '2026-10-24', dolphin: { version: '2609a', exe: 'dolphin/AppRun' },
    retroarch: { version: '1.22.2', exe: 'retroarch/missing' }, n64core: { file: 'cores/core.so', version: 'M64 1234' }, autoconfig: { dir: 'autoconfig' },
  }));
  const b = emulators.bundled({ appPath, isPackaged: false });
  assert.equal(b.dolphin.version, '2609a');
  assert.equal(b.retroarch, null, 'a listed-but-missing emulator is not offered');
  assert.equal(b.n64Core.version, 'M64 1234');
  assert.equal(emulators.bundled({ appPath: path.join(tmp, 'nothing'), isPackaged: false }), null);
  // packaged layout: <resources>/vendor
  const res = path.join(tmp, 'resources');
  fs.cpSync(v, path.join(res, 'vendor'), { recursive: true });
  assert.equal(emulators.bundled({ resourcesPath: res, isPackaged: true }).dolphin.version, '2609a');
});

test('built-in RetroArch runs on a Netcade-owned config with bundled controller profiles', () => {
  const dataDir = path.join(tmp, 'ra-bundled');
  const r = retroarch.prepare({ dataDir, mode: 'guest', settings: SETTINGS, nickname: 'Sam', bundle: { autoconfig: '/opt/netcade/vendor/autoconfig' } });
  assert.ok(r.baseConfig && fs.existsSync(r.baseConfig));
  const cfg = fs.readFileSync(r.appendConfig, 'utf8');
  assert.match(cfg, /joypad_autoconfig_dir = "\/opt\/netcade\/vendor\/autoconfig"/);
  assert.match(cfg, /menu_driver = "rgui"/);
  const a = retroarch.args({ corePath: '/c.so', romPath: '/g.z64', appendConfig: r.appendConfig, baseConfig: r.baseConfig });
  assert.deepEqual(a.slice(0, 6), ['-L', '/c.so', '--config', r.baseConfig, '--appendconfig', r.appendConfig]);
});
