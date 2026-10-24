/* global InputMaps */
/**
 * Controls editor: press-to-bind mapping for keyboard or controller, per system.
 * Used both on the Controls page and in the lobby's Controls drawer.
 */
(function () {
  'use strict';
  const IM = window.InputMaps;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function readPads() {
    const out = [];
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of list) {
      if (!p || !p.connected) continue;
      out.push({
        index: p.index,
        id: p.id,
        standard: p.mapping === 'standard',
        buttons: p.buttons.map((b) => (typeof b === 'object' ? b.value : b)),
        axes: p.axes.slice(),
      });
    }
    return out;
  }

  function bindingActive(bd, pads, keys) {
    if (!bd) return false;
    if (bd.t === 'key') return keys.has(bd.code);
    for (const p of pads) {
      if (bd.t === 'btn' && (p.buttons[bd.i] || 0) > 0.5) return true;
      if (bd.t === 'axis' && (p.axes[bd.i] || 0) * bd.d > 0.5) return true;
    }
    return false;
  }

  class ControlsEditor {
    constructor(container, opts) {
      this.el = container;
      this.opts = opts;           // { getSettings, save, toast, platform, system, lockSystem }
      this.system = opts.system || 'n64';
      this.listening = null;
      this.keys = new Set();
      this.raf = 0;
      this.mounted = false;
      this._onKeyDown = this.onKeyDown.bind(this);
      this._onKeyUp = this.onKeyUp.bind(this);
      this._onClick = this.onClick.bind(this);
      this._onChange = this.onChange.bind(this);
    }

    get cfg() {
      return this.opts.getSettings().controls[this.system];
    }

    get mode() {
      return this.cfg.mode === 'gamepad' ? 'gamepad' : 'keyboard';
    }

    get map() {
      return IM.resolve(this.system, this.mode, this.cfg[this.mode]);
    }

    mount(system) {
      if (system) this.system = system;
      if (!this.mounted) {
        window.addEventListener('keydown', this._onKeyDown, true);
        window.addEventListener('keyup', this._onKeyUp, true);
        this.el.addEventListener('click', this._onClick);
        this.el.addEventListener('change', this._onChange);
        this.mounted = true;
        this.loop();
      }
      this.render();
    }

    unmount() {
      if (!this.mounted) return;
      window.removeEventListener('keydown', this._onKeyDown, true);
      window.removeEventListener('keyup', this._onKeyUp, true);
      this.el.removeEventListener('click', this._onClick);
      this.el.removeEventListener('change', this._onChange);
      cancelAnimationFrame(this.raf);
      this.mounted = false;
      this.listening = null;
    }

    async saveMap(map) {
      const sys = this.system;
      const patch = { controls: { [sys]: { mode: this.mode, [this.mode]: map } } };
      await this.opts.save(patch);
    }

    render() {
      const sys = this.system;
      const mode = this.mode;
      const map = this.map;
      const conflicts = IM.conflicts(sys, map);
      const conflictIds = new Set(conflicts.flatMap((c) => [c.id, c.other]));
      const groups = [];
      for (const c of IM.CONTROLS[sys]) {
        let g = groups.find((x) => x.name === c.group);
        if (!g) groups.push((g = { name: c.group, items: [] }));
        g.items.push(c);
      }
      const platform = this.opts.platform;
      const dev = this.cfg.device || {};
      const pads = readPads();

      this.el.innerHTML = `
        <div class="view-head">
          <div>
            <h1>Controls</h1>
            <div class="sub">Click a control, then press the key or button you want. Esc cancels, Backspace clears.</div>
          </div>
          <div class="spacer"></div>
          ${this.opts.lockSystem ? '' : `
          <div class="seg" role="tablist">
            <button data-act="system" data-v="n64" class="${sys === 'n64' ? 'active' : ''}">N64</button>
            <button data-act="system" data-v="gc" class="${sys === 'gc' ? 'active' : ''}">GameCube</button>
          </div>`}
          <div class="seg">
            <button data-act="mode" data-v="keyboard" class="${mode === 'keyboard' ? 'active' : ''}">Keyboard</button>
            <button data-act="mode" data-v="gamepad" class="${mode === 'gamepad' ? 'active' : ''}">Controller</button>
          </div>
        </div>
        ${conflicts.length ? `<div class="banner warn">${ICON_WARN}<div>Some controls share the same input: ${conflicts.map((c) => `${esc(label(sys, c.id))} + ${esc(label(sys, c.other))}`).join(', ')}.</div></div>` : ''}
        <div class="controls-wrap">
          <div class="panel">
            ${groups.map((g) => `
              <div class="bind-group">
                <h3>${esc(g.name)}</h3>
                <div class="bind-grid">
                  ${g.items.map((c) => {
                    const bd = map[c.id];
                    const listening = this.listening && this.listening.id === c.id;
                    return `<div class="bind ${conflictIds.has(c.id) ? 'conflict' : ''}" data-bind="${c.id}">
                      <span class="lbl">${esc(c.label)}</span>
                      <button class="bind-btn ${bd ? '' : 'unbound'} ${listening ? 'listening' : ''}" data-act="listen" data-id="${c.id}">
                        ${listening ? (mode === 'keyboard' ? 'Press a key…' : 'Press / move…') : esc(IM.describeBinding(bd))}
                      </button>
                      <button class="icon-btn" title="Clear" data-act="clear" data-id="${c.id}">${ICON_X}</button>
                    </div>`;
                  }).join('')}
                </div>
              </div>`).join('')}
            <div class="row">
              <button class="btn" data-act="reset">Reset ${mode === 'keyboard' ? 'keyboard' : 'controller'} defaults</button>
              <span class="hint">Saved automatically. Applies the next time a game launches.</span>
            </div>
          </div>
          <div class="stack">
            ${mode === 'gamepad' ? this.renderPads(pads, dev, platform) : this.renderKeyboardNotes()}
          </div>
        </div>`;
    }

    renderKeyboardNotes() {
      const sys = this.system;
      return `<div class="panel">
        <h2>Keyboard tips</h2>
        <p class="muted small">Bound keys light up as you press them, so you can test your layout right here.</p>
        ${sys === 'n64' ? `<p class="muted small">In N64 games, emulator shortcuts need <b>Right Ctrl</b> held down, so your game keys never trigger them:</p>
        <ul class="muted small">
          <li><b>Right Ctrl + F</b>: fullscreen</li>
          <li><b>Right Ctrl + Esc</b>: quit</li>
          <li><b>Right Ctrl + F1</b>: RetroArch menu</li>
        </ul>` : `<p class="muted small">In GameCube games, <b>Walk modifier</b> slows the stick to half speed, which helps for precise movement on a keyboard.</p>
        <p class="muted small">Press <b>Esc</b> in Dolphin to stop the game.</p>`}
      </div>`;
    }

    renderPads(pads, dev, platform) {
      const sys = this.system;
      const padHtml = pads.length
        ? pads.map((p) => `<div class="pad" data-pad="${p.index}">
            <strong>${esc(p.id.replace(/\s*\(.*\)\s*$/, '') || 'Controller')}</strong>
            <span class="${p.standard ? 'muted' : 'warn-text'}">${p.standard ? `Controller ${p.index + 1} · standard layout` : 'Unrecognised layout: bindings may be off'}</span>
            <div class="viz">${p.buttons.slice(0, 17).map(() => '<i></i>').join('')}</div>
            ${sys === 'gc' ? `<div class="row" style="margin-top:8px"><button class="btn small" data-act="usepad" data-index="${p.index}">Use for Dolphin</button></div>` : ''}
          </div>`).join('')
        : `<div class="pad"><strong>No controller detected</strong><span class="muted">Plug one in and press any button. Wireless controllers must be paired first.</span></div>`;

      let deviceHtml = '';
      if (sys === 'gc') {
        const kind = platform === 'win32' ? (dev.kind || 'xinput') : 'sdl';
        deviceHtml = `<div class="panel">
          <h2>Dolphin controller</h2>
          ${platform === 'win32' ? `
          <label class="field">Controller type
            <select class="input" data-field="device.kind">
              <option value="xinput" ${kind === 'xinput' ? 'selected' : ''}>Xbox-style (XInput)</option>
              <option value="sdl" ${kind === 'sdl' ? 'selected' : ''}>PlayStation, Switch Pro, other (SDL)</option>
            </select>
          </label>` : ''}
          ${kind === 'sdl' ? `
          <label class="field" style="margin-top:10px">Controller name in Dolphin
            <input class="input" data-field="device.name" value="${esc(dev.name || '')}" placeholder="e.g. PS5 Controller">
          </label>` : ''}
          <label class="field" style="margin-top:10px">Controller number
            <select class="input" data-field="device.index">
              ${[0, 1, 2, 3].map((i) => `<option value="${i}" ${(dev.index | 0) === i ? 'selected' : ''}>${i + 1}</option>`).join('')}
            </select>
          </label>
          <p class="hint">Click <b>Use for Dolphin</b> on a connected controller to fill this in. If a button doesn't respond in-game, open Dolphin → Controllers to adjust; Netcade rewrites only Port 1 on each launch.</p>
        </div>`;
      } else {
        deviceHtml = `<div class="panel">
          <h2>How N64 controller mapping works</h2>
          <p class="muted small">RetroArch recognises most controllers automatically. Netcade then remaps buttons to the N64 layout you set here. The left stick is always the N64 analog stick; the right stick doubles as the C buttons.</p>
        </div>`;
      }
      return `<div class="panel"><h2>Connected controllers</h2><div class="pad-list">${padHtml}</div></div>${deviceHtml}`;
    }

    // ---------------------------------------------------------------- events
    async onClick(e) {
      const t = e.target.closest('[data-act]');
      if (!t || !this.el.contains(t)) return;
      const act = t.dataset.act;
      if (act === 'system') {
        this.system = t.dataset.v;
        this.listening = null;
        this.render();
      } else if (act === 'mode') {
        await this.opts.save({ controls: { [this.system]: { mode: t.dataset.v } } });
        this.listening = null;
        this.render();
      } else if (act === 'listen') {
        const pads = readPads();
        this.listening = {
          id: t.dataset.id,
          at: performance.now(),
          base: pads.map((p) => ({ index: p.index, buttons: p.buttons.slice(), axes: p.axes.slice() })),
        };
        this.render();
      } else if (act === 'clear') {
        const map = this.map;
        map[t.dataset.id] = null;
        await this.saveMap(map);
        this.render();
      } else if (act === 'reset') {
        await this.saveMap(IM.resolve(this.system, this.mode, null));
        this.render();
      } else if (act === 'usepad') {
        const p = readPads().find((x) => x.index === +t.dataset.index);
        if (!p) return;
        const kind = this.opts.platform === 'win32' && IM.isXInputLike(p.id) ? 'xinput' : 'sdl';
        await this.opts.save({ controls: { gc: { device: { kind, index: kind === 'xinput' ? 0 : p.index, name: IM.guessSdlName(p.id) } } } });
        this.opts.toast(`Dolphin will use ${kind === 'xinput' ? 'XInput controller 1' : IM.guessSdlName(p.id)}.`);
        this.render();
      }
    }

    async onChange(e) {
      const t = e.target.closest('[data-field]');
      if (!t) return;
      const [, field] = t.dataset.field.split('.');
      const value = field === 'index' ? +t.value : t.value;
      await this.opts.save({ controls: { gc: { device: { [field]: value } } } });
      if (field === 'kind') this.render();
    }

    async commit(bd) {
      const id = this.listening.id;
      const err = IM.validate(this.system, this.mode, id, bd);
      if (err) {
        this.opts.toast(err, 'warn');
        return;
      }
      const map = this.map;
      map[id] = bd;
      this.listening = null;
      await this.saveMap(map);
      this.render();
    }

    onKeyDown(e) {
      if (!this.el.isConnected || !this.el.offsetParent) return;
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
      if (!this.listening) {
        if (!typing) this.keys.add(e.code);
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        this.listening = null;
        this.render();
        return;
      }
      if (e.code === 'Backspace' || e.code === 'Delete') {
        const map = this.map;
        map[this.listening.id] = null;
        this.listening = null;
        this.saveMap(map).then(() => this.render());
        return;
      }
      if (this.mode === 'keyboard') this.commit({ t: 'key', code: e.code });
    }

    onKeyUp(e) {
      this.keys.delete(e.code);
    }

    loop() {
      this.raf = requestAnimationFrame(() => this.loop());
      if (!this.el.offsetParent) return;
      const pads = readPads();

      // capture a controller input
      if (this.listening && this.mode === 'gamepad') {
        if (performance.now() - this.listening.at > 10000) {
          this.listening = null;
          this.render();
          return;
        }
        for (const p of pads) {
          const base = this.listening.base.find((b) => b.index === p.index) || { buttons: [], axes: [] };
          for (let i = 0; i < p.buttons.length && i < 17; i++) {
            if (p.buttons[i] > 0.6 && !((base.buttons[i] || 0) > 0.6)) {
              this.commit({ t: 'btn', i });
              return;
            }
          }
          for (let i = 0; i < p.axes.length && i < 4; i++) {
            const v = p.axes[i];
            if (Math.abs(v) > 0.65 && Math.abs(v - (base.axes[i] || 0)) > 0.5) {
              this.commit({ t: 'axis', i, d: v > 0 ? 1 : -1 });
              return;
            }
          }
        }
      }

      // live highlight of bound inputs
      const map = this.map;
      for (const el of this.el.querySelectorAll('[data-bind]')) {
        el.classList.toggle('live', bindingActive(map[el.dataset.bind], pads, this.keys));
      }
      for (const el of this.el.querySelectorAll('[data-pad]')) {
        const p = pads.find((x) => x.index === +el.dataset.pad);
        if (!p) continue;
        el.querySelectorAll('.viz i').forEach((dot, i) => dot.classList.toggle('on', (p.buttons[i] || 0) > 0.5));
      }
      // re-render when a controller is plugged in or out
      const sig = pads.map((p) => p.index + p.id).join('|');
      if (this.mode === 'gamepad' && sig !== this.padSig) {
        this.padSig = sig;
        if (!this.listening) this.render();
      }
    }
  }

  function label(sys, id) {
    return (IM.CONTROLS[sys].find((c) => c.id === id) || {}).label || id;
  }

  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>';

  window.ControlsEditor = ControlsEditor;
})();
