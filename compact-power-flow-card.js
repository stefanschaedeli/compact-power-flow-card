/* compact-power-flow-card
 *
 * A compact, dependency-free power-flow card for Home Assistant:
 * PV / grid / house / battery nodes with animated flow paths, plus an
 * optional stacked column of the top current power consumers (filtered
 * the same way as power-pie-card) and the daily yield at the PV node.
 *
 * - Plain ES module: HTMLElement + Shadow DOM, no external libraries.
 * - No polling: re-renders only when a relevant entity changes.
 * - CSS/SVG animations only; flow speed AND line thickness scale with power.
 * - Lines are only visible while power is actually flowing.
 * - Theme-aware (uses HA energy/theme CSS variables with sane fallbacks).
 * - GUI-editable (ha-form based card editor).
 *
 * Config (all power sensors in W, magnitudes >= 0 per flow direction):
 *   type: custom:compact-power-flow-card
 *   entities:
 *     pv_total:          sensor  (total PV generation)            [required]
 *     pv_to_house:       sensor  (PV -> house flow)               [required]
 *     pv_to_battery:     sensor  (PV -> battery flow, charge)     [required]
 *     pv_to_grid:        sensor  (PV -> grid flow, export)        [required]
 *     battery_to_house:  sensor  (battery -> house, discharge)    [required]
 *     grid_to_house:     sensor  (grid -> house, import)          [required]
 *     battery_soc:       sensor  (%)                              [required]
 *     house:             sensor  (house consumption)              [required]
 *     daily_yield:       sensor  (optional; Wh/kWh/MWh auto-scaled by unit,
 *                                 shown as the PV sub-label)
 *   filter:              optional; include/exclude rules (power-pie-card
 *                        semantics) selecting the consumer sensors for the
 *                        stacked top-consumers column, e.g.
 *                          include: [{entity_id: "sensor.*_pwr*"}]
 *                          exclude: [{state: "< 1"}]
 *   max_consumers:       optional; 1-6 segments in the column (default 4)
 *   labels:              optional map to override labels, e.g.
 *     daily_yield: "today" / grid_import: "import"
 */

const VERSION = "0.3.1";

// Flows below this many watts count as "not flowing".
const THRESHOLD = 25;

// Consumer-column palette, shared with power-pie-card (CVD-safe hue order —
// do not reorder).
const PALETTE_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948"];
const PALETTE_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767"];

// Node geometry inside the 520x160 viewBox.
const NODE = {
  pv: { cx: 205, cy: 32, r: 26 },
  grid: { cx: 46, cy: 80, r: 26 },
  house: { cx: 362, cy: 80, r: 26 },
  battery: { cx: 205, cy: 128, r: 26 },
};

// Consumer column geometry (right of the house node).
const COL = { x: 394, w: 24, top: 12, bottom: 148, gap: 1.5, minSeg: 14, rx: 2 };

// Flow definitions; path d strings are generated from node coordinates.
// Direction of travel = path direction.
const FLOW_DEFS = [
  { key: "pv_to_house", from: "pv", to: "house", color: "solar" },
  // fromGap starts the path below PV's sub-label instead of at the ring edge
  { key: "pv_to_battery", from: "pv", to: "battery", color: "solar", fromGap: 16 },
  { key: "pv_to_grid", from: "pv", to: "grid", color: "solar" },
  { key: "grid_to_house", from: "grid", to: "house", color: "grid" },
  { key: "battery_to_house", from: "battery", to: "house", color: "battery" },
];

const ICONS = {
  pv: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  grid: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
  house: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  battery: "M7 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm13 3v4",
};

// Sub-label placement per node: battery sits beside the ring to keep the
// card flat; pv's sub doubles as the daily-yield readout.
const SUB_POS = {
  pv: 'y="38" text-anchor="middle"',
  grid: 'y="40" text-anchor="middle"',
  house: 'y="40" text-anchor="middle"',
  battery: 'x="-34" y="4" text-anchor="end"',
};

const REQUIRED = [
  "pv_total",
  "pv_to_house",
  "pv_to_battery",
  "pv_to_grid",
  "battery_to_house",
  "grid_to_house",
  "battery_soc",
  "house",
];

