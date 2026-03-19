import { useState, useMemo, useRef } from "react";

// ─── SCIENCE-BASED CONSTANTS ────────────────────────────────────────
// Sources:
// - Jeukendrup (2011): CHO oxidation rates during exercise
// - ACSM Position Stand on Nutrition and Athletic Performance (2016)
// - Minetti et al. (2002): Energy cost of walking/running on grades
// - Compendium of Physical Activities (2024 update)
// - Precision Fuel & Hydration guidelines
// - ~1 kcal/kg/km flat running (well-established rule of thumb)
// - +2 kcal/kg per 100m elevation gain (research consensus)
// - Trail terrain: +10-15% metabolic cost over road

const FLAT_KCAL_PER_KG_PER_KM = 1.0;
const ELEVATION_KCAL_PER_KG_PER_100M = 2.0;
const TRAIL_TERRAIN_MULTIPLIER = 1.12; // +12% for technical trail
const GLYCOGEN_STORE_G_PER_KG = 4.0; // ~4g glycogen/kg in fed athlete
const GLYCOGEN_MAX_G = 500; // upper cap for well-carb-loaded athlete
const KCAL_PER_G_CHO = 4;

// CHO/h guidelines by duration tier (Jeukendrup 2011, ACSM 2016)
const CHO_TIERS = [
  { maxHours: 1.0, low: 0, high: 30, note: "Optional — glycogen sufficient" },
  { maxHours: 2.0, low: 30, high: 60, note: "Moderate intake recommended" },
  { maxHours: 3.0, low: 60, high: 80, note: "Glucose + fructose blend advised" },
  { maxHours: Infinity, low: 80, high: 90, note: "Max absorption — trained gut required" },
];

// Sodium / hydration tiers
// Base sweat rate ~600ml/h at 15°C; +30ml/h per °C above 15; humidity >70% adds ~15%
// Sodium loss: ~500mg/L sweat (moderate sweater); salty sweaters can be 1000+mg/L
const SODIUM_BASE_MG_PER_H = 400;
const SWEAT_RATE_BASE_ML_PER_H = 600;
const SWEAT_RATE_TEMP_ML_PER_DEG = 30; // above 15°C reference
const SWEAT_RATE_HUMIDITY_FACTOR = 1.15; // if humidity >70%
const SODIUM_MG_PER_L_SWEAT = 800; // mid-range (500–1000 mg/L)

// Product database (per unit)
const PRODUCTS = {
  "Maurten Gel 160": { cho: 40, sodium: 36, caffeine: 0, kcal: 160, weight: 50 },
  "Maurten Gel 100": { cho: 25, sodium: 27, caffeine: 0, kcal: 100, weight: 40 },
  "Maurten Gel 100 Caf": { cho: 25, sodium: 27, caffeine: 100, kcal: 100, weight: 40 },
  "Maurten Drink Mix 320": { cho: 79, sodium: 180, caffeine: 0, kcal: 320, weight: "500ml" },
  "Maurten Drink Mix 160": { cho: 39, sodium: 86, caffeine: 0, kcal: 160, weight: "500ml" },
  "Generic Gel (25g CHO)": { cho: 25, sodium: 50, caffeine: 0, kcal: 100, weight: 32 },
  "Banana (medium)": { cho: 27, sodium: 1, caffeine: 0, kcal: 105, weight: 120 },
  "Dates (3 pcs)": { cho: 24, sodium: 0, caffeine: 0, kcal: 100, weight: 30 },
  "SiS GO Isotonic Gel": { cho: 22, sodium: 20, caffeine: 0, kcal: 87, weight: 60 },
  "Precision Fuel PF 30 Gel": { cho: 30, sodium: 0, caffeine: 0, kcal: 120, weight: 51 },
};

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

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
  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Invalid GPX file");

  const points = Array.from(doc.querySelectorAll("trkpt, rtept, wpt"));
  if (points.length < 2) throw new Error("GPX file has fewer than 2 track points");

  let distanceKm = 0;
  let elevationGainM = 0;
  let prevLat = null, prevLon = null, prevEle = null;

  let startLat = null, startLon = null;

  for (const pt of points) {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    const eleEl = pt.querySelector("ele");
    const ele = eleEl ? parseFloat(eleEl.textContent) : null;

    if (startLat === null) { startLat = lat; startLon = lon; }

    if (prevLat !== null) {
      distanceKm += haversineKm(prevLat, prevLon, lat, lon);
    }
    if (ele !== null && prevEle !== null && ele > prevEle) {
      elevationGainM += ele - prevEle;
    }

    prevLat = lat;
    prevLon = lon;
    if (ele !== null) prevEle = ele;
  }

  return {
    distanceKm: Math.round(distanceKm * 10) / 10,
    elevationGainM: Math.round(elevationGainM / 10) * 10,
    points: points.length,
    startLat,
    startLon,
  };
}

