# CLAUDE.md — Fuel Planner

Science-based race nutrition calculator for road, trail, and ultra-marathon running.

## Commands

```bash
npm run dev      # Start dev server (Vite, hot reload)
npm run build    # Production build → dist/
npm run preview  # Serve built dist/ locally
```

Deployment is automatic via GitHub Actions on push to `main` → GitHub Pages at `/trail-fuel-planner/`.

## Architecture

### Single-component monolith

The entire app lives in `src/App.jsx` (~1300 lines). This is intentional for a single-purpose tool — do not split into multiple files unless there is a compelling reason. `src/main.jsx` is only the React root mount.

`trail-fuel-planner.jsx` at the repo root is an archive/backup — do not edit it.

### No external state or UI libraries

Only React hooks (`useState`, `useMemo`, `useRef`, `useEffect`). No Redux, Context, routing, or UI component libraries. Keep it that way.

### Styling

All styles are inline objects (`style={{ ... }}`). Theme variables (dark/light) are injected as a `<style>` tag using `DARK_CSS` / `LIGHT_CSS` string constants at the top of `App.jsx`. A single CSS string handles responsive media queries (breakpoint: 600px). There are no `.css` files.

## Key Internals

### `computePlan(inputs)` — core calculation engine

Returns the full fueling plan object. Called via `useMemo` on every input change. Contains all science: Minetti energy polynomial, Jeukendrup CHO tiers, Sawka sweat rate, Lara sodium, fat oxidation fractions, protein needs, caffeine dosing, timeline generation.

### `parseGpx(text)` — GPX file parser

Uses DOM parser on the uploaded GPX XML. Sums distance via Haversine, accumulates elevation gain. Returns `{ distanceKm, elevationGainM, points, startLat, startLon }`.

### `fetchWeatherAt(lat, lon)` — weather integration

Async call to Open-Meteo (forecast) + Nominatim (reverse geocoding). Returns temp, humidity, wind, location label. Called from `fetchWeather()` handler using GPX start coordinates.

### `isHot` — derived state, not stored

```js
const isHot = tempC >= 25 || humidityPct > 70
```

Never store this in `useState`. Always compute it inline.

### Products & groups

`PRODUCTS` is the single source of truth (key → `{ cho, fat, protein, sodium, caffeine, kcal, type }`). `PRODUCT_GROUPS` groups them dynamically via `.filter()`. Add new products to `PRODUCTS` only; groups derive automatically from `type` and `caffeine` fields.

### Sport configuration

```js
SPORT_CONFIG = {
  Road:  { terrainMult: 1.0,  paceAdj: 0.0 },
  Trail: { terrainMult: 1.12, paceAdj: 1.0 },  // +1 min/km pace penalty
  Ultra: { terrainMult: 1.12, paceAdj: 1.0 },
}
```

### Ultra-specific sections

Rendered only when `sportType === "Ultra"` **and** `durationH >= 5`. Do not change this threshold without updating the scientific basis.

## Scientific Constants — Do Not Change Without Citation

Every constant has a peer-reviewed source. If you change a value, you must update the comment with the new citation. Key constants:

| Constant | Value | Source |
|---|---|---|
| `FLAT_KCAL_PER_KG_PER_KM` | 1.0 | Margaria 1963 |
| `GLYCOGEN_STORE_G_PER_KG` | 4.0 | Standard physiology |
| `GLYCOGEN_MAX_G` | 500 | Standard physiology |
| `SWEAT_RATE_BASE_ML_PER_H` | 600 | Sawka 2007 |
| `SWEAT_RATE_TEMP_ML_PER_DEG` | 25 | Sawka 2007 |
| `SODIUM_MG_PER_L_SWEAT` | 800 | Lara 2017 |
| CHO tiers | 4 tiers by duration | Jeukendrup 2014 |
| Minetti polynomial | `EC(g) = ...` | Minetti 2002 |

## Tabs

- **Protocol** (`plan`) — the fueling plan output
- **Calculations** (`calc`) — transparent methodology with formulas
- **References** (`refs`) — full bibliography

## PWA

Configured in `vite.config.js` with `vite-plugin-pwa`. Weather API endpoints use `NetworkOnly` caching strategy (always fresh). Base URL is `/trail-fuel-planner/`. Do not change the base path without updating `deploy.yml`.

## Conventions

- Pace is stored as decimal minutes-per-km internally; `PaceInput` handles MM:SS display/parsing
- `fmtDuration(min)` → `"5h 32m"`, `fmtPace(mpk)` → `"5:27"`
- Timeline items are generated inside `computePlan` and sorted by time offset (minutes from race start, negative = pre-race)
- All calculations reference `bodyWeightKg` — never hardcode a body weight
- Comments throughout cite paper authors and years; maintain this practice when adding formulas
