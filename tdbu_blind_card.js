/*!
 * TDBU Blind Card 2.0.0
 * Home Assistant card for top-down/bottom-up (TDBU) blinds such as Hunter Douglas PowerView.
 * https://github.com/WackeySSL/tdbu_blind_card  ·  Apache License 2.0
 *
 * One window per room: drag the rails of the big "Both" window to move both blinds together,
 * or the small Left/Right windows to move one blind. Buttons always act on the whole room.
 * An open door only blocks the bottom rail from going DOWN, and only on the door's side.
 *
 * Positions follow the PowerView entities, like version 1:
 *   top rail    = position of the top entity      (0 = rail at the top of the window)
 *   bottom rail = 100 - position of bottom entity (bottom position 100 = rail at the top)
 */

const TDBU_VERSION = "2.0.0";
const GAP = 8;               // minimum distance between the two rails, in % of the window
const PENDING_MS = 90000;    // keep showing a position we sent until the blind reports it

const STRINGS = {
  en: {
    house: "Whole house", allUp: "All up", allDown: "All down", more: "More",
    roomsDown: (n, t) => `${n} of ${t} rooms down`, doorOpenList: l => `door open: ${l}`,
    doorOpen: "Door open", doorBlocked: "The door is open, so the blind won't go down",
    skipped: l => `Skipped because the door is open: ${l}`, allGoingUp: "All blinds are going up",
    allGoingDown: "All blinds are going down", started: n => `${n} started`,
    both: "Both", left: "Left", right: "Right", topRail: "Top rail", bottomRail: "Bottom rail",
    covered: p => `${p} % covered`, down: "Down", up: "Up", stop: "Stop", isDown: "Down", isUp: "Up", differ: "Left and right are different",
    moving: "Moving…", unknown: "Position unknown", missing: e => `Entity not found: ${e}`,
  },
  da: {
    house: "Hele huset", allUp: "Alle op", allDown: "Alle ned", more: "Mere",
    roomsDown: (n, t) => `${n} af ${t} rum nede`, doorOpenList: l => `dør åben: ${l}`,
    doorOpen: "Dør åben", doorBlocked: "Døren står åben, så gardinet kører ikke ned",
    skipped: l => `Springer over, fordi døren står åben: ${l}`, allGoingUp: "Alle gardiner kører op",
    allGoingDown: "Alle gardiner kører ned", started: n => `${n} er sat i gang`,
    both: "Begge", left: "Venstre", right: "Højre", topRail: "Øverste skinne", bottomRail: "Nederste skinne",
    covered: p => `${p} % dækket`, down: "Ned", up: "Op", stop: "Stop", isDown: "Nede", isUp: "Oppe", differ: "Venstre og højre står forskelligt",
    moving: "Kører…", unknown: "Position ukendt", missing: e => `Entitet findes ikke: ${e}`,
  },
};

const DEFAULT_BUTTONS = [
  { name: "@up", icon: "mdi:arrow-collapse-up", position: { top: 1, bottom: 99 } },
  { name: "@stop", icon: "mdi:stop", action: "stop" },
  { name: "@down", icon: "mdi:arrow-collapse-down", position: { top: 1, bottom: 1 } },
];

/** Turn a 1.x config (entity_top/entity_bottom/disable_if_sensor_open) into a 2.x config. */
function migrateLegacy(c) {
  if (!c || c.rooms || !c.entity_bottom) return c;
  return {
    type: c.type,
    show_header: false,
    rooms: [{
      name: c.name || "",
      bottom: c.entity_bottom,
      ...(c.entity_top ? { top: c.entity_top } : {}),
      ...(c.disable_if_sensor_open ? { door: c.disable_if_sensor_open, door_side: "both" } : {}),
      ...(c.show_buttons === false ? { buttons: [] } : {}),
    }],
  };
}

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

class TdbuBlindCard extends HTMLElement {
  static getConfigElement() { return document.createElement("tdbu-blind-card-editor"); }

  static getStubConfig(hass) {
    const covers = Object.keys((hass && hass.states) || {}).filter(e => e.startsWith("cover."));
    const bottom = covers.find(e => /bottom/i.test(e)) || covers[0] || "cover.my_blind_bottom";
    const top = covers.find(e => /top/i.test(e) && e.replace(/top/i, "") === bottom.replace(/bottom/i, ""));
    return { rooms: [{ name: "Living room", bottom, ...(top ? { top } : {}) }] };
  }

  setConfig(config) {
    const c = migrateLegacy(config);
    if (!c || !Array.isArray(c.rooms) || !c.rooms.length) {
      throw new Error("tdbu-blind-card: add at least one room under 'rooms'");
    }
    c.rooms.forEach((r, i) => {
      if (!r || !(r.bottom || (r.left_bottom && r.right_bottom))) throw new Error(`tdbu-blind-card: room ${i + 1} needs a 'bottom' cover entity (or both 'left_bottom' and 'right_bottom')`);
    });
    this._config = c;
    this._pending = {};
    this._drag = null;
    this._rooms = c.rooms.map((r, i) => {
      const split = !!(r.left_bottom && r.right_bottom);
      const panes = split
        ? [{ name: r.left_name, top: r.left_top, bottom: r.left_bottom }, { name: r.right_name, top: r.right_top, bottom: r.right_bottom }]
        : [{ top: r.top, bottom: r.bottom }];
      const side = r.door_side || "both";
      const doorPanes = !r.door ? [] : !split ? [0] : side === "left" ? [0] : side === "right" ? [1] : [0, 1];
      const buttons = (Array.isArray(r.buttons) ? r.buttons : DEFAULT_BUTTONS).filter(Boolean);
      return { id: `r${i}`, cfg: r, split, panes, both: { top: r.top, bottom: r.bottom }, doorPanes, buttons, floor: r.floor || "" };
    });
    const ents = new Set();
    this._rooms.forEach(r => {
      if (r.cfg.door) ents.add(r.cfg.door);
      r.panes.concat([r.both]).forEach(p => { if (p.top) ents.add(p.top); if (p.bottom) ents.add(p.bottom); });
    });
    this._ents = [...ents];
    this._single = this._rooms.length === 1;
    this._header = c.show_header !== undefined ? !!c.show_header : !this._single;
    this._built = false;
    if (this._hass) { this._build(); this._update(); }
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (!this._built || (old && old.language !== hass.language)) { this._build(); this._update(); return; }
    if (!old || this._ents.some(e => old.states[e] !== hass.states[e])) this._update();
  }

