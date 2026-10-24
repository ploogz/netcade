#!/usr/bin/env node
/**
 * Downloads Dolphin, RetroArch, the N64 core and controller profiles, and lays them out in
 * vendor/<os>-<arch>/ so electron-builder packs them into the installer.
 *
 * Usage:
 *   node scripts/fetch-emulators.js                      # current OS, all arches it builds
 *   node scripts/fetch-emulators.js --os win --arch x64
 *   node scripts/fetch-emulators.js --cache ~/netcade-downloads   # reuse downloads between runs
 *   node scripts/fetch-emulators.js --offline-dir ./archives      # use files you downloaded yourself
 *
 * Extraction needs: 7-Zip (bundled via 7zip-bin), hdiutil on macOS for .dmg,
 * and Linux to unpack AppImages (so players don't need FUSE).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'emulators.json'), 'utf8'));

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const HOST_OS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const TARGET_OS = opt('os', HOST_OS);
const ARCHES = (opt('arch', TARGET_OS === 'mac' ? 'x64,arm64' : 'x64')).split(',');
const CACHE = path.resolve(opt('cache', process.env.NETCADE_EMU_CACHE || path.join(os.tmpdir(), 'netcade-emulator-cache')));
const OFFLINE = opt('offline-dir', null);
const ONLY = opt('only', null)?.split(',');
const want = (k) => !ONLY || ONLY.includes(k);

function log(...a) { console.log('[fetch-emulators]', ...a); }
function fail(msg) { console.error(`\n[fetch-emulators] ERROR: ${msg}\n`); process.exit(1); }

// ---------------------------------------------------------------- download
function request(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const h = { 'User-Agent': 'netcade-build', ...headers };
    if (url.startsWith('https://api.github.com') && process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    https.get(url, { headers: h }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), headers, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      resolve(res);
    }).on('error', reject);
  });
}

async function getJson(url) {
  const res = await request(url, { Accept: 'application/vnd.github+json' });
  let body = '';
  for await (const c of res) body += c;
  return JSON.parse(body);
}

async function download(url) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'download';
  if (OFFLINE) {
    const p = path.join(OFFLINE, name);
    if (!fs.existsSync(p)) fail(`--offline-dir is set but ${name} is missing from it (expected from ${url})`);
    return p;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
  const dest = path.join(CACHE, `${key}-${name}`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0 && !url.includes('/latest/')) {
    log(`cached  ${name}`);
    return dest;
  }
  log(`download ${url}`);
  const res = await request(url);
  const total = +res.headers['content-length'] || 0;
  let got = 0;
  let lastPct = -10;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest + '.part');
    res.on('data', (c) => {
      got += c.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (total && pct >= lastPct + 10) { lastPct = pct; process.stdout.write(`  ${pct}%`); }
    });
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  process.stdout.write('\n');
  fs.renameSync(dest + '.part', dest);
  return dest;
}

// ---------------------------------------------------------------- extraction
function sevenZip() {
  try {
    return require('7zip-bin').path7za;
  } catch {
    return '7z';
  }
}

function extract7z(archive, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(sevenZip(), ['x', '-y', `-o${outDir}`, archive], { stdio: ['ignore', 'ignore', 'inherit'] });
}

function extractZip(archive, outDir) {
  const AdmZip = require('adm-zip');
  new AdmZip(archive).extractAllTo(outDir, true);
}

function findFile(dir, test, depth = 6) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (test(e.name, e.isDirectory())) return p;
    if (e.isDirectory() && depth > 0 && !e.name.endsWith('.app')) {
      const r = findFile(p, test, depth - 1);
      if (r) return r;
    }
  }
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
}

/** macOS: mount a dmg and copy the .app out with ditto (keeps signatures and symlinks). */
function extractAppFromDmg(dmg, appName, destDir) {
  if (process.platform !== 'darwin') fail(`Unpacking ${path.basename(dmg)} needs macOS (hdiutil). Build the Mac version on a Mac or the macos GitHub runner.`);
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-dmg-'));
  execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { stdio: 'inherit' });
  try {
    const app = findFile(mount, (n, isDir) => isDir && n === appName, 2);
    if (!app) fail(`${appName} not found inside ${path.basename(dmg)}`);
    fs.mkdirSync(destDir, { recursive: true });
    execFileSync('ditto', [app, path.join(destDir, appName)], { stdio: 'inherit' });
  } finally {
    execFileSync('hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' });
  }
}

