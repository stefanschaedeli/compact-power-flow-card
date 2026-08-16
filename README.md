# Compact Power Flow Card

A compact, dependency-free power-flow card for Home Assistant: PV, grid, house
and battery as ring nodes with static flow lines (thickness ∝ power, a small
arrow marking the direction), plus an optional stacked column of the top
current power consumers. Tesla-style level of detail in roughly a quarter of
the space — without the always-on animation cost.

![light](https://raw.githubusercontent.com/stefanschaedeli/compact-power-flow-card/main/docs/card-light.png)
![dark](https://raw.githubusercontent.com/stefanschaedeli/compact-power-flow-card/main/docs/card-dark.png)

## Why another power flow card?

- **Compact** — a single `ha-card`, ~3 grid rows in a sections view, degrades
  gracefully down to phone width (390 px).
- **Zero dependencies** — one plain ES module (HTMLElement + Shadow DOM). No
  Lit bundle, no chart library.
- **Efficient, kiosk-friendly** — no animation at all: flows are static lines
  with a direction arrow, so an idle dashboard paints *nothing* (a wall tablet
  stays cool). State updates are coalesced onto a 2 s tick and the card only
  touches the DOM when a **displayed** value changes — sensor jitter below
  display resolution is ignored. Flow-line styling updates at most every 5 s.
- **Theme-aware** — uses HA's `--energy-*-color` and text/background theme
  variables with sensible fallbacks; adapts to light/dark automatically.
- **Lines only when power flows** — flows below `flow_threshold` (default
  25 W) are fully hidden, so an idle system shows just the nodes.
- Flow **thickness scales with power**, *relative to the biggest flow
  currently running* — so the dominant flow is always obvious at a glance,
  whether your system is pushing 11 kW or 300 W. A configurable
  `line_boldness` factor sets the maximum width.
- **Battery ring = SOC gauge** — the arc drains counter-clockwise as the
  battery empties; the center shows charge/discharge power.
- **Top-consumers column** — auto-discovers your biggest current loads via an
  include/exclude filter ([power-pie-card](https://github.com/stefanschaedeli/power-pie-card)
  semantics), stacks them proportionally, tap opens more-info.
- **GUI editor** — every option editable in the HA card editor, no YAML needed.

## Installation

### HACS (custom repository)

1. HACS → three-dot menu → *Custom repositories*
2. Repository: `stefanschaedeli/compact-power-flow-card`, type: *Dashboard*
3. Install **Compact Power Flow Card**, reload your browser.

### Manual

Copy `compact-power-flow-card.js` to `/config/www/` and register a dashboard
resource:

```yaml
url: /local/compact-power-flow-card.js
type: module
```

## Configuration

The card displays five directional flows between the main nodes. Each flow is
fed by its own sensor (magnitude in W, ≥ 0); most hybrid-inverter integrations
(SMA, Fronius, Victron, …) expose these directly.

```yaml
type: custom:compact-power-flow-card
entities:
  pv_total: sensor.pv_power_total            # required
  pv_to_house: sensor.pv_to_house            # required
  pv_to_battery: sensor.battery_charge_power # required
  pv_to_grid: sensor.grid_export_power       # required
  battery_to_house: sensor.battery_discharge_power # required
  grid_to_house: sensor.grid_import_power    # required
  battery_soc: sensor.battery_soc            # required (%)
  house: sensor.house_consumption            # required
  daily_yield: sensor.pv_daily_yield         # optional (Wh/kWh/MWh, auto-scaled;
                                             #   shown as the PV sub-label)
filter:                                      # optional: enables the consumers column
  include:
    - entity_id: "sensor.*_pwr*"
  exclude:
    - state: "< 1"
max_consumers: 4                             # optional, 1-6 segments (default 4)
line_boldness: 2                             # optional, 1-5 (default 2): max width
                                             #   of the biggest current flow
flow_threshold: 25                           # optional, W: flows below are hidden
pv_threshold: 50                             # optional, W: PV node dims below
uniform_color: "#8a8a8a"                     # optional: one CSS color for ALL
                                             #   node rings + flow lines
                                             #   (unset = per-node theme colors)
uniform_bars: true                           # optional (default false): paint the
                                             #   consumer bars in uniform_color too
                                             #   (needs uniform_color to be set)
```

### Top-consumers column

When a `filter` is configured, the right side of the card shows one vertical
stacked column of the biggest current consumers: matching sensors are read in
W/kW (by unit), sorted descending, and the top `max_consumers` are stacked
proportionally (biggest at the bottom, small segments keep a readable minimum
height). Each segment is labeled with its friendly name and current power —
names left-aligned, watt values right-aligned into a second column — and a
subtle rounded panel groups the column together with the house node, since the
two belong together. That panel takes ~55 % of the card width, with the
generation side (grid, PV, battery) packed into the left ~45 %: consumer names
are the content that actually needs room, so most real appliance names
("Geschirrspüler", "Auto Ladestation") fit in full. Anything still too long is
truncated to whatever room the widest value in the current set leaves free.
Tapping a segment opens the standard more-info dialog. Filter rules use the
same `entity_id` glob / `domain` / `state` comparison / `area` semantics as
power-pie-card. Without a `filter`, the column is absent.

### Labels

All visible texts auto-localize from your Home Assistant user's language
(`hass.language`) — supported out of the box: English, German, French,
Italian, Spanish, Dutch, Portuguese, Norwegian, Danish, Finnish. Any other
language falls back to English. Every label can still be overridden — in
YAML or via its own text field in the GUI editor — on top of whichever
language was detected. Set `show_labels: false` (a toggle in the editor) to
hide all sub-labels — names, direction words, and the daily-yield line — for
an icons-and-numbers-only card:

```yaml
labels:            # optional per-key overrides, applied on top of the
                   # auto-detected language (example forces German wording)
  pv: PV
  grid: Netz
  house: Haus
  battery: Batterie
  grid_import: Bezug
  grid_export: Einspeisung
  battery_charge: lädt
  battery_discharge: entlädt
  daily_yield: heute
```

### Behavior details

- **Grid node** shows whichever is larger of import/export with the matching
  label.
- **Battery node**: the ring itself is the SOC gauge — full circle at 100 %,
  the arc drains counter-clockwise from 12 o'clock, the empty part stays as a
  faint track. The center shows the current charge/discharge power (net of the
  charge and discharge sensors); the side label shows the direction
  (`lädt`/`entlädt`). No percentage is displayed.
- **PV node** dims to 30 % opacity below `pv_threshold` (default 50 W); the
  daily-yield line stays fully readable.
- **Line thickness is relative, not absolute.** The biggest flow on screen
  right now draws at full width (`6 + (line_boldness − 1) × 1.5` px) and the
  others scale against it on a square-root curve, so the split between flows
  stays readable across the whole range a PV system produces. A fixed W→px
  scale cannot do this: tuned for an 11 kW midday export it renders every
  night-time flow as a hairline, and tuned for night it clips everything above
  a couple of kW to the same width.
- An absolute cap applies on top, so a *lone* small flow still renders small
  rather than filling the full width just for being the only one active.
- **Daily yield** replaces the static PV sub-label (`heute 12.4 kWh`) when
  configured.
- **`uniform_color`** accepts any CSS color — hex, `rgb(...)`, or a theme
  variable like `var(--primary-color)` — and recolors all four node rings
  (including the battery SOC arc and its faint track) and all flow lines.
  The top-consumers column keeps its own palette unless **`uniform_bars`**
  (a toggle in the GUI editor) is also enabled — then every bar segment uses
  `uniform_color` as well and no color differentiation remains.
- **Unavailable sensors** render as `–` and their flows stay hidden — the card
  never throws on missing states.
- Sizing in sections views: defaults to 12 columns × 3 rows
  (`min_columns: 6`, `min_rows: 2`) via `getGridOptions()`.

### Breaking change in v0.3.0

The `entities.ev` / `entities.heatpump` satellite bubbles were removed — the
consumers column replaces them (an EV charger or heat pump shows up there
automatically whenever its power sensor matches the filter).

## License

[MIT](LICENSE)