  getCardSize() { return this._single ? 5 : 3 + this._rooms.length * 4; }
  getGridOptions() { return this._single ? { columns: 12, min_columns: 6 } : { columns: "full" }; }

  // ---------- text ----------
  get _t() {
    const lang = String(this._config.language || (this._hass && ((this._hass.locale && this._hass.locale.language) || this._hass.language)) || "en");
    return STRINGS[lang.slice(0, 2)] || STRINGS.en;
  }
  _label(name) {
    if (typeof name === "string" && name.startsWith("@")) return this._t[name.slice(1)] || name.slice(1);
    return name || "";
  }

  // ---------- layout ----------
  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config, t = this._t;
    const grip = (rid, tg, w) => `<div class="gr" data-g="${rid}|${tg}|${w}" role="slider" tabindex="0" aria-label="${w === "t" ? t.topRail : t.bottomRail}"><span></span><b></b></div>`;
    const frame = (r, tg, wd) => {
      const idx = tg === "all" ? r.panes.map((_, i) => i) : [+tg];
      const hasTop = tg === "all" ? !!(r.both.top || r.panes.some(p => p.top)) : !!r.panes[+tg].top;
      let h = idx.map(i => `<div class="pn"><div class="fb" data-fb="${r.id}|${tg}|${i}"></div>${tg === "all" && r.split ? `<div class="rl" data-rl="${r.id}|${i}|t"></div><div class="rl" data-rl="${r.id}|${i}|b"></div>` : ""}</div>`).join("");
      h += (hasTop ? grip(r.id, tg, "t") : "") + grip(r.id, tg, "b");
      return `<div class="fr" data-fr="${r.id}|${tg}" style="width:${wd}px">${h}</div><div class="sill" style="width:${wd + 12}px"></div>`;
    };
    const room = r => {
      const k = r.cfg;
      const minis = r.split ? `<div class="sep"></div>` + r.panes.map((p, i) => `<div class="col">${frame(r, String(i), 40)}<div class="lb">${esc(p.name || (i ? t.right : t.left))}</div></div>`).join("") : "";
      const btns = r.buttons.map((b, i) => `<button class="kn" data-k="${r.id}|${i}"><ha-icon icon="${esc(b.icon || "mdi:blinds")}"></ha-icon><span>${esc(this._label(b.name))}</span></button>`).join("");
      return `<ha-card class="rum" data-rum="${r.id}">
        <div class="hd"><div class="ico"><ha-icon icon="${esc(k.icon || "mdi:blinds-horizontal")}"></ha-icon></div>
          <div class="tt"><div class="nm">${esc(k.name || this._friendly(k.bottom || k.left_bottom))}</div><div class="st" data-st="${r.id}"></div></div>
          <span class="pill" data-door="${r.id}" hidden><ha-icon icon="mdi:door-open"></ha-icon>${esc(t.doorOpen)}</span></div>
        <div class="win"><div class="col">${frame(r, "all", r.split ? 120 : 64)}<div class="lb">${r.split ? esc(t.both) : ""}</div></div>${minis}</div>
        ${btns ? `<div class="seg">${btns}</div>` : ""}
        <div class="msg" data-msg="${r.id}"></div>
      </ha-card>`;
    };
    const menu = (c.menu || []).map((m, i) => `<button class="mi" data-m="${i}"><ha-icon icon="${esc(m.icon || "mdi:play")}"></ha-icon>${esc(m.name || m.entity)}</button>`).join("");
    const header = !this._header ? "" : `
      <ha-card class="hus">
        <div class="ico"><ha-icon icon="${esc(c.icon || "mdi:home")}"></ha-icon></div>
        <div class="tt"><div class="nm">${esc(c.title || t.house)}</div><div class="st" data-hus></div></div>
        ${c.all_up || c.all_down ? `<div class="seg hseg">
          ${c.all_up ? `<button class="kn" data-alle="up"><ha-icon icon="mdi:arrow-collapse-up"></ha-icon><span>${esc(t.allUp)}</span></button>` : ""}
          ${c.all_down ? `<button class="kn" data-alle="down"><ha-icon icon="mdi:arrow-collapse-down"></ha-icon><span>${esc(t.allDown)}</span></button>` : ""}
        </div>` : ""}
        ${menu ? `<div class="mw"><button class="dots" data-menu aria-label="${esc(t.more)}"><ha-icon icon="mdi:dots-horizontal"></ha-icon></button><div class="mn" hidden>${menu}</div></div>` : ""}
      </ha-card>
      <div class="msg husmsg" data-husmsg></div>`;
    const floors = [];
    this._rooms.forEach(r => { let f = floors.find(x => x.name === r.floor); if (!f) floors.push(f = { name: r.floor, icon: r.cfg.floor_icon, rooms: [] }); f.rooms.push(r); });
    this.shadowRoot.innerHTML = `<style>${TdbuBlindCard.css}</style>${header}
      ${floors.map(f => `${f.name ? `<div class="floor"><ha-icon icon="${esc(f.icon || "mdi:stairs")}"></ha-icon>${esc(f.name)}</div>` : ""}
        <div class="rooms${this._single ? " single" : ""}">${f.rooms.map(room).join("")}</div>`).join("")}`;
    // Listeners only once: Home Assistant may call setConfig again (e.g. while editing),
    // and duplicate listeners would send every command twice.
    if (!this._bound) { this._bind(); this._bound = true; }
    // Hide button icons when the card is too narrow to show the full text (e.g. 4 buttons on a phone).
    if (this._ro) this._ro.disconnect();
    this._ro = new ResizeObserver(list => list.forEach(en => {
      const n = en.target.querySelectorAll(".seg .kn").length;
      en.target.classList.toggle("smal", en.contentRect.width < n * 86);
    }));
    this.shadowRoot.querySelectorAll(".rum").forEach(el => this._ro.observe(el));
    this._built = true;
  }

  _bind() {
    const root = this.shadowRoot;
    root.addEventListener("click", e => this._onClick(e));
    root.addEventListener("pointerdown", e => this._onDown(e));
    root.addEventListener("pointermove", e => this._onMove(e));
    root.addEventListener("pointerup", e => this._onUp(e));
    root.addEventListener("pointercancel", e => this._onUp(e, true));
    root.addEventListener("keydown", e => this._onKey(e));
  }

  // ---------- state ----------
  _friendly(e) { const s = this._hass && this._hass.states[e]; return (s && s.attributes.friendly_name) || e || ""; }
  _pos(e) {
    if (!e) return null;
    const p = this._pending[e];
    const s = this._hass && this._hass.states[e];
    const cur = s && typeof s.attributes.current_position === "number" ? s.attributes.current_position : null;
    if (p) {
      if (Date.now() > p.until || (cur !== null && Math.abs(cur - p.pos) <= 3)) delete this._pending[e];
      else return p.pos;
    }
    return cur;
  }
  _pane(p) { // -> {t, b} in % from the top of the window, or null
    const top = p.top ? this._pos(p.top) : 0;
    const bot = this._pos(p.bottom);
    if (top === null || bot === null) return null;
    return { t: top, b: Math.max(top + 1, 100 - bot) };
  }
  _doorOpen(r) { const d = r.cfg.door && this._hass && this._hass.states[r.cfg.door]; return !!(d && d.state === "on"); }
  _moving(r) {
    return r.panes.concat([r.both]).some(p => [p.top, p.bottom].some(e => { const s = e && this._hass.states[e]; return s && (s.state === "opening" || s.state === "closing"); }));
  }
  _status(r, ps) {
    const t = this._t;
    const missing = r.panes.concat([r.both]).flatMap(p => [p.top, p.bottom]).find(e => e && !this._hass.states[e]);
    if (missing) return t.missing(missing);
    if (ps.some(x => !x)) return t.unknown;
    if (this._moving(r)) return t.moving;
    if (ps.some(x => Math.abs(x.t - ps[0].t) > 4 || Math.abs(x.b - ps[0].b) > 4)) return t.differ;
    const cov = Math.round(ps[0].b - ps[0].t);
    if (ps[0].t <= 3 && cov >= 88) return t.isDown;
    if (cov <= 12) return t.isUp;
    return t.covered(cov);
  }
  _say(rid, text) {
    const el = this.shadowRoot.querySelector(rid === "hus" ? "[data-husmsg]" : `[data-msg="${rid}"]`);
    if (el) el.textContent = text;
    clearTimeout(this["_mt" + rid]);
    this["_mt" + rid] = setTimeout(() => { if (el) el.textContent = ""; }, 7000);
  }

  // ---------- drawing ----------
  _update() {
    if (!this._hass || !this.shadowRoot || !this._built) return;
    const root = this.shadowRoot, t = this._t;
    let down = 0; const open = [];
    this._rooms.forEach(r => {
      const ps = r.panes.map((p, i) => (this._drag && this._drag.r === r && this._drag.vals[i]) || this._pane(p));
      const st = this._status(r, ps);
      if (st === t.isDown) down++;
      const door = this._doorOpen(r);
      if (door) open.push(r.cfg.name || this._friendly(r.cfg.bottom || r.cfg.left_bottom));
      const eq = !ps.some(x => !x || Math.abs(x.t - ps[0].t) > 4 || Math.abs(x.b - ps[0].b) > 4);
      root.querySelectorAll(`[data-fb^="${r.id}|"]`).forEach(f => {
        const x = ps[+f.dataset.fb.split("|")[2]];
        f.style.top = (x ? x.t : 0) + "%"; f.style.height = (x ? x.b - x.t : 0) + "%";
      });
      root.querySelectorAll(`[data-rl^="${r.id}|"]`).forEach(l => {
        const [, i, w] = l.dataset.rl.split("|"); const x = ps[+i];
        l.hidden = eq || !x; if (x) l.style.top = `calc(${w === "t" ? x.t : x.b}% - ${w === "t" ? 0 : 3}px)`;
      });
      root.querySelectorAll(`[data-g^="${r.id}|"]`).forEach(g => {
        const [, tg, w] = g.dataset.g.split("|");
        const sel = (tg === "all" ? ps : [ps[+tg]]).filter(Boolean);
        if (!sel.length) return;
        const v = w === "t" ? Math.min(...sel.map(x => x.t)) : Math.max(...sel.map(x => x.b));
        g.style.top = v + "%"; g.classList.toggle("dim", tg === "all" && !eq);
        g.setAttribute("aria-valuenow", String(Math.round(w === "t" ? v : 100 - v)));
      });
      const stEl = root.querySelector(`[data-st="${r.id}"]`);
      if (stEl && !(this._drag && this._drag.r === r)) stEl.textContent = st;
      const pill = root.querySelector(`[data-door="${r.id}"]`); if (pill) pill.hidden = !door;
      root.querySelectorAll(`[data-k^="${r.id}|"]`).forEach(b => {
        const k = r.buttons[+b.dataset.k.split("|")[1]];
        const lock = door && this._buttonLowers(r, k);
        b.classList.toggle("lock", lock);
        b.querySelector("ha-icon").setAttribute("icon", lock ? "mdi:lock" : (k.icon || "mdi:blinds"));
      });
    });
    const hus = root.querySelector("[data-hus]");
    if (hus) hus.textContent = t.roomsDown(down, this._rooms.length) + (open.length ? ` · ${t.doorOpenList(open.join(", "))}` : "");
  }

  // ---------- actions ----------
  _call(domain, service, data) {
    if (this._config.debug) console.info("tdbu-blind-card", domain, service, data);
    return this._hass.callService(domain, service, data);
  }
  _flash(el) { el.classList.add("sent"); setTimeout(() => el.classList.remove("sent"), 1200); }
  _find(e, sel) { // walks composedPath, so clicks inside <ha-icon> (own shadow DOM) also count
    for (const n of e.composedPath()) { if (n === this.shadowRoot) break; if (n.matches && n.matches(sel)) return n; }
    return null;
  }
  _runEntity(entity, data) {
    if (!entity) return;
    const dom = entity.split(".")[0];
    if (dom === "automation") this._call("automation", "trigger", Object.assign({ entity_id: entity }, data || {}));
    else if (dom === "scene") this._call("scene", "turn_on", { entity_id: entity });
    else if (dom === "button" || dom === "input_button") this._call(dom, "press", { entity_id: entity });
    else this._call("script", "turn_on", Object.assign({ entity_id: entity }, data ? { variables: data } : {}));
  }
  // Does this button move a bottom rail down? Script/scene buttons say so with door_check: true.
  _buttonLowers(r, b) {
    if (b.door_check !== undefined) return !!b.door_check;
    if (!b.position || b.position.bottom === undefined || !r.doorPanes.length) return false;
    return r.doorPanes.some(i => { const cur = this._pos(r.panes[i].bottom); return cur === null || b.position.bottom < cur - 1; });
  }

  _onClick(e) {
    const el = this._find(e, "[data-k],[data-alle],[data-menu],[data-m]");
    const mn = this.shadowRoot.querySelector(".mn");
    if (!el) { if (mn) mn.hidden = true; return; }
    const t = this._t;
    if (el.dataset.menu !== undefined) { mn.hidden = !mn.hidden; return; }
    if (el.dataset.m !== undefined) {
      const m = this._config.menu[+el.dataset.m]; mn.hidden = true;
      this._runEntity(m.entity, m.data);
      this._say("hus", t.started(m.name || m.entity));
      return;
    }
    if (el.dataset.alle) {
      const up = el.dataset.alle === "up";
      this._runEntity(up ? this._config.all_up : this._config.all_down);
      this._flash(el);
      const skip = up ? [] : this._rooms.filter(r => this._doorOpen(r)).map(r => r.cfg.name || this._friendly(r.cfg.bottom || r.cfg.left_bottom));
      this._say("hus", skip.length ? t.skipped(skip.join(", ")) : (up ? t.allGoingUp : t.allGoingDown));
      return;
    }
    const [rid, i] = el.dataset.k.split("|");
    const r = this._rooms.find(x => x.id === rid); const b = r.buttons[+i];
    if (this._doorOpen(r) && this._buttonLowers(r, b)) { this._say(rid, t.doorBlocked); return; }
    if (b.action === "stop") {
      new Set(r.panes.concat([r.both]).flatMap(p => [p.top, p.bottom]).filter(Boolean))
        .forEach(ent => this._call("cover", "stop_cover", { entity_id: ent }));
    } else if (b.position) {
      const tgt = this._targets(r);
      if (b.position.top !== undefined) tgt.top.forEach(ent => this._call("cover", "set_cover_position", { entity_id: ent, position: +b.position.top }));
      if (b.position.bottom !== undefined) tgt.bottom.forEach(ent => this._call("cover", "set_cover_position", { entity_id: ent, position: +b.position.bottom }));
    } else {
      this._runEntity(b.script || b.entity, b.data);
    }
    this._flash(el);
  }
  // Entities to move for the whole room: the "Both" group if given, otherwise each blind.
  _targets(r) {
    const pick = key => r.both[key] ? [r.both[key]] : r.panes.map(p => p[key]).filter(Boolean);
    return { top: pick("top"), bottom: pick("bottom") };
  }

  _onDown(e) {
    const g = this._find(e, "[data-g]"); if (!g) return;
    const [rid, tg, w] = g.dataset.g.split("|");
    const r = this._rooms.find(x => x.id === rid);
    const idx = tg === "all" ? r.panes.map((_, i) => i) : [+tg];
    const cur = r.panes.map(p => this._pane(p));
    if (idx.some(i => !cur[i])) return;
    const fr = this.shadowRoot.querySelector(`[data-fr="${rid}|${tg}"]`);
    this._drag = { r, tg, w, idx, rect: fr.getBoundingClientRect(), start: cur.map(x => x && { ...x }), vals: cur.map(x => x && { ...x }), blocked: false };
    try { g.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events without an active pointer */ }
    this.shadowRoot.querySelector(`[data-rum="${rid}"]`).classList.add("dragging");
    e.preventDefault();
  }

  _apply(v) { // move the rail to v (% from the top) for the chosen blinds, respecting door and gap limits
    const d = this._drag, r = d.r;
    const door = this._doorOpen(r) ? r.doorPanes.filter(i => d.idx.includes(i)) : [];
    if (d.w === "t") {
      v = Math.max(0, Math.min(v, ...d.idx.map(i => d.vals[i].b - GAP)));
      d.idx.forEach(i => { d.vals[i].t = v; });
    } else {
      v = Math.min(100, Math.max(v, ...d.idx.map(i => d.vals[i].t + GAP)));
      if (door.length) {
        const limit = Math.min(...door.map(i => d.start[i].b));
        if (v > limit) { v = limit; if (!d.blocked) { d.blocked = true; this._say(r.id, this._t.doorBlocked); } }
      }
      d.idx.forEach(i => { d.vals[i].b = v; });
    }
    return v;
  }

  _onMove(e) {
    const d = this._drag; if (!d) return;
    this._apply(Math.round((e.clientY - d.rect.top) / d.rect.height * 100));
    this._update();
    const t = this._t;
    const st = this.shadowRoot.querySelector(`[data-st="${d.r.id}"]`);
    const who = d.tg === "all" ? (d.r.split ? t.both : "") : (d.r.panes[+d.tg].name || (+d.tg ? t.right : t.left));
    const cov = Math.round(d.vals[d.idx[0]].b - d.vals[d.idx[0]].t);
    if (st) st.textContent = `${d.w === "t" ? t.topRail : t.bottomRail}${who ? " · " + who.toLowerCase() : ""} · ${t.covered(cov)}`;
  }

  _onUp(e, cancel) {
    const d = this._drag; if (!d) return;
    this._drag = null;
    this.shadowRoot.querySelector(`[data-rum="${d.r.id}"]`).classList.remove("dragging");
    if (!cancel) this._send(d);
    this._update();
  }

  _send(d) {
    const r = d.r, i0 = d.idx[0];
    const moved = d.idx.some(i => Math.abs(d.w === "t" ? d.vals[i].t - d.start[i].t : d.vals[i].b - d.start[i].b) >= 1);
    if (!moved) return;
    let pos;
    if (d.w === "t") pos = Math.round(d.vals[i0].t);
    else pos = d.vals[i0].b <= Math.max(...d.idx.map(i => d.vals[i].t)) + GAP + 1 ? 100 : Math.round(100 - d.vals[i0].b);
    const key = d.w === "t" ? "top" : "bottom";
    const lower = d.w === "b" && d.idx.some(i => d.vals[i].b > d.start[i].b + 0.5);
    if (lower && this._doorOpen(r) && r.doorPanes.some(i => d.idx.includes(i))) { this._say(r.id, this._t.doorBlocked); return; }
    const targets = d.tg === "all" ? this._targets(r)[key] : [r.panes[i0][key]].filter(Boolean);
    targets.forEach(ent => this._call("cover", "set_cover_position", { entity_id: ent, position: pos }));
    d.idx.forEach(i => { const ent = r.panes[i][key]; if (ent) this._pending[ent] = { pos, until: Date.now() + PENDING_MS }; });
  }

  _onKey(e) {
    const t = e.composedPath()[0];
    if (!t.dataset || !t.dataset.g || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const [rid, tg, w] = t.dataset.g.split("|");
    const r = this._rooms.find(x => x.id === rid);
    const idx = tg === "all" ? r.panes.map((_, i) => i) : [+tg];
    const cur = r.panes.map(p => this._pane(p)); if (idx.some(i => !cur[i])) return;
    this._drag = { r, tg, w, idx, rect: null, start: cur.map(x => x && { ...x }), vals: cur.map(x => x && { ...x }), blocked: false };
    const base = w === "t" ? Math.min(...idx.map(i => cur[i].t)) : Math.max(...idx.map(i => cur[i].b));
    this._apply(base + (e.key === "ArrowDown" ? 5 : -5));
    const d = this._drag; this._drag = null; this._send(d); this._update();
  }
}