/** Linux: unpack an AppImage so it runs without FUSE. Returns the AppDir path. */
function unpackAppImage(appImage, destDir) {
  if (process.platform !== 'linux') fail('Unpacking AppImages needs Linux. Build the Linux version on Linux or the ubuntu GitHub runner.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-appimage-'));
  const copy = path.join(work, 'app.AppImage');
  fs.copyFileSync(appImage, copy);
  fs.chmodSync(copy, 0o755);
  execFileSync(copy, ['--appimage-extract'], { cwd: work, stdio: 'ignore', env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
  const root = path.join(work, 'squashfs-root');
  if (!fs.existsSync(path.join(root, 'AppRun'))) fail(`AppRun missing after extracting ${path.basename(appImage)}`);
  fs.rmSync(destDir, { recursive: true, force: true });
  copyDir(root, destDir);
  fs.rmSync(work, { recursive: true, force: true });
  return destDir;
}

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function rmMany(dir, names) {
  for (const n of names) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

// ---------------------------------------------------------------- components
async function fetchDolphin(target, out, info) {
  const m = MANIFEST.dolphin;
  const dest = path.join(out, 'dolphin');
  fs.rmSync(dest, { recursive: true, force: true });
  if (target.os === 'win') {
    const archive = await download(m['win-x64'].url);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-dolphin-'));
    extract7z(archive, tmp);
    const exe = findFile(tmp, (n) => n === 'Dolphin.exe');
    if (!exe) fail('Dolphin.exe not found in the Dolphin archive');
    copyDir(path.dirname(exe), dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    info.dolphin = { version: m.version, exe: 'dolphin/Dolphin.exe' };
  } else if (target.os === 'mac') {
    extractAppFromDmg(await download(m.mac.url), m.mac.app, dest);
    info.dolphin = { version: m.version, exe: `dolphin/${m.mac.exe}` };
  } else {
    const spec = m['linux-x64'];
    const releases = await getJson(`https://api.github.com/repos/${spec.github}/releases?per_page=40`);
    const rel = releases.find((r) => r.tag_name.startsWith(spec.tagPrefix));
    if (!rel) {
      fail(`No ${spec.github} release for Dolphin ${m.version} yet (looked for tags starting "${spec.tagPrefix}"). `
        + `Newest tags: ${releases.slice(0, 5).map((r) => r.tag_name).join(', ')}. `
        + 'Wait for it, or set dolphin.version to a version available on every OS so netplay versions match.');
    }
    const asset = rel.assets.find((a) => new RegExp(spec.assetPattern).test(a.name));
    if (!asset) fail(`Release ${rel.tag_name} has no asset matching ${spec.assetPattern}`);
    unpackAppImage(await download(asset.browser_download_url), dest);
    info.dolphin = { version: m.version, exe: 'dolphin/AppRun', appimageRelease: rel.tag_name };
  }
  log(`Dolphin ${m.version} ready`);
}

async function fetchRetroArch(target, out, info) {
  const m = MANIFEST.retroarch;
  const dest = path.join(out, 'retroarch');
  fs.rmSync(dest, { recursive: true, force: true });
  if (target.os === 'win') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-ra-'));
    extract7z(await download(m['win-x64'].url), tmp);
    const exe = findFile(tmp, (n) => n.toLowerCase() === 'retroarch.exe');
    if (!exe) fail('retroarch.exe not found in the RetroArch archive');
    copyDir(path.dirname(exe), dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    // Netcade drives RetroArch directly, so menus' artwork, shaders and databases aren't needed
    rmMany(dest, ['assets', 'overlays', 'shaders', 'database', 'cheats', 'downloads', 'thumbnails', 'cores', 'retroarch_debug.exe']);
    info.retroarch = { version: m.version, exe: 'retroarch/retroarch.exe' };
  } else if (target.os === 'mac') {
    extractAppFromDmg(await download(m.mac.url), m.mac.app, dest);
    info.retroarch = { version: m.version, exe: `retroarch/${m.mac.exe}` };
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-ra-'));
    extract7z(await download(m['linux-x64'].url), tmp);
    const appImage = findFile(tmp, (n) => /\.AppImage$/.test(n));
    if (!appImage) fail('RetroArch AppImage not found in the Linux archive');
    unpackAppImage(appImage, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    info.retroarch = { version: m.version, exe: 'retroarch/AppRun' };
  }
  log(`RetroArch ${m.version} ready`);
}

async function fetchCore(target, out, info) {
  const url = MANIFEST.n64core[`${target.os}-${target.arch}`] || MANIFEST.n64core[`${target.os}-x64`];
  if (!url) fail(`No N64 core URL for ${target.os}-${target.arch}`);
  const dir = path.join(out, 'cores');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  extractZip(await download(url), dir);
  const file = fs.readdirSync(dir).find((f) => f.startsWith('mupen64plus_next_libretro'));
  if (!file) fail('N64 core file missing from its zip');
  const hash = sha1(path.join(dir, file));
  info.n64core = { file: `cores/${file}`, sha1: hash, version: `${MANIFEST.n64core.name} ${hash.slice(0, 8)}`, fetchedFrom: url };
  log(`N64 core ready (${hash.slice(0, 8)})`);
}

async function fetchAutoconfig(target, out, info) {
  const m = MANIFEST.autoconfig;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netcade-autoconfig-'));
  extractZip(await download(m.url), tmp);
  const root = findFile(tmp, (n, isDir) => isDir && n.startsWith('retroarch-joypad-autoconfig'), 1) || tmp;
  const dest = path.join(out, 'autoconfig');
  fs.rmSync(dest, { recursive: true, force: true });
  let count = 0;
  for (const d of m.drivers[target.os]) {
    if (fs.existsSync(path.join(root, d))) {
      copyDir(path.join(root, d), path.join(dest, d));
      count += fs.readdirSync(path.join(dest, d)).length;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!count) fail('No controller profiles were copied');
  info.autoconfig = { dir: 'autoconfig', profiles: count };
  log(`${count} controller profiles ready`);
}

async function fetchVcRedist(target, out, info) {
  if (target.os !== 'win') return;
  const file = await download(MANIFEST.vcredist.url);
  fs.copyFileSync(file, path.join(out, 'vc_redist.x64.exe'));
  info.vcredist = 'vc_redist.x64.exe';
  log('VC++ runtime installer ready');
}

function writeNotices(out, info) {
  const lic = path.join(out, 'LICENSES');
  fs.mkdirSync(lic, { recursive: true });
  const lines = [
    '# Third-party software bundled with Netcade',
    '',
    'Netcade launches these programs as separate processes. They are free software; you can get',
    'their complete source code from the links below, and you may redistribute and modify them',
    'under their licenses.',
    '',
    `- **Dolphin ${MANIFEST.dolphin.version}** (${MANIFEST.dolphin.license}): ${MANIFEST.dolphin.source}`,
    info.dolphin?.appimageRelease ? `  - Linux build: ${MANIFEST.dolphin['linux-x64'].github} release ${info.dolphin.appimageRelease}` : null,
    `- **RetroArch ${MANIFEST.retroarch.version}** (${MANIFEST.retroarch.license}): ${MANIFEST.retroarch.source}`,
    `- **${MANIFEST.n64core.name}** (${MANIFEST.n64core.license}): ${MANIFEST.n64core.source} (build sha1 ${info.n64core?.sha1 || 'n/a'}, fetched ${info.builtAt})`,
    `- **RetroArch joypad autoconfig profiles**: ${MANIFEST.autoconfig.source}`,
    info.vcredist ? '- **Microsoft Visual C++ Redistributable**: redistributed under the Microsoft Visual Studio license terms' : null,
    '',
    'Full license texts: https://www.gnu.org/licenses/gpl-2.0.txt and https://www.gnu.org/licenses/gpl-3.0.txt',
    '',
    'No games, BIOS files or other copyrighted game data are included.',
  ].filter((x) => x !== null);
  fs.writeFileSync(path.join(lic, 'THIRD_PARTY.md'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------- main
(async () => {
  if (!['win', 'mac', 'linux'].includes(TARGET_OS)) fail(`unknown --os ${TARGET_OS}`);
  for (const arch of ARCHES) {
    const target = { os: TARGET_OS, arch };
    const out = path.join(ROOT, 'vendor', `${TARGET_OS}-${arch}`);
    fs.mkdirSync(out, { recursive: true });
    const manifestPath = path.join(out, 'manifest.json');
    let info = {};
    try { info = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* fresh */ }
    info.builtAt = new Date().toISOString().slice(0, 10);
    info.os = TARGET_OS;
    info.arch = arch;
    log(`=== ${TARGET_OS}-${arch} -> ${path.relative(ROOT, out)}`);
    if (want('dolphin')) await fetchDolphin(target, out, info);
    if (want('retroarch')) await fetchRetroArch(target, out, info);
    if (want('core')) await fetchCore(target, out, info);
    if (want('autoconfig')) await fetchAutoconfig(target, out, info);
    if (want('vcredist')) await fetchVcRedist(target, out, info);
    writeNotices(out, info);
    fs.writeFileSync(manifestPath, JSON.stringify(info, null, 2));
    log(`manifest written: ${JSON.stringify(info)}`);
  }
})().catch((err) => fail(err.stack || err.message));
