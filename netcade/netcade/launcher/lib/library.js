'use strict';
/**
 * Game library: scans the user's folders for N64/GameCube files and caches what it learns,
 * so rescans only re-read files that changed.
 */
const fs = require('fs');
const path = require('path');
const { readRomInfo, systemForFile } = require('./romInfo');

const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git', '.trash']);

class Library {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.games = [];
    this.errors = [];
    this.cache = {};
    try {
      this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {};
      this.games = Object.values(this.cache).filter((g) => g && g.key);
    } catch {
      this.cache = {};
    }
    this.scanning = null;
  }

  async listFiles(folder, depth = 0, out = []) {
    let entries;
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(folder, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase()) && !e.name.startsWith('.')) {
          await this.listFiles(p, depth + 1, out);
        }
      } else if ((e.isFile() || e.isSymbolicLink()) && systemForFile(e.name)) {
        out.push(p);
      }
    }
    return out;
  }

  /** Scan all folders; onProgress(done, total, file). Concurrent calls share one scan. */
  scan(folders, onProgress = () => {}) {
    if (this.scanning) return this.scanning;
    this.scanning = this._scan(folders, onProgress).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async _scan(folders, onProgress) {
    const files = [];
    for (const f of folders) await this.listFiles(f, 0, files);
    const unique = [...new Set(files)];
    const nextCache = {};
    const games = [];
    const errors = [];
    let done = 0;
    for (const file of unique) {
      onProgress(done, unique.length, path.basename(file));
      try {
        const st = await fs.promises.stat(file);
        const cached = this.cache[file];
        let info;
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          info = cached;
        } else {
          info = await readRomInfo(file);
        }
        nextCache[file] = info;
        games.push(info);
      } catch (err) {
        errors.push({ file, error: err.message });
      }
      done++;
      // keep the UI responsive during long N64 hashing runs
      if (done % 8 === 0) await new Promise((r) => setImmediate(r));
    }
    onProgress(done, unique.length, '');
    games.sort((a, b) => a.title.localeCompare(b.title));
    this.games = games;
    this.errors = errors;
    this.cache = nextCache;
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      await fs.promises.writeFile(this.cacheFile, JSON.stringify(nextCache));
    } catch {
      /* cache is optional */
    }
    return { games, errors };
  }

  byKey(key) {
    return this.games.find((g) => g.key === key) || null;
  }
}

module.exports = { Library };