TdbuBlindCard.css = `
:host{display:block;--gl:color-mix(in srgb,var(--primary-color,#03a9f4) 16%,var(--card-background-color,#fff));
  --fab:var(--tdbu-fabric-color,color-mix(in srgb,#c8935a 40%,var(--card-background-color,#fff)));--frm:color-mix(in srgb,var(--primary-text-color,#222) 42%,transparent);
  --rail:color-mix(in srgb,var(--primary-text-color,#222) 72%,transparent);--soft:color-mix(in srgb,var(--primary-text-color,#222) 6%,transparent);
  --warn:var(--warning-color,#ffa600)}
ha-card{padding:14px 16px}
.hus{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ico{width:38px;height:38px;border-radius:50%;background:var(--soft);display:flex;align-items:center;justify-content:center;color:var(--secondary-text-color);flex:none;--mdc-icon-size:20px}
.tt{flex:1;min-width:150px}.nm{font-size:15px;font-weight:500;color:var(--primary-text-color)}
.hus .tt{min-width:120px}
.st{font-size:12px;color:var(--secondary-text-color);min-height:16px}
.hd{display:flex;align-items:center;gap:10px}
.pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:8px;color:var(--warn);background:color-mix(in srgb,var(--warn) 16%,transparent);--mdc-icon-size:14px}
.pill[hidden],.rl[hidden],.mn[hidden]{display:none}
.floor{display:flex;align-items:center;gap:8px;margin:20px 4px 8px;font-size:16px;font-weight:500;color:var(--primary-text-color);--mdc-icon-size:20px}
.floor ha-icon{color:var(--secondary-text-color)}
.rooms{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(290px,100%),1fr));gap:12px}
.rooms>*{min-width:0}
.rooms.single{grid-template-columns:minmax(0,1fr)}
.win{display:flex;gap:12px;margin-top:14px;align-items:flex-start;justify-content:center}
.col{display:flex;flex-direction:column;align-items:center}
.sep{width:1px;align-self:stretch;background:var(--divider-color,rgba(0,0,0,.12));margin:0 2px}
.fr{position:relative;height:124px;border:2px solid var(--frm);border-radius:4px;display:flex;gap:3px;background:var(--frm);touch-action:none}
.sill{height:4px;border-radius:2px;background:var(--frm);margin-top:3px}
.pn{position:relative;flex:1;background:var(--gl);overflow:hidden}
.fb{position:absolute;left:0;right:0;background:var(--fab);transition:top .45s,height .45s}
.dragging .fb{transition:none}
.rl{position:absolute;left:0;right:0;height:3px;background:var(--rail);pointer-events:none}
.gr{position:absolute;left:-7px;right:-7px;height:22px;margin-top:-10px;cursor:ns-resize;touch-action:none;display:flex;align-items:center;justify-content:center;outline:none}
.gr span{display:block;width:100%;height:4px;border-radius:2px;background:var(--rail)}
.gr b{position:absolute;width:24px;height:11px;border-radius:6px;background:var(--card-background-color,#fff);border:1.5px solid var(--rail)}
.gr:focus-visible b{border-color:var(--primary-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--primary-color) 35%,transparent)}
.gr.dim{opacity:.45}
.lb{font-size:11px;color:var(--secondary-text-color);margin-top:5px;min-height:14px}
.seg{display:flex;border:1px solid var(--divider-color,rgba(0,0,0,.12));border-radius:10px;overflow:hidden;margin-top:14px}
.hseg{margin-top:0}
.kn{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:4px;min-height:36px;padding:0 4px;border:none;background:none;color:var(--primary-text-color);font:inherit;font-size:12.5px;cursor:pointer;--mdc-icon-size:17px;white-space:nowrap}
.kn+.kn{border-left:1px solid var(--divider-color,rgba(0,0,0,.12))}
.kn:hover{background:var(--soft)}
.kn.sent{background:color-mix(in srgb,var(--primary-color) 16%,transparent)}
.kn.lock{color:var(--secondary-text-color)}
.kn span{overflow:hidden;text-overflow:ellipsis}
.smal .kn:not(.lock) ha-icon{display:none}
.hseg .kn{flex:none;padding:0 12px}
.msg{font-size:12px;color:var(--warn);min-height:16px;margin-top:6px}
.husmsg{margin:4px 4px 0}
.mw{position:relative}
.dots{border:none;background:none;color:var(--secondary-text-color);cursor:pointer;padding:6px;border-radius:50%;--mdc-icon-size:20px}
.dots:hover{background:var(--soft)}
.mn{position:absolute;right:0;top:38px;z-index:5;min-width:220px;background:var(--card-background-color,#fff);border:1px solid var(--divider-color,rgba(0,0,0,.12));border-radius:10px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.18)}
.mi{display:flex;align-items:center;gap:8px;width:100%;border:none;background:none;color:var(--primary-text-color);font:inherit;font-size:13px;padding:8px 10px;border-radius:8px;cursor:pointer;--mdc-icon-size:18px;text-align:left}
.mi:hover{background:var(--soft)}
`;

