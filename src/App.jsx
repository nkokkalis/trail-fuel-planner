import { useState, useMemo, useRef } from "react";

// ─── SCIENCE-BASED CONSTANTS ────────────────────────────────────────
// Sources:
// - Margaria et al. (1963) J Appl Physiol 18(2):367-370 — 1 kcal/kg/km flat running
// - Minetti et al. (2002) J Appl Physiol 93(3):1039-1046 — energy cost on slopes
// - Jeukendrup (2011) J Sports Sci 29(S1):S17-27 — CHO intake tiers
// - Jeukendrup (2014) Sports Med 44(S1):25-33 — updated CHO guidance (>2.5h tier)
// - Thomas, Erdman & Burke (2016) Med Sci Sports Exerc 48(3):543-568 — ACSM/AND/DC Position Stand
// - Sawka et al. (2007) Med Sci Sports Exerc 39(2):377-390 — fluid replacement
// - Lara et al. (2017) Sports Med 47(S1):39-48 — sweat sodium concentration
// - Grgic et al. (2021) Br J Sports Med 55(15):929 — ISSN caffeine position

const FLAT_KCAL_PER_KG_PER_KM = 1.0;  // Margaria (1963); confirmed di Prampero (1986)
const TRAIL_TERRAIN_MULTIPLIER = 1.12; // +12% trail vs road; literature range 10–20%
const GLYCOGEN_STORE_G_PER_KG = 4.0;  // resting muscle glycogen, carb-adequate athlete
const GLYCOGEN_MAX_G = 500;
const KCAL_PER_G_CHO = 4;

// Minetti et al. (2002): EC(g) = 155.4g⁵ − 30.4g⁴ − 43.3g³ + 46.3g² + 19.5g + 3.6
// Units: J/kg per m of horizontal distance; g = grade as decimal (0.1 = 10%)
const MINETTI_FLAT_J = 3.6; // EC at grade 0 (treadmill); calibrated to Margaria via ratio

// CHO tiers — Jeukendrup (2011); >2.5h updated from Jeukendrup (2014)
const CHO_TIERS = [
  { maxHours: 1.0,      low: 0,  high: 30, note: "Optional — endogenous glycogen sufficient" },
  { maxHours: 2.0,      low: 30, high: 60, note: "Single-source CHO (glucose or maltodextrin)" },
  { maxHours: 2.5,      low: 60, high: 80, note: "Multiple-transport CHO advised (gel + drink)" },
  { maxHours: Infinity, low: 80, high: 90, note: "Trained gut required — glucose:fructose ≈ 2:1" },
];

// Sweat & sodium — Sawka et al. (2007); Lara et al. (2017)
// Temp scaling is a practical linear approximation (individual variation ±50%)
const SWEAT_RATE_BASE_ML_PER_H = 600;
const SWEAT_RATE_TEMP_ML_PER_DEG = 25;   // ml/h per °C above 15°C (approximate)
const SWEAT_RATE_HUMIDITY_FACTOR = 1.15; // +15% if humidity >70%
const SODIUM_MG_PER_L_SWEAT = 800;       // population mid-range; range 200–2000 mg/L (Lara 2017)

const PRODUCTS = {
  "Maurten Gel 160":        { cho: 40, sodium: 36,  caffeine: 0,   kcal: 160, weight: 50 },
  "Maurten Gel 100":        { cho: 25, sodium: 27,  caffeine: 0,   kcal: 100, weight: 40 },
  "Maurten Gel 100 Caf":    { cho: 25, sodium: 27,  caffeine: 100, kcal: 100, weight: 40 },
  "Maurten Drink Mix 320":  { cho: 79, sodium: 180, caffeine: 0,   kcal: 320, weight: "500ml" },
  "Maurten Drink Mix 160":  { cho: 39, sodium: 86,  caffeine: 0,   kcal: 160, weight: "500ml" },
  "Generic Gel (25g CHO)":  { cho: 25, sodium: 50,  caffeine: 0,   kcal: 100, weight: 32 },
  "Banana (medium)":        { cho: 27, sodium: 1,   caffeine: 0,   kcal: 105, weight: 120 },
  "Dates (3 pcs)":          { cho: 24, sodium: 0,   caffeine: 0,   kcal: 100, weight: 30 },
  "SiS GO Isotonic Gel":    { cho: 22, sodium: 20,  caffeine: 0,   kcal: 87,  weight: 60 },
  "Precision Fuel PF 30":   { cho: 30, sodium: 0,   caffeine: 0,   kcal: 120, weight: 51 },
};

// ─── GPX PARSING ─────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Invalid GPX file");
  const points = Array.from(doc.querySelectorAll("trkpt, rtept, wpt"));
  if (points.length < 2) throw new Error("GPX file has fewer than 2 track points");

  let distanceKm = 0, elevationGainM = 0;
  let prevLat = null, prevLon = null, prevEle = null;
  let startLat = null, startLon = null;

  for (const pt of points) {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    const eleEl = pt.querySelector("ele");
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;

    if (startLat === null) { startLat = lat; startLon = lon; }
    if (prevLat !== null) distanceKm += haversineKm(prevLat, prevLon, lat, lon);
    if (ele !== null && prevEle !== null && ele > prevEle) elevationGainM += ele - prevEle;

    prevLat = lat; prevLon = lon;
    if (ele !== null) prevEle = ele;
  }

  return {
    distanceKm: Math.round(distanceKm * 10) / 10,
    elevationGainM: Math.round(elevationGainM / 10) * 10,
    points: points.length,
    startLat, startLon,
  };
}