function computePlan(inputs) {
  const { distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm, tempC, humidityPct, isHot, fuelProduct, caffeineProduct } = inputs;

  // ── Estimated duration ──
  // Rule of thumb: +1 min/km per 100m gain averaged over distance
  const avgGradePercent = (elevationGainM / (distanceKm * 1000)) * 100;
  const elevationPaceAdj = (elevationGainM / 100) * 1.0 / distanceKm; // +1 min/km per 100m avg
  const trailPaceAdj = 0.4; // +0.4 min/km for trail terrain
  const effectivePace = flatPaceMinPerKm + elevationPaceAdj + trailPaceAdj;
  const durationMin = distanceKm * effectivePace;
  const durationH = durationMin / 60;

  // ── Energy expenditure ──
  const flatCost = FLAT_KCAL_PER_KG_PER_KM * bodyWeightKg * distanceKm;
  const elevCost = ELEVATION_KCAL_PER_KG_PER_100M * bodyWeightKg * (elevationGainM / 100);
  const baseCost = (flatCost + elevCost) * TRAIL_TERRAIN_MULTIPLIER;
  const heatAdj = isHot ? 1.08 : 1.0; // +8% in heat
  const totalKcal = Math.round(baseCost * heatAdj);
  const kcalPerHour = Math.round(totalKcal / durationH);

  // ── Glycogen stores ──
  const glycogenG = Math.min(bodyWeightKg * GLYCOGEN_STORE_G_PER_KG, GLYCOGEN_MAX_G);
  const glycogenKcal = glycogenG * KCAL_PER_G_CHO;

  // ── CHO needs ──
  const tier = CHO_TIERS.find(t => durationH <= t.maxHours) || CHO_TIERS[CHO_TIERS.length - 1];
  const choPerHourLow = tier.low;
  const choPerHourHigh = tier.high;
  // Conservative recommendation: mid-range for non-elite
  const choPerHourTarget = Math.round((choPerHourLow + choPerHourHigh) / 2);
  // Total in-race CHO (first 30-45 min from glycogen, then fueling)
  const fuelingDurationH = Math.max(0, durationH - 0.5); // start fueling at ~30 min
  const totalChoNeeded = Math.round(choPerHourTarget * fuelingDurationH);

  // ── Hydration & Sodium (temperature + humidity driven) ──
  const refTemp = 15;
  const tempAboveRef = Math.max(0, tempC - refTemp);
  let sweatRateMlPerH = SWEAT_RATE_BASE_ML_PER_H + tempAboveRef * SWEAT_RATE_TEMP_ML_PER_DEG;
  if (humidityPct > 70) sweatRateMlPerH *= SWEAT_RATE_HUMIDITY_FACTOR;
  if (isHot) sweatRateMlPerH *= 1.1; // extra 10% buffer for heat stress
  sweatRateMlPerH = Math.round(sweatRateMlPerH / 25) * 25; // round to nearest 25ml
  const totalFluidMl = Math.round(sweatRateMlPerH * durationH);
  const totalFluidL = Math.round(totalFluidMl / 100) / 10;

  // Sodium from sweat rate (not just a flat multiplier)
  const sodiumPerH = Math.round((sweatRateMlPerH / 1000) * SODIUM_MG_PER_L_SWEAT);
  const totalSodium = Math.round(sodiumPerH * durationH);

  // ── Caffeine ──
  const caffeineLow = Math.round(bodyWeightKg * 3);
  const caffeineHigh = Math.round(bodyWeightKg * 6);

  // ── Product plan ──
  const product = PRODUCTS[fuelProduct];
  const cafProduct = caffeineProduct !== "None" ? PRODUCTS[caffeineProduct] : null;
  const numGels = Math.ceil(totalChoNeeded / product.cho);
  const gelIntervalMin = numGels > 1 ? Math.round(fuelingDurationH * 60 / numGels) : null;

  // Build timeline
  const timeline = [];
  // Pre-race: -60 min carb-rich meal (not counted in products)
  timeline.push({ time: -180, label: "Carb-rich meal", detail: `${Math.round(bodyWeightKg * 2)}-${Math.round(bodyWeightKg * 3)}g CHO (e.g. rice, toast, honey)`, type: "meal" });
  timeline.push({ time: -30, label: "Top-off", detail: `1× ${fuelProduct} or sip Drink Mix`, type: "fuel" });

  if (cafProduct) {
    timeline.push({ time: -45, label: "Caffeine", detail: `1× ${caffeineProduct} (${cafProduct.caffeine}mg)`, type: "caffeine" });
  }

  // In-race gels
  const startMin = 25; // first gel ~25 min in
  for (let i = 0; i < numGels; i++) {
    const raceMin = startMin + (i * gelIntervalMin);
    if (raceMin < durationMin) {
      const km = Math.round(raceMin / effectivePace * 10) / 10;
      timeline.push({
        time: raceMin,
        label: `Gel #${i + 1}`,
        detail: `1× ${fuelProduct} (~km ${km})`,
        type: "fuel",
        km,
      });
    }
  }

  // Post-race
  timeline.push({ time: Math.round(durationMin) + 10, label: "Recovery", detail: `${Math.round(bodyWeightKg * 1)}g CHO + protein within 30 min`, type: "recovery" });

  return {
    durationMin: Math.round(durationMin),
    durationH: Math.round(durationH * 100) / 100,
    effectivePace: Math.round(effectivePace * 100) / 100,
    avgGradePercent: Math.round(avgGradePercent * 10) / 10,
    totalKcal,
    kcalPerHour,
    glycogenG: Math.round(glycogenG),
    glycogenKcal,
    choPerHourTarget,
    choPerHourLow,
    choPerHourHigh,
    tierNote: tier.note,
    totalChoNeeded,
    sweatRateMlPerH,
    totalFluidL,
    sodiumPerH,
    totalSodium,
    caffeineLow,
    caffeineHigh,
    numGels,
    gelIntervalMin,
    timeline,
    fuelProduct,
  };
}

