/* compact-power-flow-card
 *
 * A compact, dependency-free power-flow card for Home Assistant:
 * PV / grid / house / battery nodes with animated flow paths, plus an
 * optional stacked column of the top current power consumers (filtered
 * the same way as power-pie-card) and the daily yield at the PV node.
 * The house node and that consumer column read as one unit: a rounded
 * panel groups them, with consumer names left- and watts right-aligned.
 *
 * - Plain ES module: HTMLElement + Shadow DOM, no external libraries.
 * - No polling loops: hass updates coalesce onto a 2 s render tick, and the
 *   card only touches the DOM when a DISPLAYED value actually changes —
 *   sensor jitter below display resolution causes zero work.
 * - No animation (kiosk-friendly): each flow is a static line with a small
 *   direction arrow at its midpoint. Line thickness scales with power,
 *   relative to the largest flow currently running; flow styling (thickness,
 *   active set) updates at most every 5 s. Lines are only visible while
 *   power is actually flowing.
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
 *   line_boldness:       optional; 1-5 (default 2) — max flow-line width,
 *                        6+(b-1)*1.5 px. Thickness is RELATIVE: the biggest
 *                        flow on screen draws at that width and the rest
 *                        scale against it (sqrt curve), capped by absolute
 *                        power so a lone small flow still renders small
 *   flow_threshold:      optional; W below which a flow counts as idle
 *                        (default 25; also gates the battery direction word)
 *   pv_threshold:        optional; W below which the PV node dims (default 50)
 *   show_labels:         optional; false hides all node sub-labels (names,
 *                        direction words, daily yield) for an icons+numbers
 *                        only look (default true)
 *   uniform_color:       optional; one CSS color (hex, rgb(), var(--...))
 *                        applied to ALL node rings and flow lines instead of
 *                        the per-node theme colors. Unset = default colors.
 *                        The consumer column keeps its own palette unless
 *                        uniform_bars is set.
 *   uniform_bars:        optional; true paints every consumer bar segment in
 *                        uniform_color as well, killing the palette
 *                        differentiation entirely (no effect while
 *                        uniform_color is unset; default false)
 *   labels:              optional map overriding the auto-localized labels
 *                        (pv, grid, house, battery, grid_import, grid_export,
 *                        battery_charge, battery_discharge, daily_yield —
 *                        each editable individually in the GUI editor).
 *                        Labels auto-localize from hass.language, covering
 *                        en/de/fr/it/es/nl/pt/no/da/fi (falls back to
 *                        English otherwise); `labels` overrides win on top.
 *
 * The battery ring doubles as the SOC gauge: full circle = 100 %, the arc
 * drains counter-clockwise from 12 o'clock; the ring center shows the
 * current charge/discharge power (no percentage is displayed).
 */

const VERSION = "0.13.0";

// Consumer-column palette, shared with power-pie-card (CVD-safe hue order —
// do not reorder).
const PALETTE_LIGHT = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948"];
const PALETTE_DARK = ["#3987e5", "#199e70", "#c98500", "#008300", "#9085e9", "#e66767"];

// Node geometry inside the 520x160 viewBox. The generation side (grid, pv,
// battery) is packed into the left ~45% so the house + consumer panel can
// take the rest: consumer names are the content that actually needs width.
const NODE = {
  // pv/battery sit at the exact midpoint between grid and house (64px of
  // clear ring-to-ring gap on either side), so the generation side reads as
  // one evenly spaced group rather than drifting toward the panel
  pv: { cx: 160, cy: 32, r: 27 },
  grid: { cx: 42, cy: 80, r: 27 },
  // centred in the panel's left region (17px clear either side of the ring)
  house: { cx: 278, cy: 80, r: 27 },
  battery: { cx: 160, cy: 128, r: 27 },
};

// Narrowest an active flow line ever draws (SVG units). The smallest flow on
// screen still has to read as a line, not a hairline.
const MIN_FLOW_W = 1.5;

// Render cadence. hass pushes a new state object for every state change
// anywhere in the instance; the card coalesces them onto one trailing tick.
// Text/consumer updates land at most every RENDER_INTERVAL, flow-line styling
// (thickness, active set, arrows) at most every FLOW_INTERVAL.
const RENDER_INTERVAL = 2000;
const FLOW_INTERVAL = 5000;