/* ======================================================================================
 * Visual editor
 * ====================================================================================== */

const ED = {
  en: {
    general: "General", title: "Header title", show_header: "Show whole-house header", all_up: "All up (script or scene)",
    all_down: "All down (script or scene)", rooms: "Rooms", addRoom: "Add room", room: "Room", name: "Name", icon: "Icon",
    floor: "Floor", bottom: "Bottom rail – cover or cover group (both blinds)",
    top: "Top rail – cover or cover group (both blinds)", individual: "Two blinds in the window (optional)",
    left_bottom: "Left blind – bottom", left_top: "Left blind – top", right_bottom: "Right blind – bottom",
    right_top: "Right blind – top", door: "Door / window sensor", door_side: "Door is behind",
    side_both: "Both blinds", side_left: "Left blind", side_right: "Right blind", buttons: "Buttons",
    addButton: "Add button", defaults: "Use standard buttons (up · stop · down)", noButtons: "No buttons",
    btype: "Button does", t_script: "Run a script", t_scene: "Activate a scene", t_position: "Move to a position",
    t_stop: "Stop", script: "Script", scene: "Scene", pos_top: "Top rail", pos_top_help: "0 = rail at the top", pos_bottom: "Bottom rail",
    pos_bottom_help: "100 = blind fully up, 0 = fully down", door_side_help: "Only this side is stopped from going down",
    floor_help: "Rooms with the same floor are grouped under one heading", door_check: "Block when the door is open (moves the blind down)",
    up: "Move up", downMove: "Move down", remove: "Remove", legacy: "Settings from version 1 were found and converted. Saving stores them in the new format.",
    standardButtons: "Standard buttons are used: up, stop and down.",
  },
  da: {
    general: "Generelt", title: "Overskrift", show_header: "Vis linjen for hele huset", all_up: "Alle op (script eller scene)",
    all_down: "Alle ned (script eller scene)", rooms: "Rum", addRoom: "Tilføj rum", room: "Rum", name: "Navn", icon: "Ikon",
    floor: "Etage", bottom: "Nederste skinne – gardin eller gardingruppe (begge gardiner)",
    top: "Øverste skinne – gardin eller gardingruppe (begge gardiner)", individual: "To gardiner i vinduet (valgfrit)",
    left_bottom: "Venstre gardin – nederst", left_top: "Venstre gardin – øverst", right_bottom: "Højre gardin – nederst",
    right_top: "Højre gardin – øverst", door: "Dør- eller vinduessensor", door_side: "Døren sidder bag",
    side_both: "Begge gardiner", side_left: "Venstre gardin", side_right: "Højre gardin", buttons: "Knapper",
    addButton: "Tilføj knap", defaults: "Brug standardknapper (op · stop · ned)", noButtons: "Ingen knapper",
    btype: "Knappen skal", t_script: "Køre et script", t_scene: "Aktivere en scene", t_position: "Køre til en position",
    t_stop: "Stoppe", script: "Script", scene: "Scene", pos_top: "Øverste skinne", pos_top_help: "0 = skinnen helt oppe", pos_bottom: "Nederste skinne",
    pos_bottom_help: "100 = gardinet helt oppe, 0 = helt nede", door_side_help: "Kun den side stoppes i at køre ned",
    floor_help: "Rum med samme etage samles under én overskrift", door_check: "Spær når døren er åben (kører gardinet ned)",
    up: "Flyt op", downMove: "Flyt ned", remove: "Fjern", legacy: "Der blev fundet indstillinger fra version 1, og de er omsat. Når du gemmer, gemmes de i det nye format.",
    standardButtons: "Standardknapperne bruges: op, stop og ned.",
  },
};

