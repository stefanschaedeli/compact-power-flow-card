/* compact-power-flow-card
 *
 * A compact, dependency-free power-flow card for Home Assistant:
 * PV / grid / house / battery nodes with animated flow paths, plus optional
 * chips for daily yield, EV charger and heat pump.
 *
 * - Plain ES module: HTMLElement + Shadow DOM, no external libraries.
 * - No polling: re-renders only when one of the configured entities changes.
 * - CSS/SVG animations only; flow speed scales with power.
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
 *     daily_yield:       sensor  (optional; Wh/kWh/MWh auto-scaled by unit)
 *     ev:                sensor  (optional; EV charger W)
 *     heatpump:          sensor  (optional; heat pump W)
 *   labels:              optional map to override chip labels, e.g.
 *     daily_yield: "today" / ev: "Car" / heatpump: "Heating"
 */

const VERSION = "0.1.0";

const NODE = {
  pv: { cx: 200, cy: 38, label: "PV" },
  grid: { cx: 42, cy: 108, label: "Netz" },
  house: { cx: 358, cy: 108, label: "Haus" },
  battery: { cx: 200, cy: 178, label: "Batterie" },
};

// Flow paths between node circles (r = 26). Direction of travel = path direction.
const FLOWS = [
  { key: "pv_to_house", d: "M 222 52 C 290 70, 320 80, 336 94", color: "solar" },
  { key: "pv_to_battery", d: "M 200 66 L 200 150", color: "solar" },
  { key: "pv_to_grid", d: "M 178 52 C 110 70, 80 80, 64 94", color: "solar" },
  { key: "grid_to_house", d: "M 70 108 L 330 108", color: "grid" },
  { key: "battery_to_house", d: "M 222 164 C 290 146, 320 136, 336 122", color: "battery" },
];

const ICONS = {
  pv: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  grid: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
  house: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  battery: "M7 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm13 3v4",
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
  ev: "Auto",
  heatpump: "Heizung",
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

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const flowPaths = FLOWS.map(
      (f) => `
        <path id="rail-${f.key}" class="rail" d="${f.d}"/>
        <path id="flow-${f.key}" class="flow ${f.color}" d="${f.d}"/>`
    ).join("");
    const nodes = Object.entries(NODE)
      .map(
        ([k, n]) => `
        <g class="node" id="node-${k}" transform="translate(${n.cx},${n.cy})">
          <circle class="ring ${k}" r="26"/>
          <path class="icon" d="${ICONS[k]}" transform="translate(-9,-14) scale(0.75)"/>
          <text class="value" id="val-${k}" y="10" text-anchor="middle"></text>
          <text class="sub" id="sub-${k}" y="40" text-anchor="middle"></text>
        </g>`
      )
      .join("");
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { height: 100%; display: flex; flex-direction: column;
                  justify-content: center; padding: 8px 12px; box-sizing: border-box; }
        svg { width: 100%; height: auto; display: block; }
        .rail { fill: none; stroke: var(--divider-color, rgba(120,120,120,.3));
                stroke-width: 2; }
        .flow { fill: none; stroke-width: 3; stroke-linecap: round;
                stroke-dasharray: 5 11; opacity: 0; }
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
        .chips { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;
                 margin-top: 4px; }
        .chip { font: 400 11px sans-serif; color: var(--secondary-text-color, #727272);
                background: var(--secondary-background-color, rgba(120,120,120,.1));
                border-radius: 10px; padding: 2px 10px; white-space: nowrap; }
        .chip b { color: var(--primary-text-color, #212121); font-weight: 600; }
        .chip[hidden] { display: none; }
      </style>
      <ha-card>
        <svg viewBox="0 0 400 230" preserveAspectRatio="xMidYMid meet"
             role="img" aria-label="Power flow">
          ${flowPaths}
          ${nodes}
        </svg>
        <div class="chips">
          <span class="chip" id="chip-yield" hidden>${this._labels.daily_yield} <b></b></span>
          <span class="chip" id="chip-ev" hidden>${this._labels.ev} <b></b></span>
          <span class="chip" id="chip-heatpump" hidden>${this._labels.heatpump} <b></b></span>
        </div>
      </ha-card>`;
    this._built = true;
  }

  _update() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    const flows = {};
    for (const f of FLOWS) {
      const w = this._num(f.key) || 0;
      flows[f.key] = w;
      const el = $(`flow-${f.key}`);
      if (w > 25) {
        el.classList.add("active");
        // faster dashes for bigger flows: 4s at ~50 W down to 0.8s at >= 5 kW
        const dur = Math.max(0.8, 4 - 3.2 * Math.min(1, w / 5000));
        el.style.animationDuration = `${dur.toFixed(2)}s`;
      } else {
        el.classList.remove("active");
      }
    }

    const pv = this._num("pv_total");
    const house = this._num("house");
    const soc = this._num("battery_soc");
    const batNet = flows.pv_to_battery - flows.battery_to_house;
    const gridNet = flows.grid_to_house; // import; export shown at PV->grid flow

    $("val-pv").textContent = this._fmtW(pv);
    $("sub-pv").textContent = this._labels.pv;
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
      Math.abs(batNet) > 25
        ? `${batNet > 0 ? this._labels.battery_charge : this._labels.battery_discharge} ${this._fmtW(Math.abs(batNet))}`
        : this._labels.battery;

    const yieldRaw = this._num("daily_yield");
    const chipYield = $("chip-yield");
    if (yieldRaw !== null) {
      const st = this._hass.states[this._config.entities.daily_yield];
      const unit = (st.attributes.unit_of_measurement || "kWh").toLowerCase();
      const kwh =
        unit === "wh" ? yieldRaw / 1000 : unit === "mwh" ? yieldRaw * 1000 : yieldRaw;
      chipYield.querySelector("b").textContent = `${kwh.toFixed(1)} kWh`;
      chipYield.hidden = false;
    } else {
      chipYield.hidden = true;
    }
    for (const key of ["ev", "heatpump"]) {
      const chip = $(`chip-${key}`);
      const w = this._num(key);
      if (w !== null && w > 25) {
        chip.querySelector("b").textContent = this._fmtW(w);
        chip.hidden = false;
      } else {
        chip.hidden = true;
      }
    }
  }

  getCardSize() {
    return 4;
  }

  getGridOptions() {
    return { columns: 12, rows: 4, min_rows: 3, min_columns: 6 };
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