// ─── COMPUTATION ─────────────────────────────────────────────────────

function computePlan(inputs) {
  const { distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm, tempC, humidityPct, isHot, fuelProduct, caffeineProduct } = inputs;

  const avgGradePercent = (elevationGainM / (distanceKm * 1000)) * 100;
  const elevationPaceAdj = (elevationGainM / 100) * 1.0 / distanceKm;
  const trailPaceAdj = 0.4;
  const effectivePace = flatPaceMinPerKm + elevationPaceAdj + trailPaceAdj;
  const durationMin = distanceKm * effectivePace;
  const durationH = durationMin / 60;

  // ── Energy expenditure — Minetti (2002) polynomial, calibrated to Margaria (1963) ──
  // Model: assume 50% of distance climbs at avg grade, 50% descends at same grade.
  // Minetti cost ratio vs flat is used to scale Margaria's 1 kcal/kg/km.
  // Descents at moderate grades (< ~25%) cost LESS than flat (eccentric efficiency).
  const minettiEC = (g) => {
    const grade = Math.max(-0.45, Math.min(0.45, g));
    return 155.4*grade**5 - 30.4*grade**4 - 43.3*grade**3 + 46.3*grade**2 + 19.5*grade + 3.6;
  };
  const avgGrade = elevationGainM / (distanceKm * 500); // grade over the climbing half
  const climbRatio   = minettiEC(avgGrade)  / MINETTI_FLAT_J;
  const descentRatio = minettiEC(-avgGrade) / MINETTI_FLAT_J;
  const halfDist = distanceKm / 2;
  const climbKcal   = FLAT_KCAL_PER_KG_PER_KM * climbRatio   * bodyWeightKg * halfDist;
  const descentKcal = FLAT_KCAL_PER_KG_PER_KM * descentRatio * bodyWeightKg * halfDist;
  const baseCost = (climbKcal + descentKcal) * TRAIL_TERRAIN_MULTIPLIER;
  const totalKcal = Math.round(baseCost * (isHot ? 1.08 : 1.0));
  const kcalPerHour = Math.round(totalKcal / durationH);
  const avgGradePct = Math.round(avgGrade * 1000) / 10; // % with 1 decimal

  const glycogenG = Math.min(bodyWeightKg * GLYCOGEN_STORE_G_PER_KG, GLYCOGEN_MAX_G);
  const glycogenKcal = glycogenG * KCAL_PER_G_CHO;

  const tier = CHO_TIERS.find(t => durationH <= t.maxHours) || CHO_TIERS[CHO_TIERS.length - 1];
  const choPerHourTarget = Math.round((tier.low + tier.high) / 2);
  const fuelingDurationH = Math.max(0, durationH - 0.5);
  const totalChoNeeded = Math.round(choPerHourTarget * fuelingDurationH);

  const tempAboveRef = Math.max(0, tempC - 15);
  let sweatRateMlPerH = SWEAT_RATE_BASE_ML_PER_H + tempAboveRef * SWEAT_RATE_TEMP_ML_PER_DEG;
  if (humidityPct > 70) sweatRateMlPerH *= SWEAT_RATE_HUMIDITY_FACTOR;
  if (isHot) sweatRateMlPerH *= 1.1;
  sweatRateMlPerH = Math.round(sweatRateMlPerH / 25) * 25;
  const totalFluidL = Math.round(sweatRateMlPerH * durationH / 100) / 10;
  const sodiumPerH = Math.round((sweatRateMlPerH / 1000) * SODIUM_MG_PER_L_SWEAT);
  const totalSodium = Math.round(sodiumPerH * durationH);

  const caffeineLow = Math.round(bodyWeightKg * 3);
  const caffeineHigh = Math.round(bodyWeightKg * 6);

  const product = PRODUCTS[fuelProduct];
  const cafProduct = caffeineProduct !== "None" ? PRODUCTS[caffeineProduct] : null;
  const numGels = Math.ceil(totalChoNeeded / product.cho);
  const gelIntervalMin = numGels > 1 ? Math.round(fuelingDurationH * 60 / numGels) : null;

  const timeline = [];
  timeline.push({ time: -180, label: "Carb-rich meal", detail: `${Math.round(bodyWeightKg * 2)}–${Math.round(bodyWeightKg * 3)}g CHO (rice, toast, honey)`, type: "meal" });
  if (cafProduct) timeline.push({ time: -45, label: "Caffeine", detail: `1× ${caffeineProduct} (${cafProduct.caffeine}mg)`, type: "caffeine" });
  timeline.push({ time: -30, label: "Top-off", detail: `1× ${fuelProduct} or sip Drink Mix`, type: "fuel" });

  const startMin = 25;
  for (let i = 0; i < numGels; i++) {
    const raceMin = startMin + i * gelIntervalMin;
    if (raceMin < durationMin) {
      const km = Math.round(raceMin / effectivePace * 10) / 10;
      timeline.push({ time: raceMin, label: `Gel #${i + 1}`, detail: `1× ${fuelProduct} (~km ${km})`, type: "fuel", km });
    }
  }
  timeline.push({ time: Math.round(durationMin) + 10, label: "Recovery", detail: `${Math.round(bodyWeightKg)}g CHO + protein within 30 min`, type: "recovery" });

  return {
    durationMin: Math.round(durationMin), durationH: Math.round(durationH * 100) / 100,
    effectivePace: Math.round(effectivePace * 100) / 100,
    avgGradePercent: Math.round(avgGradePercent * 10) / 10,
    avgGradePct, climbRatio, descentRatio,
    climbKcal: Math.round(climbKcal), descentKcal: Math.round(descentKcal),
    totalKcal, kcalPerHour,
    glycogenG: Math.round(glycogenG), glycogenKcal,
    choPerHourTarget, choPerHourLow: tier.low, choPerHourHigh: tier.high, tierNote: tier.note,
    totalChoNeeded, sweatRateMlPerH, totalFluidL, sodiumPerH, totalSodium,
    caffeineLow, caffeineHigh, numGels, gelIntervalMin, timeline, fuelProduct,
  };
}