async function ensureHaForm() {
  if (customElements.get("ha-form") && customElements.get("ha-entity-picker")) return;
  try {
    const helpers = await window.loadCardHelpers();
    const card = await helpers.createCardElement({ type: "entities", entities: [] });
    await card.constructor.getConfigElement();
  } catch (_) { /* older frontends load ha-form on their own */ }
}

class TdbuBlindCardEditor extends HTMLElement {
  setConfig(config) {
    if (this._lastFired && JSON.stringify(config) === this._lastFired) return; // our own change coming back
    const migrated = migrateLegacy(config);
    this._legacy = migrated !== config;
    this._config = JSON.parse(JSON.stringify(migrated || {}));
    if (!Array.isArray(this._config.rooms)) this._config.rooms = [];
    if (!this._open) this._open = new Set([0]);
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    this.shadowRoot && this.shadowRoot.querySelectorAll("ha-form").forEach(f => { f.hass = hass; });
  }
  connectedCallback() { ensureHaForm().then(() => this._render()); }

  get _t() {
    const l = String((this._hass && ((this._hass.locale && this._hass.locale.language) || this._hass.language)) || "en").slice(0, 2);
    return ED[l] || ED.en;
  }

  _fire() {
    if (this._legacy) { delete this._config.show_header; this._legacy = false; }
    const c = JSON.parse(JSON.stringify(this._config));
    this._lastFired = JSON.stringify(c);
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: c }, bubbles: true, composed: true }));
  }

  _form(data, schema, onChange) {
    const f = document.createElement("ha-form");
    f.hass = this._hass; f.data = data; f.schema = schema;
    f.computeLabel = s => this._t[s.name] || s.label || s.name;
    f.computeHelper = s => this._t[`${s.name}_help`];
    f.addEventListener("value-changed", ev => { ev.stopPropagation(); onChange(ev.detail.value); });
    return f;
  }

  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const t = this._t, c = this._config, root = this.shadowRoot;
    root.innerHTML = `<style>${TdbuBlindCardEditor.css}</style>
      ${this._legacy ? `<div class="note">${esc(t.legacy)}</div>` : ""}
      <div class="sec"><div class="h">${esc(t.general)}</div><div data-general></div></div>
      <div class="sec"><div class="h">${esc(t.rooms)}</div><div data-rooms></div>
        <button class="add" data-act="addRoom"><ha-icon icon="mdi:plus"></ha-icon>${esc(t.addRoom)}</button></div>`;

    const general = this._form(
      { title: c.title, show_header: c.show_header !== undefined ? c.show_header : c.rooms.length > 1, all_up: c.all_up, all_down: c.all_down },
      [
        { name: "title", selector: { text: {} } },
        { name: "show_header", selector: { boolean: {} } },
        { type: "grid", name: "", schema: [
          { name: "all_up", selector: { entity: { domain: ["script", "scene"] } } },
          { name: "all_down", selector: { entity: { domain: ["script", "scene"] } } },
        ] },
      ],
      v => { ["title", "all_up", "all_down"].forEach(k => { if (v[k]) c[k] = v[k]; else delete c[k]; }); c.show_header = !!v.show_header; this._fire(); });
    root.querySelector("[data-general]").appendChild(general);

    const list = root.querySelector("[data-rooms]");
    c.rooms.forEach((r, i) => list.appendChild(this._roomEl(r, i)));
    root.querySelector('[data-act="addRoom"]').addEventListener("click", () => {
      c.rooms.push({ name: `${t.room} ${c.rooms.length + 1}`, bottom: "" });
      this._open.add(c.rooms.length - 1); this._fire(); this._render();
    });
  }

  _roomEl(r, i) {
    const t = this._t, c = this._config;
    const det = document.createElement("details");
    det.open = this._open.has(i);
    det.addEventListener("toggle", () => { det.open ? this._open.add(i) : this._open.delete(i); });
    det.innerHTML = `<summary><ha-icon icon="${esc(r.icon || "mdi:blinds-horizontal")}"></ha-icon><span class="sn">${esc(r.name || `${t.room} ${i + 1}`)}</span>
      <span class="tools">
        <button data-act="up" title="${esc(t.up)}" ${i === 0 ? "disabled" : ""}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
        <button data-act="down" title="${esc(t.downMove)}" ${i === c.rooms.length - 1 ? "disabled" : ""}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
        <button data-act="del" title="${esc(t.remove)}"><ha-icon icon="mdi:delete-outline"></ha-icon></button></span></summary>
      <div class="body"><div data-form></div><div class="h2">${esc(t.buttons)}</div><div data-buttons></div>
      <div class="row"><button class="add" data-act="addBtn"><ha-icon icon="mdi:plus"></ha-icon>${esc(t.addButton)}</button>
      ${Array.isArray(r.buttons) ? `<button class="add" data-act="defaults"><ha-icon icon="mdi:restore"></ha-icon>${esc(t.defaults)}</button>` : ""}</div></div>`;

    const tools = (act, fn) => det.querySelector(`[data-act="${act}"]`).addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); fn(); });
    tools("up", () => { [c.rooms[i - 1], c.rooms[i]] = [c.rooms[i], c.rooms[i - 1]]; this._fire(); this._render(); });
    tools("down", () => { [c.rooms[i + 1], c.rooms[i]] = [c.rooms[i], c.rooms[i + 1]]; this._fire(); this._render(); });
    tools("del", () => { c.rooms.splice(i, 1); this._open.delete(i); this._fire(); this._render(); });

    const cover = { entity: { domain: "cover" } };
    const form = this._form(r, [
      { type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "icon", selector: { icon: {} } }] },
      { name: "floor", selector: { text: {} } },
      { name: "bottom", selector: cover },
      { name: "top", selector: cover },
      { type: "expandable", name: "individual", flatten: true, title: t.individual, expanded: !!(r.left_bottom || r.right_bottom), schema: [
        { type: "grid", name: "", schema: [{ name: "left_bottom", selector: cover }, { name: "right_bottom", selector: cover }] },
        { type: "grid", name: "", schema: [{ name: "left_top", selector: cover }, { name: "right_top", selector: cover }] },
      ] },
      { name: "door", selector: { entity: { domain: "binary_sensor" } } },
      { name: "door_side", selector: { select: { mode: "dropdown", options: [
        { value: "both", label: t.side_both }, { value: "left", label: t.side_left }, { value: "right", label: t.side_right }] } } },
    ], v => {
      const keep = r.buttons;
      Object.keys(r).forEach(k => delete r[k]);
      Object.entries(v).forEach(([k, val]) => { if (val !== "" && val !== undefined && val !== null) r[k] = val; });
      if (keep !== undefined) r.buttons = keep;
      det.querySelector(".sn").textContent = r.name || `${t.room} ${i + 1}`;
      this._fire();
    });
    det.querySelector("[data-form]").appendChild(form);

    const bl = det.querySelector("[data-buttons]");
    if (!Array.isArray(r.buttons)) bl.innerHTML = `<div class="hint">${esc(t.standardButtons)}</div>`;
    else if (!r.buttons.length) bl.innerHTML = `<div class="hint">${esc(t.noButtons)}</div>`;
    else r.buttons.forEach((b, j) => bl.appendChild(this._buttonEl(r, b, j)));
    tools("addBtn", () => {
      if (!Array.isArray(r.buttons)) r.buttons = DEFAULT_BUTTONS.map(b => ({ ...b, name: this._t[b.name.slice(1)] || b.name, ...(b.position ? { position: { ...b.position } } : {}) }));
      r.buttons.push({ name: "", icon: "mdi:blinds", script: "" });
      this._fire(); this._render();
    });
    if (Array.isArray(r.buttons)) tools("defaults", () => { delete r.buttons; this._fire(); this._render(); });
    return det;
  }

  _buttonEl(r, b, j) {
    const t = this._t;
    const type = b.action === "stop" ? "stop" : b.position ? "position" : (b.entity && b.entity.startsWith("scene.")) ? "scene" : "script";
    const box = document.createElement("div");
    box.className = "btn";
    box.innerHTML = `<div class="btools"><button data-b="up" ${j === 0 ? "disabled" : ""}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
      <button data-b="down" ${j === r.buttons.length - 1 ? "disabled" : ""}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
      <button data-b="del"><ha-icon icon="mdi:close"></ha-icon></button></div>`;
    const schema = [
      { type: "grid", name: "", schema: [{ name: "name", selector: { text: {} } }, { name: "icon", selector: { icon: {} } }] },
      { name: "btype", selector: { select: { mode: "dropdown", options: [
        { value: "script", label: t.t_script }, { value: "scene", label: t.t_scene },
        { value: "position", label: t.t_position }, { value: "stop", label: t.t_stop }] } } },
    ];
    if (type === "script") schema.push({ name: "script", selector: { entity: { domain: "script" } } });
    if (type === "scene") schema.push({ name: "scene", selector: { entity: { domain: "scene" } } });
    if (type === "position") schema.push({ type: "grid", name: "", schema: [
      { name: "pos_top", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
      { name: "pos_bottom", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } }] });
    if (type === "script" || type === "scene") schema.push({ name: "door_check", selector: { boolean: {} } });
    const data = { name: b.name, icon: b.icon, btype: type, script: b.script, scene: b.entity,
      pos_top: b.position && b.position.top, pos_bottom: b.position && b.position.bottom, door_check: !!b.door_check };
    const f = this._form(data, schema, v => {
      const nb = { name: v.name || "", icon: v.icon || "mdi:blinds" };
      if (v.btype === "stop") nb.action = "stop";
      else if (v.btype === "position") nb.position = { ...(v.pos_top !== undefined && v.pos_top !== "" ? { top: +v.pos_top } : {}), ...(v.pos_bottom !== undefined && v.pos_bottom !== "" ? { bottom: +v.pos_bottom } : {}) };
      else if (v.btype === "scene") { nb.entity = v.scene || ""; if (v.door_check) nb.door_check = true; }
      else { nb.script = v.script || ""; if (v.door_check) nb.door_check = true; }
      r.buttons[j] = nb;
      this._fire();
      if (v.btype !== type) this._render();
    });
    box.appendChild(f);
    const act = (k, fn) => box.querySelector(`[data-b="${k}"]`).addEventListener("click", ev => { ev.preventDefault(); fn(); this._fire(); this._render(); });
    act("up", () => { [r.buttons[j - 1], r.buttons[j]] = [r.buttons[j], r.buttons[j - 1]]; });
    act("down", () => { [r.buttons[j + 1], r.buttons[j]] = [r.buttons[j], r.buttons[j + 1]]; });
    act("del", () => { r.buttons.splice(j, 1); });
    return box;
  }
}