const DEFAULT_LABELS = {
  pv: "PV",
  grid: "Netz",
  house: "Haus",
  battery: "Batterie",
  grid_import: "Bezug",
  grid_export: "Einspeisung",
  battery_charge: "lädt",
  battery_discharge: "entlädt",
  daily_yield: "heute",
};

// --- filter helpers (ported verbatim from power-pie-card) ------------------

function globToRegExp(pattern) {
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    return new RegExp(pattern.slice(1, -1));
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function parseStateMatcher(spec) {
  const cmp = String(spec).match(/^\s*(<=|>=|<|>|=)\s*(-?[\d.]+)\s*$/);
  if (cmp) {
    const op = cmp[1];
    const ref = Number(cmp[2]);
    return (state) => {
      const v = Number(state);
      if (!isFinite(v)) return false;
      switch (op) {
        case "<": return v < ref;
        case ">": return v > ref;
        case "<=": return v <= ref;
        case ">=": return v >= ref;
        case "=": return v === ref;
      }
      return false;
    };
  }
  const literal = String(spec).toLowerCase();
  return (state) => String(state).toLowerCase() === literal;
}

function compileRule(rule) {
  const tests = [];
  if (rule.entity_id) {
    const re = globToRegExp(String(rule.entity_id));
    tests.push((id) => re.test(id));
  }
  if (rule.domain) {
    tests.push((id) => id.split(".")[0] === rule.domain);
  }
  if (rule.state !== undefined) {
    const match = parseStateMatcher(rule.state);
    tests.push((id, hass) => {
      const st = hass.states[id];
      return st !== undefined && match(st.state);
    });
  }
  if (rule.area) {
    const want = String(rule.area).toLowerCase();
    tests.push((id, hass) => {
      const reg = hass.entities && hass.entities[id];
      let areaId = reg && reg.area_id;
      if (!areaId && reg && reg.device_id && hass.devices) {
        const dev = hass.devices[reg.device_id];
        areaId = dev && dev.area_id;
      }
      if (!areaId) return false;
      if (areaId.toLowerCase() === want) return true;
      const area = hass.areas && hass.areas[areaId];
      return !!area && String(area.name).toLowerCase() === want;
    });
  }
  return (id, hass) => tests.every((t) => t(id, hass));
}

// Convert a state object's numeric value to watts using its unit.
function toWatts(value, unit) {
  const u = (unit || "").toLowerCase();
  if (u === "kw") return value * 1000;
  if (u === "mw") return value / 1000; // milliwatts
  return value; // W or unknown → assume W
}

// --- card -------------------------------------------------------------------

class CompactPowerFlowCard extends HTMLElement {
  static getStubConfig() {
    return {
      entities: {},
      filter: { include: [{ entity_id: "sensor.*_pwr*" }], exclude: [{ state: "< 1" }] },
      max_consumers: 4,
    };
  }

  static getConfigElement() {
    return document.createElement("compact-power-flow-card-editor");
  }

  setConfig(config) {
    if (!config.entities) {
      throw new Error("compact-power-flow-card: 'entities' is missing");
    }
    for (const key of REQUIRED) {
      if (!config.entities[key]) {
        throw new Error(`compact-power-flow-card: entities.${key} is missing`);
      }
    }
    this._config = { ...config };
    this._config.max_consumers = Math.min(
      Math.max(Number.isFinite(config.max_consumers) ? config.max_consumers : 4, 1), 6
    );
    this._labels = { ...DEFAULT_LABELS, ...(config.labels || {}) };
    const f = config.filter || {};
    this._include = (f.include || []).map(compileRule);
    this._exclude = (f.exclude || []).map(compileRule);
    this._lastStates = null;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const consumers = this._computeConsumers(hass);
    const dark = !!(hass.themes && hass.themes.darkMode);
    const snapshot =
      Object.values(this._config.entities)
        .map((id) => (hass.states[id] ? hass.states[id].state : "?"))
        .join("|") +
      "||" + consumers.map((c) => `${c.id}:${c.watts}`).join("|") +
      `||dark:${dark}`;
    if (snapshot === this._lastStates && this._built) return;
    this._lastStates = snapshot;
    if (!this._built) this._build();
    this._update(consumers, dark);
  }

  // Top current consumers via the include/exclude filter, sorted descending.
  _computeConsumers(hass) {
    if (!this._include.length) return [];
    const items = [];
    for (const id of Object.keys(hass.states)) {
      if (!this._include.some((rule) => rule(id, hass))) continue;
      if (this._exclude.some((rule) => rule(id, hass))) continue;
      const st = hass.states[id];
      const raw = Number(st.state);
      if (!isFinite(raw)) continue;
      const watts = toWatts(raw, st.attributes.unit_of_measurement);
      if (watts <= 0) continue;
      items.push({ id, name: st.attributes.friendly_name || id, watts });
    }
    items.sort((a, b) => b.watts - a.watts);
    return items.slice(0, this._config.max_consumers);
  }

  _num(key) {
    const id = this._config.entities[key];
    if (!id || !this._hass.states[id]) return null;
    const v = parseFloat(this._hass.states[id].state);
    return Number.isFinite(v) ? v : null;
  }

  _fmtW(w) {
    if (w === null) return "–";
    if (Math.abs(w) >= 1000) {
      return `${(w / 1000).toFixed(w >= 10000 ? 1 : 2)} kW`;
    }
    return `${Math.round(w)} W`;
  }

  // Straight edge-to-edge path between two node circles, leaving a 4px gap.
  _flowPath(f) {
    const a = NODE[f.from];
    const b = NODE[f.to];
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const len = Math.hypot(dx, dy);
    const ux = dx / len;
    const uy = dy / len;
    const x1 = a.cx + ux * (a.r + (f.fromGap || 4));
    const y1 = a.cy + uy * (a.r + (f.fromGap || 4));
    const x2 = b.cx - ux * (b.r + 4);
    const y2 = b.cy - uy * (b.r + 4);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const flowPaths = FLOW_DEFS
      .map((f) => {
        const d = this._flowPath(f);
        return `
        <path id="rail-${f.key}" class="rail" d="${d}"/>
        <path id="flow-${f.key}" class="flow ${f.color}" d="${d}"/>`;
      })
      .join("");
    const nodes = Object.entries(NODE)
      .map(
        ([k, n]) => `
        <g class="node" id="node-${k}" transform="translate(${n.cx},${n.cy})">
          <circle class="ring ${k}" r="${n.r}"/>
          <path class="icon" d="${ICONS[k]}" transform="translate(-9,-14) scale(0.75)"/>
          <text class="value" id="val-${k}" y="10" text-anchor="middle"></text>
          <text class="sub" id="sub-${k}" ${SUB_POS[k]}></text>
        </g>`
      )
      .join("");
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { height: 100%; display: flex; flex-direction: column;
                  justify-content: center; padding: 6px 12px; box-sizing: border-box; }
        svg { width: 100%; height: auto; display: block; }
        .rail { fill: none; stroke: var(--divider-color, rgba(120,120,120,.3));
                stroke-width: 2; opacity: 0; transition: opacity .3s; }
        .rail.active { opacity: 1; }
        .flow { fill: none; stroke-width: 3; stroke-linecap: round;
                stroke-dasharray: 5 11; opacity: 0; transition: opacity .3s; }
        .flow.active { opacity: 1; animation: dash linear infinite; }
        @keyframes dash { to { stroke-dashoffset: -16; } }
        .flow.solar { stroke: var(--energy-solar-color, #ff9800); }
        .flow.grid { stroke: var(--energy-grid-consumption-color, #488fc2); }
        .flow.battery { stroke: var(--energy-battery-out-color, #4caf50); }
        .ring { fill: var(--card-background-color, none);
                stroke-width: 2.5; }
        .ring.pv { stroke: var(--energy-solar-color, #ff9800); }
        .ring.grid { stroke: var(--energy-grid-consumption-color, #488fc2); }
        .ring.house { stroke: var(--primary-color, #03a9f4); }
        .ring.battery { stroke: var(--energy-battery-out-color, #4caf50); }
        .icon { fill: none; stroke: var(--secondary-text-color, #727272);
                stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
                opacity: .8; transform-box: fill-box; }
        .value { font: 700 12px sans-serif; fill: var(--primary-text-color, #212121); }
        .sub { font: 400 10px sans-serif; fill: var(--secondary-text-color, #727272); }
        .seg { cursor: pointer; }
        .seg-name { font: 400 9px sans-serif; fill: var(--secondary-text-color, #727272);
                    cursor: pointer; }
        .seg-val { font: 600 9px sans-serif; fill: var(--primary-text-color, #212121);
                   cursor: pointer; }
      </style>
      <ha-card>
        <svg viewBox="0 0 520 160" preserveAspectRatio="xMidYMid meet"
             role="img" aria-label="Power flow">
          ${flowPaths}
          ${nodes}
          <g id="consumers"></g>
        </svg>
      </ha-card>`;
    this.shadowRoot.getElementById("consumers").addEventListener("click", (ev) => {
      const entityId = ev.target && ev.target.dataset && ev.target.dataset.entity;
      if (!entityId) return;
      this.dispatchEvent(new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }));
    });
    this._built = true;
  }

  // Segment heights: proportional to watts within the column, but never
  // below COL.minSeg so every segment keeps a readable label.
  _segmentHeights(items) {
    const n = items.length;
    const H = COL.bottom - COL.top - COL.gap * (n - 1);
    const heights = new Array(n).fill(0);
    let flex = items.map((_, i) => i);
    for (let pass = 0; pass < n; pass++) {
      const flexH = H - (n - flex.length) * COL.minSeg;
      const flexSum = flex.reduce((s, i) => s + items[i].watts, 0);
      const small = flex.filter((i) => (flexH * items[i].watts) / flexSum < COL.minSeg);
      if (!small.length) {
        for (const i of flex) heights[i] = (flexH * items[i].watts) / flexSum;
        break;
      }
      for (const i of small) heights[i] = COL.minSeg;
      flex = flex.filter((i) => !small.includes(i));
      if (!flex.length) break;
    }
    return heights;
  }

  _renderConsumers(consumers, dark) {
    const g = this.shadowRoot.getElementById("consumers");
    if (!g) return;
    const palette = dark ? PALETTE_DARK : PALETTE_LIGHT;
    if (!consumers.length) {
      g.innerHTML = "";
      return;
    }
    const heights = this._segmentHeights(consumers);
    const parts = [];
    let yBottom = COL.bottom;
    consumers.forEach((c, i) => {
      const h = heights[i];
      const top = yBottom - h;
      const cy = top + h / 2 + 3; // text baseline ≈ vertical center
      const name = c.name.length > 11 ? `${c.name.slice(0, 10)}…` : c.name;
      const color = palette[i % palette.length];
      parts.push(`
        <rect class="seg" data-entity="${c.id}" x="${COL.x}" y="${top.toFixed(1)}"
              width="${COL.w}" height="${h.toFixed(1)}" rx="${COL.rx}" fill="${color}"/>
        <text data-entity="${c.id}" x="${COL.x + COL.w + 6}" y="${cy.toFixed(1)}"
              text-anchor="start"><tspan class="seg-name" data-entity="${c.id}">${name}</tspan><tspan
              class="seg-val" data-entity="${c.id}" dx="4">${this._fmtW(c.watts)}</tspan></text>`);
      yBottom = top - COL.gap;
    });
    g.innerHTML = parts.join("");
  }

  _update(consumers, dark) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const flows = {};
    for (const f of FLOW_DEFS) {
      const w = this._num(f.key) || 0;
      flows[f.key] = w;
      const flowEl = $(`flow-${f.key}`);
      const railEl = $(`rail-${f.key}`);
      if (w > THRESHOLD) {
        // thickness ~ sqrt(power), 1.5px at the threshold up to 6px at >= 5 kW
        const width = 1.5 + 4.5 * Math.sqrt(Math.min(1, w / 5000));
        flowEl.classList.add("active");
        railEl.classList.add("active");
        flowEl.style.strokeWidth = width.toFixed(2);
        railEl.style.strokeWidth = width.toFixed(2);
        // faster dashes for bigger flows: 4s at ~50 W down to 0.8s at >= 5 kW
        const dur = Math.max(0.8, 4 - 3.2 * Math.min(1, w / 5000));
        flowEl.style.animationDuration = `${dur.toFixed(2)}s`;
      } else {
        flowEl.classList.remove("active");
        railEl.classList.remove("active");
      }
    }

    const pv = this._num("pv_total");
    const house = this._num("house");
    const soc = this._num("battery_soc");
    const batNet = flows.pv_to_battery - flows.battery_to_house;
    const gridNet = flows.grid_to_house; // import; export shown at PV->grid flow

    $("val-pv").textContent = this._fmtW(pv);
    $("val-house").textContent = this._fmtW(house);
    $("sub-house").textContent = this._labels.house;
    $("val-grid").textContent = this._fmtW(
      this._num("pv_to_grid") > gridNet ? this._num("pv_to_grid") : gridNet
    );
    $("sub-grid").textContent =
      this._num("pv_to_grid") > gridNet
        ? this._labels.grid_export
        : this._labels.grid_import;
    $("val-battery").textContent = soc === null ? "–" : `${Math.round(soc)} %`;
    $("sub-battery").textContent =
      Math.abs(batNet) > THRESHOLD
        ? `${batNet > 0 ? this._labels.battery_charge : this._labels.battery_discharge} ${this._fmtW(Math.abs(batNet))}`
        : this._labels.battery;

    const yieldRaw = this._num("daily_yield");
    if (yieldRaw !== null) {
      const st = this._hass.states[this._config.entities.daily_yield];
      const unit = (st.attributes.unit_of_measurement || "kWh").toLowerCase();
      const kwh =
        unit === "wh" ? yieldRaw / 1000 : unit === "mwh" ? yieldRaw * 1000 : yieldRaw;
      $("sub-pv").textContent = `${this._labels.daily_yield} ${kwh.toFixed(1)} kWh`;
    } else {
      $("sub-pv").textContent = this._labels.pv;
    }

    this._renderConsumers(consumers, dark);
  }

  getCardSize() {
    return 3;
  }

  getGridOptions() {
    return { columns: 12, rows: 3, min_rows: 2, min_columns: 6 };
  }
}

customElements.define("compact-power-flow-card", CompactPowerFlowCard);

// --- GUI editor --------------------------------------------------------------
//
// Uses HA's native ha-form + selectors (same pattern as power-pie-card).
// The common filter case (one include glob + one "hide below N W" exclude)
// gets first-class GUI fields; anything more complex falls back to an object
// (YAML) sub-editor for just the filter.

const ENTITY_KEYS = [...REQUIRED, "daily_yield"];

const EDITOR_LABELS = {
  pv_total: "PV total power",
  pv_to_house: "PV → house power",
  pv_to_battery: "PV → battery power (charge)",
  pv_to_grid: "PV → grid power (export)",
  battery_to_house: "Battery → house power (discharge)",
  grid_to_house: "Grid → house power (import)",
  battery_soc: "Battery state of charge (%)",
  house: "House consumption",
  daily_yield: "Daily yield (optional, shown at PV node)",
  filter_pattern: "Consumer entities matching (glob, e.g. *_pwr*)",
  filter_min: "Hide consumers below (W)",
  filter: "Consumer filter (advanced — too complex for the simple fields)",
  max_consumers: "Max consumers in the column",
  labels: "Label overrides (advanced)",
};

class CompactPowerFlowCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._initialized = false;
  }

  setConfig(config) {
    this._config = { ...config };
    this._analyzeFilter();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  // Simple-filter detection: at most one include rule using only entity_id
  // (+ optional domain, kept as passthrough), and at most one exclude rule
  // of the form {state: "< N"}.
  _analyzeFilter() {
    const f = this._config.filter;
    this._simpleFilter = true;
    this._includeExtra = {};
    this._pattern = "";
    this._min = undefined;
    if (!f) return;
    const inc = f.include || [];
    const exc = f.exclude || [];
    if (inc.length > 1 || exc.length > 1) { this._simpleFilter = false; return; }
    if (inc.length === 1) {
      const rule = { ...inc[0] };
      const { entity_id, domain, ...rest } = rule;
      if (Object.keys(rest).length || !entity_id) { this._simpleFilter = false; return; }
      this._pattern = entity_id;
      if (domain) this._includeExtra.domain = domain;
    }
    if (exc.length === 1) {
      const rule = { ...exc[0] };
      const keys = Object.keys(rule);
      const m = keys.length === 1 && keys[0] === "state" &&
        String(rule.state).match(/^\s*<\s*(-?[\d.]+)\s*$/);
      if (!m) { this._simpleFilter = false; return; }
      this._min = Number(m[1]);
    }
  }

  async _ensureHaForm() {
    if (customElements.get("ha-form")) return;
    // Force HA to register ha-form + selectors by loading a built-in
    // card editor once (standard custom-card technique).
    const helpers = await window.loadCardHelpers?.();
    if (helpers) {
      const card = await helpers.createCardElement({ type: "entities", entities: [] });
      await card.constructor.getConfigElement?.();
    }
    await customElements.whenDefined("ha-form");
  }

  async _render() {
    if (!this._initialized) {
      this._initialized = true;
      const style = document.createElement("style");
      style.textContent = ":host { display: block; } ha-form { display: block; }";
      this._mount = document.createElement("div");
      this.shadowRoot.append(style, this._mount);
      await this._ensureHaForm();
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this._mount.append(this._form);
    }
    if (!this._form) return;

    const c = this._config;
    const schema = ENTITY_KEYS.map((k) => ({
      name: k,
      selector: { entity: { domain: "sensor" } },
    }));
    if (this._simpleFilter) {
      schema.push(
        { name: "filter_pattern", selector: { text: {} } },
        { name: "filter_min", selector: { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "W" } } },
      );
    } else {
      schema.push({ name: "filter", selector: { object: {} } });
    }
    schema.push(
      { name: "max_consumers", selector: { number: { min: 1, max: 6, step: 1, mode: "box" } } },
      { name: "labels", selector: { object: {} } },
    );

    const data = {};
    const ents = c.entities || {};
    for (const k of ENTITY_KEYS) if (ents[k] !== undefined) data[k] = ents[k];
    if (this._simpleFilter) {
      if (this._pattern) data.filter_pattern = this._pattern;
      if (this._min !== undefined) data.filter_min = this._min;
    } else if (c.filter !== undefined) {
      data.filter = c.filter;
    }
    if (c.max_consumers !== undefined) data.max_consumers = c.max_consumers;
    if (c.labels !== undefined) data.labels = c.labels;

    this._form.schema = schema;
    this._form.data = data;
    if (this._hass) this._form.hass = this._hass;
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    const d = ev.detail.value || {};
    const cfg = { ...this._config };
    const entities = {};
    for (const k of ENTITY_KEYS) {
      if (d[k] !== undefined && d[k] !== "") entities[k] = d[k];
    }
    cfg.entities = entities;
    if (this._simpleFilter) {
      const include = [];
      if (d.filter_pattern) include.push({ ...this._includeExtra, entity_id: d.filter_pattern });
      const exclude = [];
      if (typeof d.filter_min === "number" && d.filter_min > 0) {
        exclude.push({ state: `< ${d.filter_min}` });
      }
      if (include.length || exclude.length) cfg.filter = { include, exclude };
      else delete cfg.filter;
    } else if (d.filter !== undefined) {
      cfg.filter = d.filter;
    }
    if (d.max_consumers === undefined || d.max_consumers === "") delete cfg.max_consumers;
    else cfg.max_consumers = d.max_consumers;
    if (d.labels === undefined || (d.labels && !Object.keys(d.labels).length)) delete cfg.labels;
    else cfg.labels = d.labels;
    this._config = cfg;
    this._analyzeFilter();
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: cfg },
      bubbles: true,
      composed: true,
    }));
  }
}

customElements.define("compact-power-flow-card-editor", CompactPowerFlowCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "compact-power-flow-card",
  name: "Compact Power Flow Card",
  description: "Compact animated power flow (PV, battery, grid, house) with a top-consumers column",
  documentationURL: "https://github.com/stefanschaedeli/compact-power-flow-card",
});

console.info(
  `%c COMPACT-POWER-FLOW-CARD %c v${VERSION} `,
  "background:#488fc2;color:#fff;padding:2px 4px;border-radius:3px 0 0 3px",
  "background:#333;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0"
);