// ─── THEME ───────────────────────────────────────────────────────────

const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Instrument+Serif&family=DM+Sans:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }
  input[type=number]::-webkit-inner-spin-button { opacity: 1; }
  ::selection { background: var(--selection-bg); color: var(--text); }
  input:focus, select:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 2px var(--focus-ring); outline: none; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

const DARK_CSS = `
  :root {
    --page-bg: linear-gradient(160deg, #090f09 0%, #0c140b 50%, #0f1710 100%);
    --text:         #c8e0b8;
    --text-dim:     #7a9470;
    --text-muted:   #556650;
    --text-label:   #8a9a7e;
    --card-bg:      #101810;
    --card-border:  #1c2a18;
    --input-bg:     #182016;
    --input-border: #293d24;
    --input-text:   #d0e2c0;
    --accent:       #7ab860;
    --accent-dim:   #527a3a;
    --accent-text:  #8aca6e;
    --tab-bar:      #101810;
    --tab-active:   #1c2a18;
    --tab-text-on:  #c8e0b8;
    --tab-text-off: #4a5e44;
    --stat-bg:      #131c11;
    --stat-border:  #1e2e1a;
    --formula-bg:   #0c1209;
    --timeline-dot: #7ab860;
    --timeline-line:#1c2a18;
    --header-title: #a0c090;
    --header-sub:   #425c38;
    --warn-bg:      #281808;
    --warn-border:  #603010;
    --warn-text:    #e09050;
    --warn-label:   #c07830;
    --divider:      #1c2a18;
    --caveat-bg:    #181208;
    --caveat-border:#2a1e08;
    --caveat-text:  #806040;
    --caveat-label: #b08030;
    --chip-bg:      #1c2a18;
    --chip-text:    #7ab860;
    --weather-bg:   #0a1208;
    --weather-border:#1a2e18;
    --gpx-bg:       #0c1a0a;
    --gpx-border:   #1e3418;
    --selection-bg: #2a4828;
    --focus-ring:   rgba(122,184,96,0.22);
    --color-scheme: dark;
  }
`;

const LIGHT_CSS = `
  :root {
    --page-bg: linear-gradient(160deg, #f0f5ee 0%, #eaf2e5 50%, #ecf3e8 100%);
    --text:         #1e2e1a;
    --text-dim:     #486040;
    --text-muted:   #7a9070;
    --text-label:   #5a7850;
    --card-bg:      #ffffff;
    --card-border:  #ccdec2;
    --input-bg:     #f6faf3;
    --input-border: #bcd4b0;
    --input-text:   #1e2e1a;
    --accent:       #3a6e28;
    --accent-dim:   #4a8a34;
    --accent-text:  #3a6e28;
    --tab-bar:      #eef5e9;
    --tab-active:   #ffffff;
    --tab-text-on:  #1e2e1a;
    --tab-text-off: #7a9070;
    --stat-bg:      #f6faf3;
    --stat-border:  #ccdec2;
    --formula-bg:   #eaf4e3;
    --timeline-dot: #3a6e28;
    --timeline-line:#ccdec2;
    --header-title: #1e3c18;
    --header-sub:   #587850;
    --warn-bg:      #fff5ec;
    --warn-border:  #e8b880;
    --warn-text:    #984818;
    --warn-label:   #b86030;
    --divider:      #ccdec2;
    --caveat-bg:    #fffdf0;
    --caveat-border:#e8d890;
    --caveat-text:  #806840;
    --caveat-label: #a08020;
    --chip-bg:      #e4f0da;
    --chip-text:    #3a6e28;
    --weather-bg:   #eef8e8;
    --weather-border:#c0dab0;
    --gpx-bg:       #f0f8eb;
    --gpx-border:   #bcd8b0;
    --selection-bg: #a8d890;
    --focus-ring:   rgba(58,110,40,0.2);
    --color-scheme: light;
  }
`;

