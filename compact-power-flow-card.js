/* compact-power-flow-card
 *
 * A compact, dependency-free power-flow card for Home Assistant:
 * PV / grid / house / battery nodes with animated flow paths, plus optional
 * icon-only satellite bubbles for EV charger and heat pump (fed from the
 * house node) and the daily yield shown at the PV node.
 *
 * - Plain ES module: HTMLElement + Shadow DOM, no external libraries.
 * - No polling: re-renders only when one of the configured entities changes.
 * - CSS/SVG animations only; flow speed AND line thickness scale with power.
 * - Lines are only visible while power is actually flowing.
 * - Theme-aware (uses HA energy/theme CSS variables with sane fallbacks).
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
 *     ev:                sensor  (optional; EV charger W -> satellite bubble)
 *     heatpump:          sensor  (optional; heat pump W -> satellite bubble)
 *   labels:              optional map to override labels, e.g.
 *     daily_yield: "today" / grid_import: "import"
 */

const VERSION = "0.2.0";

// Flows below this many watts count as "not flowing".
const THRESHOLD = 25;

// Node geometry inside the 520x160 viewBox. Satellites are icon-only
// bubbles rendered only when their entity is configured.
const NODE = {
  pv: { cx: 205, cy: 32, r: 26 },
  grid: { cx: 46, cy: 80, r: 26 },
  house: { cx: 362, cy: 80, r: 26 },
  battery: { cx: 205, cy: 128, r: 26 },
  ev: { cx: 472, cy: 44, r: 16, satellite: true },
  heatpump: { cx: 472, cy: 116, r: 16, satellite: true },
};

// Flow definitions; path d strings are generated from node coordinates.
// Direction of travel = path direction. Optional flows render only when
// their entity is configured (flow key doubles as the entity key).
const FLOW_DEFS = [
  { key: "pv_to_house", from: "pv", to: "house", color: "solar" },
  // fromGap starts the path below PV's sub-label instead of at the ring edge
  { key: "pv_to_battery", from: "pv", to: "battery", color: "solar", fromGap: 16 },
  { key: "pv_to_grid", from: "pv", to: "grid", color: "solar" },
  { key: "grid_to_house", from: "grid", to: "house", color: "grid" },
  { key: "battery_to_house", from: "battery", to: "house", color: "battery" },
  { key: "ev", from: "house", to: "ev", color: "load", optional: true },
  { key: "heatpump", from: "house", to: "heatpump", color: "load", optional: true },
];

const ICONS = {
  pv: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  grid: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
  house: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  battery: "M7 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm13 3v4",
  ev: "M4 16v2m16-2v2M3 11l2-4.5h14L21 11m-18 0h18v5H3v-5zm4 2.5h.01m10 0h.01",
  heatpump: "M12 3c2.5 3 5 5.5 5 9a5 5 0 0 1-10 0c0-2.2 1-3.8 2.2-5.4.5 1.2 1.4 2 2.8 2.4-.8-2-.5-4 0-6z",
};

// Sub-label placement per main node: battery sits beside the ring to keep
// the card flat; pv's sub doubles as the daily-yield readout.
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

class CompactPowerFlowCard extends HTMLElement {
  setConfig(config) {
    if (!config.entities) {
      throw new Error("compact-power-flow-card: 'entities' is missing");
    }
    for (const key of REQUIRED) {
      if (!config.entities[key]) {
        throw new Error(`compact-power-flow-card: entities.${key} is missing`);
      }
    }
    this._config = config;
    this._labels = { ...DEFAULT_LABELS, ...(config.labels || {}) };
    this._lastStates = null;
    if (this.shadowRoot) this.shadowRoot.innerHTML = "";
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const snapshot = Object.values(this._config.entities)
      .map((id) => (hass.states[id] ? hass.states[id].state : "?"))
      .join("|");
    if (snapshot === this._lastStates && this._built) return;
    this._lastStates = snapshot;
    if (!this._built) this._build();
    this._update();
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
    this._flows = FLOW_DEFS.filter(
      (f) => !f.optional || this._config.entities[f.key]
    );
    const flowPaths = this._flows
      .map((f) => {
        const d = this._flowPath(f);
        return `
        <path id="rail-${f.key}" class="rail" d="${d}"/>
        <path id="flow-${f.key}" class="flow ${f.color}" d="${d}"/>`;
      })
      .join("");
    const nodes = Object.entries(NODE)
      .filter(([k, n]) => !n.satellite || this._config.entities[k])
      .map(([k, n]) =>
        n.satellite
          ? `
        <g class="node" id="node-${k}" transform="translate(${n.cx},${n.cy})">
          <circle class="ring ${k}" r="${n.r}"/>
          <path class="icon" d="${ICONS[k]}" transform="translate(-7.2,-7.2) scale(0.6)"/>
        </g>`
          : `
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
        .flow.load { stroke: var(--primary-color, #03a9f4); }
        .ring { fill: var(--card-background-color, none);
                stroke-width: 2.5; }
        .ring.pv { stroke: var(--energy-solar-color, #ff9800); }
        .ring.grid { stroke: var(--energy-grid-consumption-color, #488fc2); }
        .ring.house { stroke: var(--primary-color, #03a9f4); }
        .ring.battery { stroke: var(--energy-battery-out-color, #4caf50); }
        .ring.ev, .ring.heatpump { stroke: var(--primary-color, #03a9f4); }
        .node { transition: opacity .3s; }
        .node.idle { opacity: .35; }
        .icon { fill: none; stroke: var(--secondary-text-color, #727272);
                stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
                opacity: .8; transform-box: fill-box; }
        .value { font: 700 12px sans-serif; fill: var(--primary-text-color, #212121); }
        .sub { font: 400 10px sans-serif; fill: var(--secondary-text-color, #727272); }
      </style>
      <ha-card>
        <svg viewBox="0 0 520 160" preserveAspectRatio="xMidYMid meet"
             role="img" aria-label="Power flow">
          ${flowPaths}
          ${nodes}
        </svg>
      </ha-card>`;
    this._built = true;
  }

  _update() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const flows = {};
    for (const f of this._flows) {
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
      if (f.optional) {
        $(`node-${f.key}`).classList.toggle("idle", w <= THRESHOLD);
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
  }

  getCardSize() {
    return 3;
  }

  getGridOptions() {
    return { columns: 12, rows: 3, min_rows: 2, min_columns: 6 };
  }
}

customElements.define("compact-power-flow-card", CompactPowerFlowCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "compact-power-flow-card",
  name: "Compact Power Flow Card",
  description: "Compact animated power flow (PV, battery, grid, house)",
});

console.info(
  `%c COMPACT-POWER-FLOW-CARD %c v${VERSION} `,
  "background:#488fc2;color:#fff;padding:2px 4px;border-radius:3px 0 0 3px",
  "background:#333;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0"
);