// ─── COMPONENTS ──────────────────────────────────────────────────────

function NumberInput({ label, value, onChange, unit, min, max, step = 1, helpText }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#8a9a7e", marginBottom: 4 }}>
        {label}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="number"
          value={value}
          onChange={e => onChange(Number(e.target.value))}
          min={min}
          max={max}
          step={step}
          style={{
            background: "#1a2218",
            border: "1px solid #2d3b28",
            borderRadius: 6,
            color: "#d4e4cc",
            padding: "8px 12px",
            fontSize: 16,
            fontFamily: "'JetBrains Mono', monospace",
            width: 100,
            outline: "none",
          }}
        />
        {unit && <span style={{ color: "#6b7f62", fontSize: 13, fontFamily: "monospace" }}>{unit}</span>}
      </div>
      {helpText && <div style={{ color: "#5a6b52", fontSize: 11, marginTop: 3, fontFamily: "monospace" }}>{helpText}</div>}
    </div>
  );
}

function SelectInput({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#8a9a7e", marginBottom: 4 }}>
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: "#1a2218",
          border: "1px solid #2d3b28",
          borderRadius: 6,
          color: "#d4e4cc",
          padding: "8px 12px",
          fontSize: 14,
          fontFamily: "'JetBrains Mono', monospace",
          minWidth: 220,
          outline: "none",
          cursor: "pointer",
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function StatCard({ label, value, unit, warn, formula }) {
  const [showFormula, setShowFormula] = useState(false);
  return (
    <div style={{
      background: warn ? "#2a1a10" : "#151e13",
      border: `1px solid ${warn ? "#6b3b1a" : "#263322"}`,
      borderRadius: 8,
      padding: "14px 16px",
      position: "relative",
    }}>
      <div style={{ fontFamily: "monospace", fontSize: 11, color: warn ? "#c9844a" : "#6b8a5e", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
        {label}
        {formula && (
          <span
            onClick={() => setShowFormula(!showFormula)}
            style={{ cursor: "pointer", marginLeft: 6, color: "#4a6340", fontSize: 10, textDecoration: "underline" }}
          >
            {showFormula ? "hide" : "how?"}
          </span>
        )}
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 24, fontWeight: 700, color: warn ? "#e8a060" : "#c8e0b8" }}>
        {value}
        <span style={{ fontSize: 13, fontWeight: 400, color: warn ? "#a06838" : "#6b8a5e", marginLeft: 6 }}>{unit}</span>
      </div>
      {showFormula && (
        <div style={{
          marginTop: 8,
          padding: "8px 10px",
          background: "#0d140b",
          borderRadius: 4,
          fontSize: 11,
          fontFamily: "monospace",
          color: "#7a9470",
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
        }}>
          {formula}
        </div>
      )}
    </div>
  );
}

function TimelineItem({ item, isLast }) {
  const colors = {
    meal: "#5a7a4a",
    fuel: "#8ab870",
    caffeine: "#c09050",
    recovery: "#5a8a7a",
  };
  const c = colors[item.type] || "#6b8a5e";
  const timeLabel = item.time < 0 ? `${item.time} min` : item.time > 200 ? "Post" : `${item.time} min`;

  return (
    <div style={{ display: "flex", gap: 14, minHeight: 56 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 48 }}>
        <div style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: c,
          border: `2px solid ${c}`,
          flexShrink: 0,
          marginTop: 3,
        }} />
        {!isLast && <div style={{ width: 1, flex: 1, background: "#263322", marginTop: 4 }} />}
      </div>
      <div style={{ flex: 1, paddingBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", minWidth: 60 }}>{timeLabel}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: "#c8e0b8" }}>{item.label}</span>
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 12, color: "#7a9470", marginTop: 2, marginLeft: 70 }}>{item.detail}</div>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────

export default function TrailFuelPlanner() {
  const [distanceKm, setDistanceKm] = useState(21);
  const [elevationGainM, setElevationGainM] = useState(1000);
  const [bodyWeightKg, setBodyWeightKg] = useState(75);
  const [flatPaceMinPerKm, setFlatPaceMinPerKm] = useState(5.5);
  const [tempC, setTempC] = useState(15);
  const [humidityPct, setHumidityPct] = useState(50);
  const [isHot, setIsHot] = useState(false);
  const [fuelProduct, setFuelProduct] = useState("Maurten Gel 160");
  const [caffeineProduct, setCaffeineProduct] = useState("Maurten Gel 100 Caf");
  const [activeTab, setActiveTab] = useState("plan");
  const [gpxFile, setGpxFile] = useState(null);
  const [gpxError, setGpxError] = useState(null);
  const gpxInputRef = useRef(null);
  const [weather, setWeather] = useState(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState(null);
  const [raceDate, setRaceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [raceHour, setRaceHour] = useState(8);

  const plan = useMemo(() => computePlan({
    distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm, tempC, humidityPct, isHot, fuelProduct, caffeineProduct,
  }), [distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm, tempC, humidityPct, isHot, fuelProduct, caffeineProduct]);

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
    // Reset input so the same file can be re-uploaded
    e.target.value = "";
  };

  const clearGpx = () => {
    setGpxFile(null);
    setGpxError(null);
  };

  const fetchWeatherAt = async (lat, lon) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m` +
      `&wind_speed_unit=kmh&timezone=auto&start_date=${raceDate}&end_date=${raceDate}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Weather API request failed");
    const data = await res.json();
    // hourly arrays have 24 entries for the day; pick the race hour index
    const h = data.hourly;
    const idx = raceHour; // hour 0–23 maps directly to index
    const tzParts = data.timezone?.split("/") ?? [];
    const locationName = tzParts[tzParts.length - 1]?.replace(/_/g, " ") ?? "race location";
    return {
      temp: Math.round(h.temperature_2m[idx]),
      feelsLike: Math.round(h.apparent_temperature[idx]),
      humidity: h.relative_humidity_2m[idx],
      windKmh: Math.round(h.wind_speed_10m[idx]),
      location: locationName,
      forecastLabel: `${raceDate} ${String(raceHour).padStart(2, "0")}:00`,
    };
  };

  const fetchWeather = () => {
    setWeatherLoading(true);
    setWeatherError(null);

    // Prefer GPX start coordinates
    if (gpxFile?.startLat != null) {
      fetchWeatherAt(gpxFile.startLat, gpxFile.startLon)
        .then(setWeather)
        .catch(() => setWeatherError("Could not fetch weather. Try again."))
        .finally(() => setWeatherLoading(false));
      return;
    }

    // Fall back to browser geolocation
    if (!navigator.geolocation) {
      setWeatherError("Load a GPX file or allow location access.");
      setWeatherLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const w = await fetchWeatherAt(coords.latitude, coords.longitude);
          setWeather(w);
        } catch {
          setWeatherError("Could not fetch weather. Try again.");
        } finally {
          setWeatherLoading(false);
        }
      },
      () => {
        setWeatherError("Location access denied. Load a GPX file to use race location.");
        setWeatherLoading(false);
      }
    );
  };

  const applyWeather = () => {
    if (!weather) return;
    setTempC(weather.temp);
    setHumidityPct(weather.humidity);
    setIsHot(weather.temp >= 25 || weather.feelsLike >= 27);
  };

  const formatDuration = (min) => {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  };

  const formatPace = (minPerKm) => {
    const m = Math.floor(minPerKm);
    const s = Math.round((minPerKm - m) * 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  const tabs = [
    { id: "plan", label: "Protocol" },
    { id: "calc", label: "Calculations" },
  ];

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(170deg, #0a100a 0%, #0d150c 40%, #101810 100%)",
      color: "#c8e0b8",
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Instrument+Serif&family=DM+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        input[type=number]::-webkit-inner-spin-button { opacity: 1; }
        ::selection { background: #3a5a30; color: #e0f0d8; }
        input:focus, select:focus { border-color: #4a6a3a !important; box-shadow: 0 0 0 2px rgba(74,106,58,0.25); }
      `}</style>

      {/* Header */}
      <div style={{ padding: "32px 24px 20px", maxWidth: 720, margin: "0 auto" }}>
        <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 28, color: "#a8c898", letterSpacing: "-0.02em" }}>
          Trail Fuel Planner
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "#4a6340", marginTop: 4, letterSpacing: "0.04em" }}>
          SCIENCE-BASED · TRANSPARENT FORMULAS · NO BLACK BOX
        </div>
      </div>

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "0 24px 40px" }}>

        {/* Input Section */}
        <div style={{
          background: "#111a0f",
          border: "1px solid #1e2c1a",
          borderRadius: 12,
          padding: 24,
          marginBottom: 24,
        }}>
          <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
            Race Profile
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            <NumberInput label="Distance" value={distanceKm} onChange={setDistanceKm} unit="km" min={5} max={200} />
            <NumberInput label="Elevation +" value={elevationGainM} onChange={setElevationGainM} unit="m" min={0} max={10000} step={50} />
            <NumberInput label="Body Weight" value={bodyWeightKg} onChange={setBodyWeightKg} unit="kg" min={40} max={150} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, alignItems: "start" }}>
            <NumberInput label="Flat Pace" value={flatPaceMinPerKm} onChange={setFlatPaceMinPerKm} unit="min/km" min={3} max={12} step={0.1} helpText="Your road half pace" />
            <NumberInput label="Temperature" value={tempC} onChange={setTempC} unit="°C" min={-10} max={45} />
            <NumberInput label="Humidity" value={humidityPct} onChange={setHumidityPct} unit="%" min={0} max={100} />
            <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", paddingBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={isHot} onChange={e => setIsHot(e.target.checked)} style={{ accentColor: "#6b8a5e" }} />
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#8a9a7e" }}>Hot / humid</span>
              </label>
            </div>
          </div>

          {/* Weather fetch */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <div>
                <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#8a9a7e", marginBottom: 4 }}>Race Date</label>
                <input
                  type="date"
                  value={raceDate}
                  onChange={e => { setRaceDate(e.target.value); setWeather(null); }}
                  style={{ background: "#1a2218", border: "1px solid #2d3b28", borderRadius: 6, color: "#d4e4cc", padding: "7px 10px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", outline: "none", colorScheme: "dark" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#8a9a7e", marginBottom: 4 }}>Start Time</label>
                <select
                  value={raceHour}
                  onChange={e => { setRaceHour(Number(e.target.value)); setWeather(null); }}
                  style={{ background: "#1a2218", border: "1px solid #2d3b28", borderRadius: 6, color: "#d4e4cc", padding: "7px 10px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", outline: "none", cursor: "pointer" }}
                >
                  {Array.from({ length: 24 }, (_, i) => (
                    <option key={i} value={i}>{String(i).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", paddingBottom: 1 }}>
                <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "transparent", marginBottom: 4 }}>_</label>
                <button
                  onClick={fetchWeather}
                  disabled={weatherLoading}
                  style={{
                    background: "transparent",
                    border: "1px dashed #2d3b28",
                    borderRadius: 8,
                    color: weatherLoading ? "#3a4a32" : "#5a7a4a",
                    padding: "7px 16px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12,
                    cursor: weatherLoading ? "default" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={e => { if (!weatherLoading) { e.currentTarget.style.borderColor = "#4a6a3a"; e.currentTarget.style.color = "#8ab870"; }}}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#2d3b28"; e.currentTarget.style.color = "#5a7a4a"; }}
                >
                  {weatherLoading ? "⟳ Fetching..." : "⛅ Fetch forecast"}
                </button>
              </div>
              {weatherError && <span style={{ fontFamily: "monospace", fontSize: 11, color: "#c05050", alignSelf: "flex-end", paddingBottom: 4 }}>{weatherError}</span>}
            </div>
            {weather && (
              <div style={{
                background: "#0a1410",
                border: "1px solid #1e3428",
                borderRadius: 8,
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
              }}>
                <div>
                  <div style={{ fontFamily: "monospace", fontSize: 10, color: "#4a6a52", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
                    ⛅ Forecast — {weather.location} · {weather.forecastLabel}
                  </div>
                  <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: "#c8e0b8" }}>{weather.temp}°C <span style={{ color: "#5a7a5a", fontSize: 11 }}>feels {weather.feelsLike}°C</span></span>
                    <span style={{ fontFamily: "monospace", fontSize: 13, color: "#8ab8a0" }}>💧 {weather.humidity}%</span>
                    <span style={{ fontFamily: "monospace", fontSize: 13, color: "#8ab8a0" }}>💨 {weather.windKmh} km/h</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={applyWeather}
                    style={{
                      background: "#1a3028",
                      border: "1px solid #2a5040",
                      borderRadius: 6,
                      color: "#8ab870",
                      padding: "6px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    Apply to plan
                  </button>
                  <button
                    onClick={() => { setWeather(null); setWeatherError(null); }}
                    style={{ background: "transparent", border: "none", color: "#4a5a42", cursor: "pointer", fontFamily: "monospace", fontSize: 12, padding: "4px 8px" }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
          {/* GPX Upload */}
          <div style={{ marginTop: 8, marginBottom: 16 }}>
            <input
              ref={gpxInputRef}
              type="file"
              accept=".gpx"
              style={{ display: "none" }}
              onChange={handleGpxUpload}
            />
            {!gpxFile ? (
              <button
                onClick={() => gpxInputRef.current.click()}
                style={{
                  background: "transparent",
                  border: "1px dashed #2d3b28",
                  borderRadius: 8,
                  color: "#5a7a4a",
                  padding: "10px 18px",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 12,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  transition: "border-color 0.15s, color 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "#4a6a3a"; e.currentTarget.style.color = "#8ab870"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "#2d3b28"; e.currentTarget.style.color = "#5a7a4a"; }}
              >
                <span style={{ fontSize: 14 }}>↑</span> Load GPX — auto-fill distance & elevation
              </button>
            ) : (
              <div style={{
                background: "#0d1a0b",
                border: "1px solid #2a4028",
                borderRadius: 8,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "#8ab870" }}>
                    ✓ {gpxFile.name}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a7a4a", marginTop: 2 }}>
                    {gpxFile.distanceKm} km · +{gpxFile.elevationGainM} m · {gpxFile.points} pts
                  </div>
                </div>
                <button
                  onClick={clearGpx}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#4a5a42",
                    cursor: "pointer",
                    fontFamily: "monospace",
                    fontSize: 12,
                    padding: "2px 6px",
                  }}
                >
                  ✕ clear
                </button>
              </div>
            )}
            {gpxError && (
              <div style={{ color: "#c05050", fontFamily: "monospace", fontSize: 11, marginTop: 6 }}>
                GPX error: {gpxError}
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 4 }}>
            <SelectInput label="Primary Fuel" value={fuelProduct} onChange={setFuelProduct} options={Object.keys(PRODUCTS)} />
            <SelectInput label="Caffeine Source" value={caffeineProduct} onChange={setCaffeineProduct} options={["None", ...Object.keys(PRODUCTS).filter(p => PRODUCTS[p].caffeine > 0)]} />
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, background: "#111a0f", borderRadius: 8, padding: 3 }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                flex: 1,
                padding: "10px 16px",
                background: activeTab === t.id ? "#1e2c1a" : "transparent",
                border: "none",
                borderRadius: 6,
                color: activeTab === t.id ? "#c8e0b8" : "#5a6b52",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: activeTab === t.id ? 600 : 400,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* PROTOCOL TAB */}
        {activeTab === "plan" && (
          <div>
            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 24 }}>
              <StatCard
                label="Est. Duration"
                value={formatDuration(plan.durationMin)}
                unit=""
                formula={`Flat pace: ${formatPace(flatPaceMinPerKm)}/km\n+ Elevation: +${(plan.effectivePace - flatPaceMinPerKm - 0.4).toFixed(1)} min/km from ${elevationGainM}m gain\n+ Trail terrain: +0.4 min/km\n= ${formatPace(plan.effectivePace)}/km effective\n× ${distanceKm} km = ${formatDuration(plan.durationMin)}`}
              />
              <StatCard
                label="Energy Cost"
                value={plan.totalKcal.toLocaleString()}
                unit="kcal"
                formula={`Flat: ${FLAT_KCAL_PER_KG_PER_KM} × ${bodyWeightKg}kg × ${distanceKm}km = ${Math.round(bodyWeightKg * distanceKm)} kcal\nElev: ${ELEVATION_KCAL_PER_KG_PER_100M} × ${bodyWeightKg}kg × ${(elevationGainM/100).toFixed(1)} = ${Math.round(ELEVATION_KCAL_PER_KG_PER_100M * bodyWeightKg * elevationGainM/100)} kcal\n× ${TRAIL_TERRAIN_MULTIPLIER} trail factor${isHot ? `\n× 1.08 heat` : ""}\n= ${plan.totalKcal} kcal total`}
              />
              <StatCard
                label="CHO Target"
                value={plan.choPerHourTarget}
                unit="g/h"
                formula={`Duration: ${plan.durationH}h\nTier: ${plan.choPerHourLow}-${plan.choPerHourHigh} g/h\n"${plan.tierNote}"\nTarget (midrange): ${plan.choPerHourTarget} g/h\n\nSource: Jeukendrup (2011),\nACSM Position Stand (2016)`}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 28 }}>
              <StatCard label="In-Race CHO" value={plan.totalChoNeeded} unit="g total" />
              <StatCard
                label="Fluid"
                value={`${plan.sweatRateMlPerH}`}
                unit="ml/h"
                formula={`Base sweat rate: 600 ml/h at 15°C\n+30 ml/h per °C above 15°C (${Math.max(0,tempC-15)}°C above)\n${humidityPct > 70 ? `×1.15 humidity (${humidityPct}% > 70%)\n` : ""}${isHot ? `×1.10 heat stress\n` : ""}= ${plan.sweatRateMlPerH} ml/h\n→ ${plan.totalFluidL}L over ${plan.durationH}h\n\nSip steadily; don't over-drink.\nSource: ACSM (2007)`}
              />
              <StatCard
                label="Sodium"
                value={plan.sodiumPerH}
                unit="mg/h"
                formula={`Sweat rate: ${plan.sweatRateMlPerH} ml/h\nSodium in sweat: ~800 mg/L (mid-range)\n= ${plan.sodiumPerH} mg/h\n→ ${plan.totalSodium} mg total\n\nIndividual sweat testing\n(Precision Hydration) recommended.\nRange: 500–1000 mg/L`}
              />
              <StatCard label="Caffeine" value={`${plan.caffeineLow}–${plan.caffeineHigh}`} unit="mg total" formula={`3-6 mg/kg body weight\n= ${plan.caffeineLow}–${plan.caffeineHigh} mg\n\nTake 45-60 min before race\nor split during race.\n\nSource: ACSM (2016)`} />
            </div>

            {/* Inventory */}
            <div style={{
              background: "#111a0f",
              border: "1px solid #1e2c1a",
              borderRadius: 12,
              padding: 20,
              marginBottom: 24,
            }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
                Carry List
              </div>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#4a6340", marginBottom: 6 }}>IN-RACE</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: "#8ab870" }}>
                    {plan.numGels}× {fuelProduct}
                  </div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", marginTop: 2 }}>
                    = {plan.numGels * PRODUCTS[fuelProduct].cho}g CHO · every ~{plan.gelIntervalMin} min
                  </div>
                </div>
                {caffeineProduct !== "None" && (
                  <div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "#4a6340", marginBottom: 6 }}>CAFFEINE</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: "#c09050" }}>
                      1× {caffeineProduct}
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", marginTop: 2 }}>
                      = {PRODUCTS[caffeineProduct].caffeine}mg caffeine
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Timeline */}
            <div style={{
              background: "#111a0f",
              border: "1px solid #1e2c1a",
              borderRadius: 12,
              padding: 20,
            }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                Race Day Timeline
              </div>
              {plan.timeline.map((item, i) => (
                <TimelineItem key={i} item={item} isLast={i === plan.timeline.length - 1} />
              ))}
            </div>
          </div>
        )}

        {/* CALCULATIONS TAB */}
        {activeTab === "calc" && (
          <div>
            <div style={{
              background: "#111a0f",
              border: "1px solid #1e2c1a",
              borderRadius: 12,
              padding: 24,
              marginBottom: 20,
            }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#5a6b52", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>
                Transparent Methodology
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 12, color: "#7a9470", lineHeight: 1.8 }}>
                <div style={{ marginBottom: 16 }}>
                  <span style={{ color: "#8ab870", fontWeight: 600 }}>1. Duration Estimate</span><br />
                  Base flat pace: {formatPace(flatPaceMinPerKm)}/km<br />
                  Elevation adjustment: +{(elevationGainM / 100).toFixed(0)} min spread = +{((plan.effectivePace - flatPaceMinPerKm - 0.4)).toFixed(2)} min/km<br />
                  Trail terrain: +0.4 min/km (technical surface, 10-15% cost increase)<br />
                  Effective pace: {formatPace(plan.effectivePace)}/km<br />
                  <span style={{ color: "#c8e0b8" }}>→ {formatDuration(plan.durationMin)} estimated finish</span>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <span style={{ color: "#8ab870", fontWeight: 600 }}>2. Energy Expenditure</span><br />
                  Flat running cost: ~1 kcal/kg/km × {bodyWeightKg}kg × {distanceKm}km = {Math.round(bodyWeightKg * distanceKm)} kcal<br />
                  Elevation cost: ~2 kcal/kg per 100m × {bodyWeightKg}kg × {(elevationGainM/100).toFixed(1)} = {Math.round(2 * bodyWeightKg * elevationGainM / 100)} kcal<br />
                  Trail multiplier: ×{TRAIL_TERRAIN_MULTIPLIER} (uneven surface){isHot ? `\nHeat multiplier: ×1.08` : ""}<br />
                  <span style={{ color: "#c8e0b8" }}>→ {plan.totalKcal.toLocaleString()} kcal total ({plan.kcalPerHour} kcal/h)</span>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <span style={{ color: "#8ab870", fontWeight: 600 }}>3. Glycogen Stores</span><br />
                  Fed athlete: ~{GLYCOGEN_STORE_G_PER_KG}g/kg (max ~{GLYCOGEN_MAX_G}g with carb loading)<br />
                  Your stores: ~{plan.glycogenG}g = {plan.glycogenKcal} kcal<br />
                  <span style={{ color: "#c8e0b8" }}>→ Covers first ~{Math.round(plan.glycogenKcal / plan.kcalPerHour * 60)} min at race intensity</span>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <span style={{ color: "#8ab870", fontWeight: 600 }}>4. CHO Per Hour (Evidence-Based Tiers)</span><br />
                  {"<"}1h: 0-30g/h (glycogen sufficient)<br />
                  1-2h: 30-60g/h (moderate intake)<br />
                  2-3h: 60-80g/h (glucose+fructose advised)<br />
                  {">"}3h: 80-90g/h (trained gut required)<br />
                  Your duration ({plan.durationH}h): <span style={{ color: "#c8e0b8" }}>{plan.choPerHourLow}-{plan.choPerHourHigh}g/h → target {plan.choPerHourTarget}g/h</span><br />
                  <span style={{ fontSize: 10, color: "#4a6340" }}>Jeukendrup (2011), ACSM/AND/DC Position Stand (2016)</span>
                </div>
                <div style={{ marginBottom: 16 }}>
                  <span style={{ color: "#8ab870", fontWeight: 600 }}>5. Hydration & Sodium</span><br />
                  Sweat rate base: 600 ml/h at 15°C, +30 ml/h per °C above reference<br />
                  {humidityPct > 70 && <>Humidity {humidityPct}% {">"} 70%: ×1.15<br /></>}
                  {isHot && <>Heat stress flag: ×1.10<br /></>}
                  <span style={{ color: "#c8e0b8" }}>→ {plan.sweatRateMlPerH} ml/h · {plan.totalFluidL}L over {plan.durationH}h</span><br />
                  Sodium in sweat: ~800 mg/L (moderate sweater mid-range)<br />
                  <span style={{ color: "#c8e0b8" }}>→ {plan.sodiumPerH} mg/h · {plan.totalSodium} mg total</span><br />
                  <span style={{ fontSize: 10, color: "#4a6340" }}>Sweat sodium varies 500–1000+ mg/L. Sweat testing gives real data.</span>
                </div>
                <div>
                  <span style={{ color: "#8ab870", fontWeight: 600 }}>6. Caffeine</span><br />
                  Evidence range: 3-6 mg/kg body weight<br />
                  <span style={{ color: "#c8e0b8" }}>→ {plan.caffeineLow}-{plan.caffeineHigh} mg, taken 45-60 min pre-race</span><br />
                  <span style={{ fontSize: 10, color: "#4a6340" }}>Peak plasma at ~45 min; Gel 100 Caf = 100mg ≈ 1 espresso</span>
                </div>
              </div>
            </div>

            <div style={{
              background: "#1a1510",
              border: "1px solid #2a2018",
              borderRadius: 12,
              padding: 20,
            }}>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#c09050", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
                Limitations & Caveats
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 11, color: "#8a7050", lineHeight: 1.7 }}>
                • All calculations are estimates. Individual variation in running economy is ±20-30%.<br />
                • CHO absorption is gut-dependent. Train your gut with race-day products in training.<br />
                • Elevation cost assumes average grade. Steep sections ({">"}15%) cost disproportionately more.<br />
                • Sodium needs are highly individual. Sweat testing (e.g. Precision Hydration) gives real data.<br />
                • Caffeine sensitivity varies. Test in training first; don't try race day as a first.<br />
                • Weather, altitude, sleep, stress, and pre-race nutrition all affect requirements.
              </div>
            </div>
          </div>
        )}


        {/* Footer */}
        <div style={{ marginTop: 32, padding: 16, textAlign: "center" }}>
          <div style={{ fontFamily: "monospace", fontSize: 10, color: "#3a4a32", lineHeight: 1.6 }}>
            Not medical advice. Based on: Jeukendrup (2011), ACSM/AND/DC Position Stand (2016),<br />
            Minetti et al. (2002), Compendium of Physical Activities (2024).<br />
            Always test your fueling strategy in training before race day.
          </div>
        </div>
      </div>
    </div>
  );
}