// ─── COMPONENTS ──────────────────────────────────────────────────────

function Divider({ label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 0 16px" }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <div style={{ flex: 1, height: 1, background: "var(--divider)" }} />
    </div>
  );
}

function NumberInput({ label, value, onChange, unit, min, max, step = 1, helpText }) {
  return (
    <div>
      <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-label)", marginBottom: 5 }}>
        {label}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="number"
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          min={min} max={max} step={step}
          style={{
            background: "var(--input-bg)",
            border: "1px solid var(--input-border)",
            borderRadius: 7,
            color: "var(--input-text)",
            padding: "8px 10px",
            fontSize: 15,
            fontFamily: "'JetBrains Mono', monospace",
            width: 88,
            transition: "border-color 0.15s",
          }}
        />
        {unit && <span style={{ color: "var(--text-muted)", fontSize: 12, fontFamily: "monospace" }}>{unit}</span>}
      </div>
      {helpText && <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 4, fontFamily: "monospace" }}>{helpText}</div>}
    </div>
  );
}

function SelectInput({ label, value, onChange, options }) {
  return (
    <div>
      <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-label)", marginBottom: 5 }}>
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: "var(--input-bg)",
          border: "1px solid var(--input-border)",
          borderRadius: 7,
          color: "var(--input-text)",
          padding: "8px 10px",
          fontSize: 13,
          fontFamily: "'JetBrains Mono', monospace",
          width: "100%",
          cursor: "pointer",
          transition: "border-color 0.15s",
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function StatCard({ label, value, unit, warn, formula }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{
      background: warn ? "var(--warn-bg)" : "var(--stat-bg)",
      border: `1px solid ${warn ? "var(--warn-border)" : "var(--stat-border)"}`,
      borderRadius: 10,
      padding: "14px 16px",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: warn ? "var(--warn-label)" : "var(--text-muted)" }}>
          {label}
        </span>
        {formula && (
          <button
            onClick={() => setShow(!show)}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "monospace", fontSize: 9, color: "var(--text-muted)", padding: "0 2px", textDecoration: "underline" }}
          >
            {show ? "hide" : "how?"}
          </button>
        )}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: warn ? "var(--warn-text)" : "var(--text)", lineHeight: 1 }}>
        {value}
        {unit && <span style={{ fontSize: 12, fontWeight: 400, color: warn ? "var(--warn-label)" : "var(--text-muted)", marginLeft: 5 }}>{unit}</span>}
      </div>
      {show && (
        <div style={{ marginTop: 10, padding: "8px 10px", background: "var(--formula-bg)", borderRadius: 5, fontSize: 10, fontFamily: "monospace", color: "var(--text-dim)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {formula}
        </div>
      )}
    </div>
  );
}