TdbuBlindCardEditor.css = `
:host{display:block}
.sec{margin-bottom:18px}
.h{font-weight:500;font-size:15px;margin:4px 0 8px;color:var(--primary-text-color)}
.h2{font-weight:500;font-size:14px;margin:14px 0 6px;color:var(--primary-text-color)}
.note{background:color-mix(in srgb,var(--warning-color,#ffa600) 15%,transparent);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px}
details{border:1px solid var(--divider-color,rgba(0,0,0,.12));border-radius:10px;margin-bottom:8px;background:var(--card-background-color)}
summary{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;list-style:none;--mdc-icon-size:20px;color:var(--primary-text-color)}
summary::-webkit-details-marker{display:none}
.sn{flex:1;font-weight:500}
.tools,.btools{display:flex;gap:2px}
.tools button,.btools button{border:none;background:none;cursor:pointer;color:var(--secondary-text-color);padding:4px;border-radius:50%;--mdc-icon-size:18px}
.tools button:hover,.btools button:hover{background:color-mix(in srgb,var(--primary-text-color) 8%,transparent)}
button[disabled]{opacity:.3;cursor:default}
.body{padding:4px 12px 12px}
.btn{border:1px dashed var(--divider-color,rgba(0,0,0,.2));border-radius:8px;padding:6px 10px 10px;margin-bottom:8px}
.btools{justify-content:flex-end}
.row{display:flex;gap:8px;flex-wrap:wrap}
.add{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--divider-color,rgba(0,0,0,.2));background:none;color:var(--primary-color);border-radius:18px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px;--mdc-icon-size:18px}
.add:hover{background:color-mix(in srgb,var(--primary-color) 8%,transparent)}
.hint{font-size:13px;color:var(--secondary-text-color);margin:2px 0 8px}
`;

if (!customElements.get("tdbu-blind-card")) customElements.define("tdbu-blind-card", TdbuBlindCard);
if (!customElements.get("tdbu-blind-card-editor")) customElements.define("tdbu-blind-card-editor", TdbuBlindCardEditor);
// Version 1 registered the card as "tdbu-mushroom-style-card". Keep that name working.
if (!customElements.get("tdbu-mushroom-style-card")) customElements.define("tdbu-mushroom-style-card", class extends TdbuBlindCard {});

window.customCards = window.customCards || [];
if (!window.customCards.some(c => c.type === "tdbu-blind-card")) {
  window.customCards.push({
    type: "tdbu-blind-card", name: "TDBU Blind Card", preview: true,
    description: "Top-down/bottom-up blinds: drag the rails, both blinds together or one at a time.",
    documentationURL: "https://github.com/WackeySSL/tdbu_blind_card",
  });
}
console.info(`%c TDBU-BLIND-CARD %c ${TDBU_VERSION} `, "color:#fff;background:#8a6a45;font-weight:700", "color:#8a6a45;background:#fff");