// Power at which a flow may draw at full width on absolute grounds alone.
// Only caps the relative scale downward: a flow never draws fatter than its
// own power warrants, so a lone small flow stays visibly small.
const ABS_FULL_W = 6000;

// Consumer column geometry (right of the house node). `w` is the bar itself
// and is deliberately narrow — widening it would only steal room from the
// names, which are what needs the space.
const COL = { x: 322, w: 24, top: 12, bottom: 148, gap: 1.5, minSeg: 14, rx: 2 };

// The house node and the consumer column form one visual unit: a rounded
// panel groups them. `pad` is the inner gutter the consumer values
// right-align to. Sized to ~55% of the card so consumer names get roughly
// twice the room they had when the panel was 41%.
const GROUP = { x: 234, y: 6, w: 284, h: 148, rx: 12, pad: 10 };

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

// Per-icon horizontal nudge (SVG units): the grid bolt and battery glyphs
// are not centered in their own 24x24 boxes — compensate so the visual
// center matches the ring center (measured, not guessed).
const ICON_NUDGE = { grid: 0.75, battery: -0.38 };

// Sub-label placement per node: battery sits beside the ring to keep the
// card flat; pv's sub doubles as the daily-yield readout.
const SUB_POS = {
  pv: 'y="38" text-anchor="middle"',
  grid: 'y="40" text-anchor="middle"',
  house: 'y="40" text-anchor="middle"',
  battery: 'x="-35" y="4" text-anchor="end"',
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

// Per-language label tables, auto-selected from hass.language. Every label
// is still overridable via the `labels` config map (each one is an
// individual text field in the GUI editor) on top of the detected language.
const LABEL_TABLES = {
  en: {
    pv: "PV", grid: "Grid", house: "Home", battery: "Battery",
    grid_import: "import", grid_export: "export",
    battery_charge: "charging", battery_discharge: "discharging",
    daily_yield: "today",
  },
  de: {
    pv: "PV", grid: "Netz", house: "Haus", battery: "Batterie",
    grid_import: "Bezug", grid_export: "Einspeisung",
    battery_charge: "lädt", battery_discharge: "entlädt",
    daily_yield: "heute",
  },
  fr: {
    pv: "PV", grid: "Réseau", house: "Maison", battery: "Batterie",
    grid_import: "import", grid_export: "export",
    battery_charge: "charge", battery_discharge: "décharge",
    daily_yield: "aujourd'hui",
  },
  it: {
    pv: "FV", grid: "Rete", house: "Casa", battery: "Batteria",
    grid_import: "prelievo", grid_export: "immissione",
    battery_charge: "in carica", battery_discharge: "in scarica",
    daily_yield: "oggi",
  },
  es: {
    pv: "FV", grid: "Red", house: "Casa", battery: "Batería",
    grid_import: "importación", grid_export: "exportación",
    battery_charge: "cargando", battery_discharge: "descargando",
    daily_yield: "hoy",
  },
  nl: {
    pv: "PV", grid: "Net", house: "Huis", battery: "Batterij",
    grid_import: "import", grid_export: "export",
    battery_charge: "laden", battery_discharge: "ontladen",
    daily_yield: "vandaag",
  },
  pt: {
    pv: "FV", grid: "Rede", house: "Casa", battery: "Bateria",
    grid_import: "importação", grid_export: "exportação",
    battery_charge: "a carregar", battery_discharge: "a descarregar",
    daily_yield: "hoje",
  },
  no: {
    pv: "Sol", grid: "Nett", house: "Hjem", battery: "Batteri",
    grid_import: "import", grid_export: "eksport",
    battery_charge: "lader", battery_discharge: "lader ut",
    daily_yield: "i dag",
  },
  da: {
    pv: "Sol", grid: "Net", house: "Hjem", battery: "Batteri",
    grid_import: "import", grid_export: "eksport",
    battery_charge: "oplader", battery_discharge: "aflader",
    daily_yield: "i dag",
  },
  fi: {
    pv: "Aurinko", grid: "Verkko", house: "Koti", battery: "Akku",
    grid_import: "osto", grid_export: "myynti",
    battery_charge: "lataa", battery_discharge: "purkaa",
    daily_yield: "tänään",
  },
};

// hass.language is a BCP-47 tag (e.g. "de", "de-CH", "pt-BR"); match on the
// primary subtag and fall back to English for unsupported languages.
function resolveLanguage(hass) {
  const primary = String((hass && hass.language) || "en").toLowerCase().split("-")[0];
  return LABEL_TABLES[primary] ? primary : "en";
}

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
  const idTests = []; // hass-independent tests, usable for candidate prefiltering
  if (rule.entity_id) {
    const re = globToRegExp(String(rule.entity_id));
    const t = (id) => re.test(id);
    tests.push(t);
    idTests.push(t);
  }
  if (rule.domain) {
    const t = (id) => id.split(".")[0] === rule.domain;
    tests.push(t);
    idTests.push(t);
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
  const fn = (id, hass) => tests.every((t) => t(id, hass));
  // True when the id could ever match: only the hass-independent tests are
  // applied. Rules without any id-only test keep every id as a candidate.
  fn.idOnly = (id) => idTests.every((t) => t(id));
  return fn;
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
    this._config.line_boldness = Math.min(
      Math.max(Number.isFinite(config.line_boldness) ? config.line_boldness : 2, 1), 5
    );
    this._config.flow_threshold =
      Number.isFinite(config.flow_threshold) && config.flow_threshold >= 0
        ? config.flow_threshold : 25;
    this._config.pv_threshold =
      Number.isFinite(config.pv_threshold) && config.pv_threshold >= 0
        ? config.pv_threshold : 50;
    this._config.show_labels = config.show_labels !== false;
    this._config.uniform_color =
      typeof config.uniform_color === "string" && config.uniform_color.trim()
        ? config.uniform_color.trim() : null;
    this._config.uniform_bars = config.uniform_bars === true;
    this._configLabels = config.labels || {};
    this._labels = { ...LABEL_TABLES[this._lastLang || "en"], ...this._configLabels };
    const f = config.filter || {};
    this._include = (f.include || []).map(compileRule);
    this._exclude = (f.exclude || []).map(compileRule);
    this._candidateIds = null;
    this._candidateCount = -1;
    this._lastTextKey = null;
    this._lastFlowKey = null;
    this._lastFlowApply = 0;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
    this._built = false;
    if (this._hass) this._scheduleRender();
  }

  connectedCallback() {
    if (this._hass && this._config) this._scheduleRender();
  }

  disconnectedCallback() {
    if (this._renderTimer) {
      clearTimeout(this._renderTimer);
      this._renderTimer = null;
    }
  }

  // Storing the hass reference is all that happens synchronously; the actual
  // render is coalesced onto a trailing RENDER_INTERVAL tick. The timer is
  // only armed while an update is pending — nothing runs when the instance
  // is quiet.
  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._scheduleRender();
  }

  _scheduleRender(delay) {
    if (this._renderTimer) return;
    const wait = delay !== undefined
      ? delay
      : Math.max(0, (this._lastRender || 0) + RENDER_INTERVAL - Date.now());
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._lastRender = Date.now();
      this._render();
    }, wait);
  }

  _render() {
    const hass = this._hass;
    if (!hass || !this._config) return;
    const lang = resolveLanguage(hass);
    if (lang !== this._lastLang) {
      this._lastLang = lang;
      this._labels = { ...LABEL_TABLES[lang], ...this._configLabels };
      this._lastTextKey = null; // labels changed → force a text repaint
    }
    if (!this._built) this._build();
    const model = this._computeModel(hass);
    const textKey = JSON.stringify([
      model.values, model.subs, model.socDash, model.socVisible,
      model.pvIdle, model.consumers, model.dark,
    ]);
    if (textKey !== this._lastTextKey) {
      this._lastTextKey = textKey;
      this._applyText(model);
    }
    const flowKey = JSON.stringify(model.flows);
    if (flowKey !== this._lastFlowKey) {
      const now = Date.now();
      if (now - this._lastFlowApply >= FLOW_INTERVAL) {
        this._lastFlowKey = flowKey;
        this._lastFlowApply = now;
        this._applyFlows(model.flows);
      } else {
        // flow change is rate-limited right now — pick it up when due even
        // if no further hass update arrives in the meantime
        this._scheduleRender(this._lastFlowApply + FLOW_INTERVAL - now);
      }
    }
  }

  // Top current consumers via the include/exclude filter, sorted descending.
  // The full-instance entity sweep runs only when the entity-id universe
  // changes; every hass update after that touches just the candidate ids
  // (the ones whose hass-independent include tests pass), so a busy
  // instance no longer pays a per-update scan over thousands of entities.
  _computeConsumers(hass) {
    if (!this._include.length) return [];
    const allIds = Object.keys(hass.states);
    if (!this._candidateIds || allIds.length !== this._candidateCount) {
      this._candidateCount = allIds.length;
      this._candidateIds = allIds.filter((id) =>
        this._include.some((rule) => rule.idOnly(id))
      );
    }
    const items = [];
    for (const id of this._candidateIds) {
      if (!hass.states[id]) continue;
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
    // 999.5+ would round to "1000 W" — switch to kW before that happens.
    if (Math.abs(w) >= 999.5) {
      return `${(w / 1000).toFixed(Math.abs(w) >= 10000 ? 0 : 1)} kW`;
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
    // explicit midpoint vertex so marker-mid can hang the direction arrow on it
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${mx.toFixed(1)} ${my.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const flowPaths = FLOW_DEFS
      .map((f) => {
        const d = this._flowPath(f);
        return `
        <path id="rail-${f.key}" class="rail" d="${d}"/>
        <path id="flow-${f.key}" class="flow ${f.color}" d="${d}"
              marker-mid="url(#arr-${f.color})"/>`;
      })
      .join("");
    // Direction arrows: one filled triangle per flow color, hung on the
    // path's midpoint vertex via marker-mid. Fixed user-space size (not
    // strokeWidth units) so thin trickles still get a readable arrow; the
    // card-background outline keeps it visible on top of a same-colored
    // line at full width.
    const markers = ["solar", "grid", "battery"]
      .map((c) => `
        <marker id="arr-${c}" markerUnits="userSpaceOnUse" markerWidth="9"
                markerHeight="9" refX="4.5" refY="4.5" orient="auto">
          <path class="arrow ${c}" d="M 1 1 L 8 4.5 L 1 8 Z"/>
        </marker>`)
      .join("");
    const nodes = Object.entries(NODE)
      .map(
        ([k, n]) => `
        <g class="node" id="node-${k}" transform="translate(${n.cx},${n.cy})">
          ${k === "battery"
            ? `<circle class="ring battery base" r="${n.r}"/>
          <circle class="ring battery arc" id="soc-arc" r="${n.r}" pathLength="100" transform="rotate(-90)"/>`
            : `<circle class="ring ${k}" r="${n.r}"/>`}
          <path class="icon" d="${ICONS[k]}" transform="translate(${(-9 + (ICON_NUDGE[k] || 0)).toFixed(2)},-17) scale(0.75)"/>
          <text class="value" id="val-${k}" y="12" text-anchor="middle"></text>
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
        /* Groups the house node and the consumer column into one unit.
           Fill tracks the theme's text color so it reads the same in light
           and dark without a second color definition. */
        .group-panel { fill: var(--primary-text-color, #212121); fill-opacity: .04;
                       stroke: none; }
        .rail { fill: none; stroke: var(--divider-color, rgba(120,120,120,.3));
                stroke-width: 2; opacity: 0; transition: opacity .3s; }
        .rail.active { opacity: 1; }
        .flow { fill: none; stroke-width: 3; stroke-linecap: round;
                opacity: 0; transition: opacity .3s; }
        .flow.active { opacity: 1; }
        .arrow { stroke: var(--card-background-color, #fff); stroke-width: 1;
                 stroke-linejoin: round; }
        .arrow.solar { fill: var(--cpfc-solar); }
        .arrow.grid { fill: var(--cpfc-grid); }
        .arrow.battery { fill: var(--cpfc-battery); }
        :host { --cpfc-solar: var(--energy-solar-color, #ff9800);
                --cpfc-grid: var(--energy-grid-consumption-color, #488fc2);
                --cpfc-house: var(--primary-color, #03a9f4);
                --cpfc-battery: var(--energy-battery-out-color, #4caf50); }
        ${this._config.uniform_color ? `:host {
                --cpfc-solar: ${this._config.uniform_color};
                --cpfc-grid: ${this._config.uniform_color};
                --cpfc-house: ${this._config.uniform_color};
                --cpfc-battery: ${this._config.uniform_color}; }` : ""}
        .flow.solar { stroke: var(--cpfc-solar); }
        .flow.grid { stroke: var(--cpfc-grid); }
        .flow.battery { stroke: var(--cpfc-battery); }
        .ring { fill: var(--card-background-color, none);
                stroke-width: 2.5; }
        .ring.pv { stroke: var(--cpfc-solar); }
        .ring.grid { stroke: var(--cpfc-grid); }
        .ring.house { stroke: var(--cpfc-house); }
        .ring.battery { stroke: var(--cpfc-battery); }
        .ring.battery.base { stroke-opacity: .25; }
        .ring.battery.arc { fill: none; stroke-linecap: round;
                            transition: stroke-dasharray .3s, opacity .3s; }
        .node .ring, .node .icon, .node .value { transition: opacity .3s; }
        .node.idle .ring, .node.idle .icon, .node.idle .value { opacity: .3; }
        .icon { fill: none; stroke: var(--secondary-text-color, #727272);
                stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
                opacity: .8; }
        .value { font: 700 12px sans-serif; fill: var(--primary-text-color, #212121); }
        .sub { font: 400 10px sans-serif; fill: var(--secondary-text-color, #727272); }
        svg.hide-labels .sub { display: none; }
        .seg { cursor: pointer; }
        .seg-name { font: 400 9px sans-serif; fill: var(--secondary-text-color, #727272);
                    cursor: pointer; }
        .seg-val { font: 600 9px sans-serif; fill: var(--primary-text-color, #212121);
                   cursor: pointer; }
      </style>
      <ha-card>
        <svg viewBox="0 0 520 160" preserveAspectRatio="xMidYMid meet"
             class="${this._config.show_labels ? "" : "hide-labels"}"
             role="img" aria-label="Power flow">
          <defs>${markers}</defs>
          <rect class="group-panel" x="${GROUP.x}" y="${GROUP.y}"
                width="${GROUP.w}" height="${GROUP.h}" rx="${GROUP.rx}"/>
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
    const uniformBar =
      this._config.uniform_bars ? this._config.uniform_color : null;
    const heights = consumers.map((c) => c.h);
    const values = consumers.map((c) => c.value);
    const parts = [];
    // Name column starts right of the bar; values are flush to the group
    // panel's inner gutter so they form a right-aligned second column.
    const nameX = COL.x + COL.w + 8;
    const valX = GROUP.x + GROUP.w - GROUP.pad;
    // Reserve only what the widest value in THIS set actually needs (measured
    // ~5.2px/char at 9px/600 sans-serif), so short values leave the names more
    // room instead of truncating against a fixed worst case.
    const valW = Math.max(...values.map((v) => v.length)) * 5.2;
    const nameBudget = valX - valW - 8 - nameX; // 8px min gap between columns
    // 5.0px/char (above the 4.6 average) so wide glyphs — umlauts, caps —
    // still clear the value column instead of crowding it.
    const maxNameChars = Math.max(3, Math.floor(nameBudget / 5.0));
    let yBottom = COL.bottom;
    consumers.forEach((c, i) => {
      const h = heights[i];
      const top = yBottom - h;
      const cy = top + h / 2 + 3; // text baseline ≈ vertical center
      const name = c.name.length > maxNameChars
        ? `${c.name.slice(0, maxNameChars - 1)}…`
        : c.name;
      const color = uniformBar || palette[i % palette.length];
      parts.push(`
        <rect class="seg" data-entity="${c.id}" x="${COL.x}" y="${top.toFixed(1)}"
              width="${COL.w}" height="${h.toFixed(1)}" rx="${COL.rx}" fill="${color}"/>
        <text class="seg-name" data-entity="${c.id}" x="${nameX}" y="${cy.toFixed(1)}"
              text-anchor="start">${name}</text>
        <text class="seg-val" data-entity="${c.id}" x="${valX}" y="${cy.toFixed(1)}"
              text-anchor="end">${values[i]}</text>`);
      yBottom = top - COL.gap;
    });
    g.innerHTML = parts.join("");
  }

  // Everything the DOM needs, quantized to DISPLAYED precision: two hass
  // updates that format to the same output produce byte-identical models,
  // so sensor jitter below display resolution causes zero DOM work.
  _computeModel(hass) {
    const thr = this._config.flow_threshold;
    // Line thickness is RELATIVE: the biggest flow right now always draws at
    // full width and everything else scales against it. A fixed W->px scale
    // cannot work here — a system exporting 11 kW at noon and importing
    // 300 W at night would either clip the whole top of its range or render
    // every night-time flow as a hairline.
    const b = this._config.line_boldness;
    const maxW = 6 + (b - 1) * 1.5;
    const raw = {};
    for (const f of FLOW_DEFS) raw[f.key] = this._num(f.key) || 0;
    const peak = FLOW_DEFS.reduce(
      (m, f) => (raw[f.key] > thr ? Math.max(m, raw[f.key]) : m), 0);
    const flows = {};
    for (const f of FLOW_DEFS) {
      const w = raw[f.key];
      if (w > thr) {
        // share of the current peak, on a sqrt curve so a flow at a third of
        // the peak still reads as clearly present rather than near-invisible
        const share = Math.sqrt(w / peak);
        // Relative scaling alone would draw a lone 200 W trickle exactly as
        // fat as a lone 9 kW export, since each is its own peak. Cap the
        // width by absolute power too, so "thick" keeps some real meaning.
        const absCap = MIN_FLOW_W + (maxW - MIN_FLOW_W) * Math.min(1, w / ABS_FULL_W);
        const width = Math.min(MIN_FLOW_W + (maxW - MIN_FLOW_W) * share, absCap);
        // quarter-px quantization so width jitter doesn't count as a change
        flows[f.key] = { active: true, width: Math.round(width * 4) / 4 };
      } else {
        flows[f.key] = { active: false, width: 0 };
      }
    }

    const pv = this._num("pv_total");
    const house = this._num("house");
    const soc = this._num("battery_soc");
    const batNet = raw.pv_to_battery - raw.battery_to_house;
    const gridNet = raw.grid_to_house; // import; export shown at PV->grid flow
    const exporting = this._num("pv_to_grid") > gridNet;

    const values = {
      pv: this._fmtW(pv),
      house: this._fmtW(house),
      grid: this._fmtW(exporting ? this._num("pv_to_grid") : gridNet),
      battery: this._fmtW(Math.abs(batNet)),
    };
    const subs = {
      house: this._labels.house,
      grid: exporting ? this._labels.grid_export : this._labels.grid_import,
      battery: Math.abs(batNet) > thr
        ? (batNet > 0 ? this._labels.battery_charge : this._labels.battery_discharge)
        : this._labels.battery,
    };
    const yieldRaw = this._num("daily_yield");
    if (yieldRaw !== null) {
      const st = hass.states[this._config.entities.daily_yield];
      const unit = (st.attributes.unit_of_measurement || "kWh").toLowerCase();
      const kwh =
        unit === "wh" ? yieldRaw / 1000 : unit === "mwh" ? yieldRaw * 1000 : yieldRaw;
      subs.pv = `${this._labels.daily_yield} ${kwh.toFixed(1)} kWh`;
    } else {
      subs.pv = this._labels.pv;
    }

    const socPct = soc === null ? 0 : Math.min(100, Math.max(0, soc));
    const items = this._computeConsumers(hass);
    // Half-px height quantization: a consumer wobbling by a few watts moves
    // its segment sub-visibly — that must not count as a change either.
    const heights = items.length
      ? this._segmentHeights(items).map((h) => Math.round(h * 2) / 2)
      : [];
    return {
      flows,
      values,
      subs,
      socDash: `${socPct.toFixed(1)} ${(100 - socPct).toFixed(1)}`,
      socVisible: socPct > 0,
      pvIdle: (pv || 0) < this._config.pv_threshold,
      consumers: items.map((c, i) => ({
        id: c.id, name: c.name, value: this._fmtW(c.watts), h: heights[i],
      })),
      dark: !!(hass.themes && hass.themes.darkMode),
    };
  }

  _applyText(model) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    for (const k of ["pv", "grid", "house", "battery"]) {
      $(`val-${k}`).textContent = model.values[k];
      $(`sub-${k}`).textContent = model.subs[k];
    }
    const socArc = $("soc-arc");
    socArc.style.strokeDasharray = model.socDash;
    // a zero-length dash with round caps would still paint a dot at 12 o'clock
    socArc.style.opacity = model.socVisible ? "1" : "0";
    $("node-pv").classList.toggle("idle", model.pvIdle);
    this._renderConsumers(model.consumers, model.dark);
  }

  _applyFlows(flows) {
    const $ = (id) => this.shadowRoot.getElementById(id);
    for (const f of FLOW_DEFS) {
      const st = flows[f.key];
      const flowEl = $(`flow-${f.key}`);
      const railEl = $(`rail-${f.key}`);
      flowEl.classList.toggle("active", st.active);
      railEl.classList.toggle("active", st.active);
      if (st.active) {
        flowEl.style.strokeWidth = st.width;
        railEl.style.strokeWidth = st.width;
      }
    }
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
  line_boldness: "Line boldness (max width of the biggest flow)",
  flow_threshold: "Hide flow lines below (W)",
  pv_threshold: "Dim PV node below (W)",
  show_labels: "Show labels (names, direction words, daily yield)",
  uniform_color: "Uniform color for nodes + flow lines (any CSS color; empty = default colors)",
  uniform_bars: "Apply the uniform color to the consumer bars too (no palette)",
};

const LABEL_EDITOR_HINTS = {
  pv: "PV node label",
  grid: "Grid node label",
  house: "House node label",
  battery: "Battery idle label",
  grid_import: "Grid import label",
  grid_export: "Grid export label",
  battery_charge: "Battery charging label",
  battery_discharge: "Battery discharging label",
  daily_yield: "Daily yield prefix",
};

// Simple numeric options managed 1:1 between config and editor form.
const NUMBER_KEYS = ["max_consumers", "line_boldness", "flow_threshold", "pv_threshold"];

// Label keys, each surfaced as its own text field (form name: label_<key>).
const LABEL_KEYS = Object.keys(LABEL_TABLES.en);

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
    const lang = resolveLanguage(hass);
    const langChanged = lang !== this._lang;
    this._lang = lang;
    if (this._form) this._form.hass = hass;
    if (langChanged && this._initialized) this._render();
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

  _computeFieldLabel(name) {
    if (name.startsWith("label_")) {
      const key = name.slice("label_".length);
      const lang = this._lang || "en";
      const dflt = (LABEL_TABLES[lang] || LABEL_TABLES.en)[key];
      return `${LABEL_EDITOR_HINTS[key] || key} (default "${dflt}")`;
    }
    return EDITOR_LABELS[name] || name;
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
      this._form.computeLabel = (s) => this._computeFieldLabel(s.name);
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
      { name: "line_boldness", selector: { number: { min: 1, max: 5, step: 0.5, mode: "box" } } },
      { name: "flow_threshold", selector: { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "W" } } },
      { name: "pv_threshold", selector: { number: { min: 0, step: 1, mode: "box", unit_of_measurement: "W" } } },
      { name: "show_labels", selector: { boolean: {} } },
      { name: "uniform_color", selector: { text: {} } },
      { name: "uniform_bars", selector: { boolean: {} } },
      ...LABEL_KEYS.map((k) => ({ name: `label_${k}`, selector: { text: {} } })),
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
    for (const k of NUMBER_KEYS) if (c[k] !== undefined) data[k] = c[k];
    data.show_labels = c.show_labels !== false;
    if (c.uniform_color !== undefined) data.uniform_color = c.uniform_color;
    data.uniform_bars = c.uniform_bars === true;
    const labels = c.labels || {};
    for (const k of LABEL_KEYS) if (labels[k] !== undefined) data[`label_${k}`] = labels[k];

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
    for (const k of NUMBER_KEYS) {
      if (d[k] === undefined || d[k] === "") delete cfg[k];
      else cfg[k] = d[k];
    }
    if (d.show_labels === false) cfg.show_labels = false;
    else delete cfg.show_labels;
    if (typeof d.uniform_color === "string" && d.uniform_color.trim()) {
      cfg.uniform_color = d.uniform_color.trim();
    } else {
      delete cfg.uniform_color;
    }
    if (d.uniform_bars === true) cfg.uniform_bars = true;
    else delete cfg.uniform_bars;
    const labels = {};
    for (const k of LABEL_KEYS) {
      const v = d[`label_${k}`];
      if (v !== undefined && v !== "") labels[k] = v;
    }
    if (Object.keys(labels).length) cfg.labels = labels;
    else delete cfg.labels;
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