function TimelineItem({ item, isLast }) {
  const dotColor = { meal: "var(--text-dim)", fuel: "var(--accent)", caffeine: "var(--warn-label)", recovery: "var(--text-dim)" }[item.type] || "var(--text-dim)";
  const timeLabel = item.time < 0 ? `${item.time}m` : item.time > 200 ? "Post" : `+${item.time}m`;

  return (
    <div style={{ display: "flex", gap: 12, minHeight: 52 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 40, flexShrink: 0 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, marginTop: 4, flexShrink: 0 }} />
        {!isLast && <div style={{ width: 1, flex: 1, background: "var(--timeline-line)", marginTop: 4 }} />}
      </div>
      <div style={{ flex: 1, paddingBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", minWidth: 36 }}>{timeLabel}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{item.label}</span>
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 2, marginLeft: 44 }}>{item.detail}</div>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────

export default function TrailFuelPlanner() {
  const [isDark, setIsDark] = useState(true);

  // Inputs
  const [distanceKm, setDistanceKm] = useState(21);
  const [elevationGainM, setElevationGainM] = useState(1000);
  const [bodyWeightKg, setBodyWeightKg] = useState(75);
  const [flatPaceMinPerKm, setFlatPaceMinPerKm] = useState(5.5);
  const [tempC, setTempC] = useState(15);
  const [humidityPct, setHumidityPct] = useState(50);
  const [isHot, setIsHot] = useState(false);
  const [fuelProduct, setFuelProduct] = useState("Maurten Gel 160");
  const [caffeineProduct, setCaffeineProduct] = useState("Maurten Gel 100 Caf");

  // UI state
  const [activeTab, setActiveTab] = useState("plan");

  // GPX
  const [gpxFile, setGpxFile] = useState(null);
  const [gpxError, setGpxError] = useState(null);
  const gpxInputRef = useRef(null);

  // Weather
  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState(null);
  const [raceDate, setRaceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [raceHour, setRaceHour] = useState(8);

  const plan = useMemo(() => computePlan({
    distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm,
    tempC, humidityPct, isHot, fuelProduct, caffeineProduct,
  }), [distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm, tempC, humidityPct, isHot, fuelProduct, caffeineProduct]);

  // ── GPX handler ──
  const handleGpxUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setGpxError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = parseGpx(ev.target.result);
        setGpxFile({ name: file.name, ...parsed });
        setDistanceKm(parsed.distanceKm);
        setElevationGainM(parsed.elevationGainM);
      } catch (err) {
        setGpxError(err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── Weather handler ──
  const fetchWeatherAt = async (lat, lon) => {
    const [weatherRes, geoRes] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m` +
        `&wind_speed_unit=kmh&timezone=auto&start_date=${raceDate}&end_date=${raceDate}`
      ),
      fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
        { headers: { "Accept-Language": "en" } }
      ),
    ]);

    if (!weatherRes.ok) throw new Error();
    const data = await weatherRes.json();
    const h = data.hourly;
    const i = raceHour;

    let loc = "race location";
    if (geoRes.ok) {
      const geo = await geoRes.json();
      const a = geo.address ?? {};
      loc = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? loc;
    }

    return {
      temp: Math.round(h.temperature_2m[i]),
      feelsLike: Math.round(h.apparent_temperature[i]),
      humidity: h.relative_humidity_2m[i],
      windKmh: Math.round(h.wind_speed_10m[i]),
      location: loc,
      label: `${raceDate} · ${String(raceHour).padStart(2, "0")}:00`,
    };
  };

  const fetchWeather = () => {
    setWeatherLoading(true);
    setWeatherError(null);

    if (gpxFile?.startLat != null) {
      fetchWeatherAt(gpxFile.startLat, gpxFile.startLon)
        .then(setWeather)
        .catch(() => setWeatherError("Could not fetch forecast."))
        .finally(() => setWeatherLoading(false));
      return;
    }

    if (!navigator.geolocation) {
      setWeatherError("Load a GPX or allow location access.");
      setWeatherLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try { setWeather(await fetchWeatherAt(coords.latitude, coords.longitude)); }
        catch { setWeatherError("Could not fetch forecast."); }
        finally { setWeatherLoading(false); }
      },
      () => { setWeatherError("Location denied. Load a GPX to use race location."); setWeatherLoading(false); }
    );
  };

  const applyWeather = () => {
    if (!weather) return;
    setTempC(weather.temp);
    setHumidityPct(weather.humidity);
    setIsHot(weather.temp >= 25 || weather.feelsLike >= 27);
  };

  // ── Formatters ──
  const fmtDuration = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
  const fmtPace = (mpk) => `${Math.floor(mpk)}:${String(Math.round((mpk % 1) * 60)).padStart(2, "0")}`;

  // ── Shared input style helpers ──
  const inlineInputStyle = {
    background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 7,
    color: "var(--input-text)", padding: "8px 10px", fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace", outline: "none", colorScheme: isDark ? "dark" : "light",
    transition: "border-color 0.15s",
  };

  const labelStyle = {
    display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
    textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-label)", marginBottom: 5,
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--text)", fontFamily: "'DM Sans', 'Inter', sans-serif" }}>
      <style>{`${BASE_CSS}\n${isDark ? DARK_CSS : LIGHT_CSS}`}</style>

      {/* ── Header ── */}
      <header style={{ maxWidth: 760, margin: "0 auto", padding: "28px 24px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 26, color: "var(--header-title)", letterSpacing: "-0.02em", lineHeight: 1 }}>
            Trail Fuel Planner
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--header-sub)", marginTop: 6, letterSpacing: "0.12em" }}>
            SCIENCE-BASED · TRANSPARENT · NO BLACK BOX
          </div>
        </div>
        <button
          onClick={() => setIsDark(!isDark)}
          title="Toggle theme"
          style={{
            background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 8,
            color: "var(--text-dim)", padding: "7px 11px", fontSize: 15,
            cursor: "pointer", lineHeight: 1,
          }}
        >
          {isDark ? "☀️" : "🌙"}
        </button>
      </header>

      <main style={{ maxWidth: 760, margin: "0 auto", padding: "20px 24px 56px" }}>

        {/* ── Race Profile card ── */}
        <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 14, padding: "22px 24px", marginBottom: 16 }}>

          {/* Course */}
          <Divider label="Course" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 16 }}>
            <NumberInput label="Distance" value={distanceKm} onChange={setDistanceKm} unit="km" min={5} max={200} />
            <NumberInput label="Elevation +" value={elevationGainM} onChange={setElevationGainM} unit="m" min={0} max={10000} step={50} />
            <NumberInput label="Body Weight" value={bodyWeightKg} onChange={setBodyWeightKg} unit="kg" min={40} max={150} />
            <NumberInput label="Flat Pace" value={flatPaceMinPerKm} onChange={setFlatPaceMinPerKm} unit="min/km" min={3} max={12} step={0.1} helpText="Road half-marathon pace" />
          </div>

          {/* GPX */}
          <input ref={gpxInputRef} type="file" accept=".gpx" style={{ display: "none" }} onChange={handleGpxUpload} />
          {!gpxFile ? (
            <button
              onClick={() => gpxInputRef.current.click()}
              style={{
                background: "none", border: "1px dashed var(--input-border)", borderRadius: 8,
                color: "var(--text-muted)", padding: "9px 16px",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 7, transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--input-border)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              ↑ Load GPX — auto-fill distance & elevation
            </button>
          ) : (
            <div style={{ background: "var(--gpx-bg)", border: "1px solid var(--gpx-border)", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--accent-text)", fontWeight: 600 }}>✓ {gpxFile.name}</div>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  {gpxFile.distanceKm} km · +{gpxFile.elevationGainM} m · {gpxFile.points.toLocaleString()} pts
                </div>
              </div>
              <button onClick={() => { setGpxFile(null); setGpxError(null); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontFamily: "monospace", fontSize: 12 }}>✕</button>
            </div>
          )}
          {gpxError && <div style={{ color: "var(--warn-text)", fontFamily: "monospace", fontSize: 11, marginTop: 6 }}>{gpxError}</div>}

          {/* Race Day & Forecast */}
          <Divider label="Race Day & Forecast" />
          <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
            <div>
              <label style={labelStyle}>Race Date</label>
              <input type="date" value={raceDate} onChange={e => { setRaceDate(e.target.value); setWeather(null); }}
                style={{ ...inlineInputStyle }} />
            </div>
            <div>
              <label style={labelStyle}>Start Time</label>
              <select value={raceHour} onChange={e => { setRaceHour(Number(e.target.value)); setWeather(null); }}
                style={{ ...inlineInputStyle, cursor: "pointer" }}>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>
                ))}
              </select>
            </div>
            <button
              onClick={fetchWeather}
              disabled={weatherLoading}
              style={{
                background: "none", border: "1px dashed var(--input-border)", borderRadius: 8,
                color: weatherLoading ? "var(--text-muted)" : "var(--text-dim)",
                padding: "8px 16px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                cursor: weatherLoading ? "default" : "pointer", whiteSpace: "nowrap",
                transition: "all 0.15s", marginBottom: 1,
              }}
              onMouseEnter={e => { if (!weatherLoading) { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--input-border)"; e.currentTarget.style.color = "var(--text-dim)"; }}
            >
              {weatherLoading ? "⟳ Fetching…" : "⛅ Fetch forecast"}
            </button>
            {weatherError && <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--warn-text)", alignSelf: "flex-end", paddingBottom: 2 }}>{weatherError}</span>}
          </div>

          {weather && (
            <div style={{ background: "var(--weather-bg)", border: "1px solid var(--weather-border)", borderRadius: 8, padding: "12px 16px", marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 5 }}>
                  ⛅ {weather.location} · {weather.label}
                </div>
                <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                  <span style={{ color: "var(--text)" }}>{weather.temp}°C <span style={{ fontSize: 11, color: "var(--text-muted)" }}>feels {weather.feelsLike}°C</span></span>
                  <span style={{ color: "var(--text-dim)" }}>💧 {weather.humidity}%</span>
                  <span style={{ color: "var(--text-dim)" }}>💨 {weather.windKmh} km/h</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={applyWeather} style={{ background: "var(--chip-bg)", border: "1px solid var(--card-border)", borderRadius: 7, color: "var(--chip-text)", padding: "6px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, cursor: "pointer", fontWeight: 600 }}>
                  Apply to plan
                </button>
                <button onClick={() => { setWeather(null); setWeatherError(null); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}>✕</button>
              </div>
            </div>
          )}

          {/* Conditions */}
          <Divider label="Conditions" />
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
            <NumberInput label="Temperature" value={tempC} onChange={setTempC} unit="°C" min={-10} max={45} />
            <NumberInput label="Humidity" value={humidityPct} onChange={setHumidityPct} unit="%" min={0} max={100} />
            <div style={{ paddingBottom: 2 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", userSelect: "none" }}>
                <input type="checkbox" checked={isHot} onChange={e => setIsHot(e.target.checked)}
                  style={{ accentColor: "var(--accent)", width: 14, height: 14 }} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--text-label)" }}>Hot / humid (+8% energy)</span>
              </label>
            </div>
          </div>

          {/* Fueling */}
          <Divider label="Fueling" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <SelectInput label="Primary Fuel" value={fuelProduct} onChange={setFuelProduct} options={Object.keys(PRODUCTS)} />
            <SelectInput label="Caffeine Source" value={caffeineProduct} onChange={setCaffeineProduct} options={["None", ...Object.keys(PRODUCTS).filter(p => PRODUCTS[p].caffeine > 0)]} />
          </div>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", gap: 2, marginBottom: 16, background: "var(--tab-bar)", borderRadius: 10, padding: "3px" }}>
          {[{ id: "plan", label: "Protocol" }, { id: "calc", label: "Calculations" }].map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                flex: 1, padding: "9px 16px",
                background: activeTab === t.id ? "var(--tab-active)" : "transparent",
                border: activeTab === t.id ? "1px solid var(--card-border)" : "1px solid transparent",
                borderRadius: 8,
                color: activeTab === t.id ? "var(--tab-text-on)" : "var(--tab-text-off)",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                fontWeight: activeTab === t.id ? 600 : 400,
                textTransform: "uppercase", letterSpacing: "0.1em",
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: activeTab === t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Protocol Tab ── */}
        {activeTab === "plan" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Top row: effort stats */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
              <StatCard label="Est. Duration" value={fmtDuration(plan.durationMin)} unit=""
                formula={`Flat: ${fmtPace(flatPaceMinPerKm)}/km\n+elev: +${(plan.effectivePace - flatPaceMinPerKm - 0.4).toFixed(2)} min/km\n+trail: +0.4 min/km\n= ${fmtPace(plan.effectivePace)}/km × ${distanceKm}km`} />
              <StatCard label="Energy Cost" value={plan.totalKcal.toLocaleString()} unit="kcal"
                formula={`Minetti (2002) polynomial @ avg grade ${plan.avgGradePct}%\nClimb ×${plan.climbRatio.toFixed(2)} × ${bodyWeightKg}kg × ${(distanceKm/2).toFixed(1)}km = ${Math.round(plan.climbKcal)} kcal\nDescent ×${plan.descentRatio.toFixed(2)} × ${bodyWeightKg}kg × ${(distanceKm/2).toFixed(1)}km = ${Math.round(plan.descentKcal)} kcal\n× ${TRAIL_TERRAIN_MULTIPLIER} trail terrain${isHot ? "\n× 1.08 heat" : ""}\n= ${plan.totalKcal} kcal\nMargaria (1963); Minetti (2002)`} />
              <StatCard label="CHO Target" value={plan.choPerHourTarget} unit="g/h"
                formula={`Duration: ${plan.durationH}h → tier ${plan.choPerHourLow}–${plan.choPerHourHigh} g/h\nMid-range target: ${plan.choPerHourTarget} g/h\n"${plan.tierNote}"\nJeukendrup (2011), ACSM (2016)`} />
            </div>

            {/* Bottom row: execution stats */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
              <StatCard label="In-Race CHO" value={plan.totalChoNeeded} unit="g total" />
              <StatCard label="Fluid" value={plan.sweatRateMlPerH} unit="ml/h"
                formula={`Base 600 ml/h @ 15°C (Sawka 2007)\n+${Math.max(0, tempC - 15)}°C × 25 ml/h = +${Math.max(0, tempC - 15) * 25} ml/h${humidityPct > 70 ? `\n× 1.15 humidity (reduced evaporative cooling)` : ""}${isHot ? `\n× 1.10 heat stress` : ""}\n= ${plan.sweatRateMlPerH} ml/h\n→ ${plan.totalFluidL}L total\n\nLinear temp scaling is approximate.\nIndividual variation ±50%.\nSweat testing gives real data.`} />
              <StatCard label="Sodium" value={plan.sodiumPerH} unit="mg/h"
                formula={`${plan.sweatRateMlPerH} ml/h × 800 mg/L\n= ${plan.sodiumPerH} mg/h\n→ ${plan.totalSodium} mg total\nRange: 500–1000 mg/L`} />
              <StatCard label="Caffeine" value={`${plan.caffeineLow}–${plan.caffeineHigh}`} unit="mg"
                formula={`3–6 mg/kg × ${bodyWeightKg}kg\n= ${plan.caffeineLow}–${plan.caffeineHigh} mg\nTake 45–60 min pre-race\nACSM (2016)`} />
            </div>

            {/* Carry list */}
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "18px 20px" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", marginBottom: 14 }}>Carry List</div>
              <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>In-Race</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--accent-text)", fontWeight: 600 }}>{plan.numGels}× {fuelProduct}</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                    {plan.numGels * PRODUCTS[fuelProduct].cho}g CHO · every ~{plan.gelIntervalMin} min
                  </div>
                </div>
                {caffeineProduct !== "None" && (
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>Caffeine</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--warn-label)", fontWeight: 600 }}>1× {caffeineProduct}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{PRODUCTS[caffeineProduct].caffeine}mg · take at −45 min</div>
                  </div>
                )}
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>Hydration</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--text)", fontWeight: 600 }}>{plan.totalFluidL}L</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{plan.sweatRateMlPerH} ml/h · {plan.sodiumPerH} mg Na/h</div>
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "18px 20px" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", marginBottom: 16 }}>Race Day Timeline</div>
              {plan.timeline.map((item, i) => (
                <TimelineItem key={i} item={item} isLast={i === plan.timeline.length - 1} />
              ))}
            </div>
          </div>
        )}

        {/* ── Calculations Tab ── */}
        {activeTab === "calc" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "20px 24px" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", marginBottom: 18 }}>Transparent Methodology</div>
              <div style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.85, display: "flex", flexDirection: "column", gap: 16 }}>
                {[
                  { n: "1", title: "Duration Estimate", body: <>
                    Flat pace: {fmtPace(flatPaceMinPerKm)}/km<br />
                    Elevation: +{(elevationGainM / 100).toFixed(0)} min spread → +{(plan.effectivePace - flatPaceMinPerKm - 0.4).toFixed(2)} min/km<br />
                    Trail surface: +0.40 min/km<br />
                    <span style={{ color: "var(--text)" }}>→ {fmtPace(plan.effectivePace)}/km effective · {fmtDuration(plan.durationMin)}</span>
                  </> },
                  { n: "2", title: "Energy Expenditure", body: <>
                    Minetti (2002) polynomial — metabolic cost on slopes<br />
                    Avg climb grade: {plan.avgGradePct}% (gain / half-distance)<br />
                    Climb ×{plan.climbRatio.toFixed(2)} × {bodyWeightKg}kg × {(distanceKm/2).toFixed(1)}km = {plan.climbKcal} kcal<br />
                    Descent ×{plan.descentRatio.toFixed(2)} × {bodyWeightKg}kg × {(distanceKm/2).toFixed(1)}km = {plan.descentKcal} kcal<br />
                    × {TRAIL_TERRAIN_MULTIPLIER} trail terrain{isHot ? " · ×1.08 heat" : ""}<br />
                    <span style={{ color: "var(--text)" }}>→ {plan.totalKcal.toLocaleString()} kcal · {plan.kcalPerHour} kcal/h</span><br />
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Margaria (1963); Minetti et al. (2002)</span>
                  </> },
                  { n: "3", title: "Glycogen Stores", body: <>
                    ~{GLYCOGEN_STORE_G_PER_KG}g/kg in fed athlete (max {GLYCOGEN_MAX_G}g carb-loaded)<br />
                    Your stores: {plan.glycogenG}g = {plan.glycogenKcal} kcal<br />
                    <span style={{ color: "var(--text)" }}>→ Covers ~{Math.round(plan.glycogenKcal / plan.kcalPerHour * 60)} min at race intensity</span>
                  </> },
                  { n: "4", title: "CHO Per Hour (Tiers)", body: <>
                    &lt;1h: 0–30 g/h · 1–2h: 30–60 g/h · 2–2.5h: 60–80 g/h · &gt;2.5h: 80–90 g/h<br />
                    Your {plan.durationH}h → tier {plan.choPerHourLow}–{plan.choPerHourHigh} g/h<br />
                    <span style={{ color: "var(--text)" }}>→ Target {plan.choPerHourTarget} g/h · {plan.totalChoNeeded}g total</span><br />
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Jeukendrup (2011) J Sports Sci 29(S1):S17-27; (2014) Sports Med 44(S1):25-33</span>
                  </> },
                  { n: "5", title: "Hydration & Sodium", body: <>
                    Base 600 ml/h @ 15°C · +{Math.max(0, tempC - 15) * 25} ml/h temp · {humidityPct > 70 ? "×1.15 humidity · " : ""}{isHot ? "×1.10 heat" : ""}<br />
                    <span style={{ color: "var(--text)" }}>→ {plan.sweatRateMlPerH} ml/h · {plan.totalFluidL}L total</span><br />
                    Sodium: {plan.sweatRateMlPerH} ml/h × 800 mg/L = {plan.sodiumPerH} mg/h<br />
                    <span style={{ color: "var(--text)" }}>→ {plan.totalSodium} mg total</span><br />
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Sawka et al. (2007) MSSE 39(2):377; Lara et al. (2017) Sports Med 47(S1):39 — sweat [Na⁺] range 200–2000 mg/L</span>
                  </> },
                  { n: "6", title: "Caffeine", body: <>
                    3–6 mg/kg × {bodyWeightKg}kg = {plan.caffeineLow}–{plan.caffeineHigh} mg<br />
                    <span style={{ color: "var(--text)" }}>→ Take 45–60 min pre-race or split in-race</span><br />
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Thomas et al. (2016) MSSE 48(3):543; Grgic et al. (2021) BJSM 55:929</span>
                  </> },
                ].map(({ n, title, body }) => (
                  <div key={n}>
                    <div style={{ color: "var(--accent-text)", fontWeight: 600, marginBottom: 4 }}>{n}. {title}</div>
                    <div>{body}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: "var(--caveat-bg)", border: "1px solid var(--caveat-border)", borderRadius: 12, padding: "16px 20px" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--caveat-label)", marginBottom: 10 }}>
                Limitations & Caveats
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--caveat-text)", lineHeight: 1.8 }}>
                {[
                  "All calculations are estimates. Individual running economy varies ±20–30%.",
                  "CHO absorption is gut-dependent. Train with race-day products.",
                  "Elevation cost assumes average grade. Steep sections (>15%) cost disproportionately more.",
                  "Sodium needs are highly individual. Sweat testing (e.g. Precision Hydration) gives real data.",
                  "Caffeine sensitivity varies widely. Test in training — not on race day.",
                  "Weather, altitude, sleep, stress, and pre-race nutrition all affect requirements.",
                ].map((c, i) => <div key={i}>· {c}</div>)}
              </div>
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ marginTop: 40, textAlign: "center", fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.7 }}>
          Not medical advice. Margaria (1963) · Minetti (2002) · Jeukendrup (2011, 2014) · Thomas, Erdman & Burke (2016) · Sawka (2007) · Lara (2017) · Grgic (2021).<br />
          Always validate your fueling strategy in training before race day.
        </div>
      </main>
    </div>
  );
}
