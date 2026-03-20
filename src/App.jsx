import { useState, useMemo, useRef, useEffect } from "react";
import * as Sentry from "@sentry/react";

// ─── SCIENCE-BASED CONSTANTS ──────────────────────────────────────────
// - Margaria et al. (1963) J Appl Physiol 18(2):367-370 — 1 kcal/kg/km flat running
// - Minetti et al. (2002) J Appl Physiol 93(3):1039-1046 — energy cost on slopes
// - Jeukendrup (2011) J Sports Sci 29(S1):S17-27 — CHO intake tiers
// - Jeukendrup (2014) Sports Med 44(S1):25-33 — updated CHO guidance (>2.5h tier)
// - Thomas, Erdman & Burke (2016) Med Sci Sports Exerc 48(3):543-568 — ACSM/AND/DC Position Stand
// - Sawka et al. (2007) Med Sci Sports Exerc 39(2):377-390 — fluid replacement
// - Lara et al. (2017) Sports Med 47(S1):39-48 — sweat sodium concentration
// - Grgic et al. (2021) Br J Sports Med 55(15):929 — ISSN caffeine position stand
// - Brooks & Mercier (1994) J Appl Physiol 76(6):2253-2261 — fat oxidation & crossover concept
// - Tarnopolsky (2004) Nutrition 20(7-8):662-668 — protein needs in ultra-endurance
// - Keinänen et al. (2022) Nutrients 14(12):2405 — protein in ultra-marathon

const FLAT_KCAL_PER_KG_PER_KM = 1.0;  // Margaria (1963); confirmed di Prampero (1986)
const GLYCOGEN_STORE_G_PER_KG = 4.0;  // resting muscle glycogen, carb-adequate athlete
const GLYCOGEN_MAX_G = 500;
const KCAL_PER_G_CHO = 4;

// Minetti et al. (2002): EC(g) = 155.4g⁵ − 30.4g⁴ − 43.3g³ + 46.3g² + 19.5g + 3.6
// Units: J/kg per m of horizontal distance; g = grade as decimal (0.1 = 10%)
const MINETTI_FLAT_J = 3.6; // EC at grade 0; ratio used to scale Margaria's 1 kcal/kg/km

// CHO tiers — Jeukendrup (2011); >2.5h updated from Jeukendrup (2014)
const CHO_TIERS = [
  { maxHours: 1.0,      low: 0,  high: 30, note: "Optional — endogenous glycogen sufficient" },
  { maxHours: 2.0,      low: 30, high: 60, note: "Single-source CHO (glucose or maltodextrin)" },
  { maxHours: 2.5,      low: 60, high: 80, note: "Multiple-transport CHO advised (gel + drink)" },
  { maxHours: Infinity, low: 80, high: 90, note: "Trained gut required — glucose:fructose ≈ 2:1" },
];

// Sweat & sodium — Sawka et al. (2007); Lara et al. (2017)
const SWEAT_RATE_BASE_ML_PER_H = 600;
const SWEAT_RATE_TEMP_ML_PER_DEG = 25;   // ml/h per °C above 15°C (approximate)
const SWEAT_RATE_HUMIDITY_FACTOR = 1.15; // +15% if humidity >70%
const SODIUM_MG_PER_L_SWEAT = 800;       // population mid-range; range 200–2000 mg/L (Lara 2017)

// ─── SPORT CONFIG ─────────────────────────────────────────────────────
const SPORT_CONFIG = {
  Road:  { terrainMult: 1.0,  paceAdj: 0.0, desc: "Paved roads — no terrain penalty" },
  Trail: { terrainMult: 1.12, paceAdj: 1.0, desc: "Mountain & singletrack — +12% energy, +1.0 min/km" },
};

// ─── PRODUCTS ─────────────────────────────────────────────────────────
// { cho, fat, protein, sodium, caffeine, kcal, type }
const PRODUCTS = {
  // Gels
  "GU Energy Gel":        { cho: 22, fat: 0,  protein: 0,   sodium: 55,   caffeine: 0,   kcal: 100, type: "gel" },
  "GU Energy Gel Caf":    { cho: 22, fat: 0,  protein: 0,   sodium: 55,   caffeine: 40,  kcal: 100, type: "gel" },
  "Spring Energy Gel":    { cho: 20, fat: 3,  protein: 1,   sodium: 40,   caffeine: 0,   kcal: 110, type: "gel" },
  "Clif Shot Gel":        { cho: 24, fat: 0,  protein: 0,   sodium: 50,   caffeine: 0,   kcal: 100, type: "gel" },
  "Clif Shot Gel Caf":    { cho: 24, fat: 0,  protein: 0,   sodium: 50,   caffeine: 25,  kcal: 100, type: "gel" },
  "SiS GO Gel":           { cho: 22, fat: 0,  protein: 0,   sodium: 20,   caffeine: 0,   kcal: 87,  type: "gel" },
  "SiS GO Caf Gel":       { cho: 22, fat: 0,  protein: 0,   sodium: 20,   caffeine: 75,  kcal: 87,  type: "gel" },
  "Maurten Gel 100":      { cho: 25, fat: 0,  protein: 0,   sodium: 27,   caffeine: 0,   kcal: 100, type: "gel" },
  "Maurten Gel 100 Caf":  { cho: 25, fat: 0,  protein: 0,   sodium: 27,   caffeine: 100, kcal: 100, type: "gel" },
  "Maurten Gel 160":      { cho: 40, fat: 0,  protein: 0,   sodium: 36,   caffeine: 0,   kcal: 160, type: "gel" },
  "PF 30 Gel":            { cho: 30, fat: 0,  protein: 0,   sodium: 0,    caffeine: 0,   kcal: 120, type: "gel" },
  // Drink Mixes (per serving/scoop mixed in ~500ml)
  "Tailwind (1 scoop)":   { cho: 25, fat: 0,  protein: 0,   sodium: 310,  caffeine: 0,   kcal: 100, type: "drink" },
  "Skratch (1 scoop)":    { cho: 21, fat: 0,  protein: 0,   sodium: 380,  caffeine: 0,   kcal: 80,  type: "drink" },
  "SiS Beta Fuel":        { cho: 40, fat: 0,  protein: 0,   sodium: 180,  caffeine: 0,   kcal: 160, type: "drink" },
  "Maurten Mix 160":      { cho: 39, fat: 0,  protein: 0,   sodium: 86,   caffeine: 0,   kcal: 160, type: "drink" },
  "Maurten Mix 320":      { cho: 79, fat: 0,  protein: 0,   sodium: 180,  caffeine: 0,   kcal: 320, type: "drink" },
  "PH 1000 (1 tablet)":   { cho: 0,  fat: 0,  protein: 0,   sodium: 1000, caffeine: 0,   kcal: 4,   type: "drink" },
  // Bars
  "Clif Bloks (3 pcs)":   { cho: 24, fat: 0.5, protein: 0,  sodium: 50,   caffeine: 0,   kcal: 100, type: "bar" },
  "Clif Bar":             { cho: 45, fat: 6,  protein: 10,  sodium: 150,  caffeine: 0,   kcal: 270, type: "bar" },
  "Stroopwafel":          { cho: 30, fat: 5,  protein: 2,   sodium: 70,   caffeine: 0,   kcal: 160, type: "bar" },
  "RX Bar":               { cho: 23, fat: 9,  protein: 12,  sodium: 280,  caffeine: 0,   kcal: 210, type: "bar" },
  // Real Food
  "Banana (medium)":      { cho: 27, fat: 0,  protein: 1,   sodium: 1,    caffeine: 0,   kcal: 105, type: "food" },
  "Medjool Dates (3)":    { cho: 24, fat: 0,  protein: 0.5, sodium: 0,    caffeine: 0,   kcal: 100, type: "food" },
  "Rice Cake":            { cho: 25, fat: 3,  protein: 3,   sodium: 200,  caffeine: 0,   kcal: 140, type: "food" },
  "PB&J Half Sandwich":   { cho: 30, fat: 10, protein: 7,   sodium: 220,  caffeine: 0,   kcal: 235, type: "food" },
  "Gummy Bears (40g)":    { cho: 30, fat: 0,  protein: 2,   sodium: 20,   caffeine: 0,   kcal: 130, type: "food" },
  "Pretzels (30g)":       { cho: 22, fat: 1,  protein: 2,   sodium: 480,  caffeine: 0,   kcal: 110, type: "food" },
  "Baby Food Pouch":      { cho: 15, fat: 2,  protein: 1,   sodium: 30,   caffeine: 0,   kcal: 80,  type: "food" },
  "Chicken Broth (cup)":  { cho: 1,  fat: 1,  protein: 6,   sodium: 860,  caffeine: 0,   kcal: 38,  type: "food" },
  "Hard-Boiled Egg":      { cho: 0,  fat: 5,  protein: 6,   sodium: 65,   caffeine: 0,   kcal: 70,  type: "food" },
  "Avocado (1/2)":        { cho: 4,  fat: 15, protein: 2,   sodium: 5,    caffeine: 0,   kcal: 160, type: "food" },
  "Potato + Salt":        { cho: 20, fat: 0,  protein: 2,   sodium: 400,  caffeine: 0,   kcal: 88,  type: "food" },
};

const PRODUCT_GROUPS = {
  "Gels":            Object.keys(PRODUCTS).filter(k => PRODUCTS[k].type === "gel"   && !PRODUCTS[k].caffeine),
  "Caffeinated Gels":Object.keys(PRODUCTS).filter(k => PRODUCTS[k].type === "gel"   && PRODUCTS[k].caffeine > 0),
  "Drink Mixes":     Object.keys(PRODUCTS).filter(k => PRODUCTS[k].type === "drink"),
  "Bars":            Object.keys(PRODUCTS).filter(k => PRODUCTS[k].type === "bar"),
  "Real Food":       Object.keys(PRODUCTS).filter(k => PRODUCTS[k].type === "food"),
};

const NO_CAFFEINE = "None";
const CAFFEINE_PRODUCTS = [NO_CAFFEINE, ...Object.keys(PRODUCTS).filter(k => (PRODUCTS[k].caffeine ?? 0) > 0)];

// ─── AID STATION STRATEGY ─────────────────────────────────────────────
const AID_STATION_STRATEGY = {
  short: {
    label: "Short Ultra (<8h)",
    focus: "CHO-dominant. Gels between aid stations; real food for gut comfort.",
    foods: [
      { name: "Banana (medium)",   note: "Quick CHO + potassium" },
      { name: "Rice Cake",         note: "Savory option, sustained energy" },
      { name: "Pretzels (30g)",    note: "Sodium + CHO combo" },
      { name: "Medjool Dates (3)", note: "Dense natural CHO" },
      { name: "Tailwind (1 scoop)",note: "CHO + electrolytes in one" },
    ],
  },
  medium: {
    label: "Medium Ultra (8–16h)",
    focus: "Real food at every aid station. Rotate flavors to prevent palate fatigue.",
    foods: [
      { name: "PB&J Half Sandwich", note: "Fat + protein + CHO" },
      { name: "Rice Cake",          note: "Savory staple" },
      { name: "Chicken Broth (cup)",note: "Sodium + warmth at night" },
      { name: "Banana (medium)",    note: "Potassium, easy to eat" },
      { name: "Potato + Salt",      note: "High-sodium real food" },
      { name: "Baby Food Pouch",    note: "Easy if appetite drops" },
    ],
  },
  long: {
    label: "Long Ultra (>16h)",
    focus: "Protein + fat meals at aid stations. CHO gels between. Broth for sodium.",
    foods: [
      { name: "Hard-Boiled Egg",    note: "Complete protein, savory" },
      { name: "Avocado (1/2)",      note: "Fat for sustained energy" },
      { name: "Chicken Broth (cup)",note: "Sodium critical overnight" },
      { name: "PB&J Half Sandwich", note: "Calorie-dense real meal" },
      { name: "Rice Cake",          note: "Digestible staple" },
      { name: "Baby Food Pouch",    note: "Works when nothing else does" },
    ],
  },
};

// ─── GPX PARSING ──────────────────────────────────────────────────────

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

// ─── COMPUTATION ──────────────────────────────────────────────────────

function computePlan(inputs) {
  const {
    sportType, distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm,
    tempC, humidityPct, isHot, fuelProduct, caffeineProduct,
  } = inputs;

  const cfg = SPORT_CONFIG[sportType] || SPORT_CONFIG.Trail;
  // Ultra auto-detection: road > 42 km, or trail by ITRA effort-distance (km + elevGain/100) > 42
  const effortDistanceKm = distanceKm + (sportType === "Trail" ? elevationGainM / 100 : 0);
  const isUltra = effortDistanceKm > 42;

  const elevationPaceAdj = (elevationGainM / 100) * 1.0 / distanceKm;
  const effectivePace = flatPaceMinPerKm + elevationPaceAdj + cfg.paceAdj;
  const durationMin = distanceKm * effectivePace;
  const durationH = durationMin / 60;

  // ── Energy — Minetti (2002) polynomial, calibrated to Margaria (1963) ──
  const minettiEC = (g) => {
    const grade = Math.max(-0.45, Math.min(0.45, g));
    return 155.4*grade**5 - 30.4*grade**4 - 43.3*grade**3 + 46.3*grade**2 + 19.5*grade + 3.6;
  };
  const avgGrade = elevationGainM / (distanceKm * 500);
  const climbRatio   = minettiEC(avgGrade)  / MINETTI_FLAT_J;
  const descentRatio = minettiEC(-avgGrade) / MINETTI_FLAT_J;
  const halfDist = distanceKm / 2;
  const climbKcal   = FLAT_KCAL_PER_KG_PER_KM * climbRatio   * bodyWeightKg * halfDist;
  const descentKcal = FLAT_KCAL_PER_KG_PER_KM * descentRatio * bodyWeightKg * halfDist;
  const baseCost = (climbKcal + descentKcal) * cfg.terrainMult;
  const totalKcal = Math.round(baseCost * (isHot ? 1.08 : 1.0));
  const kcalPerHour = Math.round(totalKcal / durationH);
  const avgGradePct = Math.round(avgGrade * 1000) / 10;

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

  // ── Ultra-specific: fat oxidation + protein ──
  // Fat fraction scales with duration (Brooks & Mercier 1994 crossover concept)
  // ~30% at 5h → ~55% at 15h+ (practical estimate; individual variation is high)
  let fatFractionOfEnergy = 0, fatGPerH = 0, proteinGPerH = 0, totalProteinG = 0, totalFatG = 0;
  if (isUltra && durationH >= 5) {
    fatFractionOfEnergy = Math.min(0.55, 0.30 + (durationH - 5) * 0.025);
    fatGPerH = Math.round((kcalPerHour * fatFractionOfEnergy / 9) * 10) / 10;
    // Tarnopolsky (2004) — 0.25 g/kg/h up to 8h; 0.30 g/kg/h beyond (Keinänen 2022)
    proteinGPerH = Math.round((durationH <= 8 ? 0.25 : 0.30) * bodyWeightKg * 10) / 10;
    totalFatG = Math.round(fatGPerH * durationH);
    totalProteinG = Math.round(proteinGPerH * durationH);
  }

  const aidTier = durationH < 8 ? "short" : durationH < 16 ? "medium" : "long";

  const product = PRODUCTS[fuelProduct];
  const cafProduct = caffeineProduct !== NO_CAFFEINE ? PRODUCTS[caffeineProduct] : null;
  const numGels = Math.ceil(totalChoNeeded / product.cho);
  const gelIntervalMin = numGels > 1 ? Math.round(fuelingDurationH * 60 / numGels) : null;

  // ── Timeline ──
  const timeline = [];
  timeline.push({
    time: -180, label: "Carb-rich meal",
    detail: `${Math.round(bodyWeightKg * 2)}–${Math.round(bodyWeightKg * 3)}g CHO (rice, toast, honey)`,
    type: "meal",
  });

  if (isUltra && durationH >= 5) {
    // Ultra: caffeine periodization — two in-race doses at 30% and 60% (Grgic 2021)
    timeline.push({ time: -20, label: "Pre-race top-off", detail: `1× ${fuelProduct} · water`, type: "fuel" });
    if (cafProduct) {
      const dose1Min = Math.round(durationMin * 0.30);
      const dose2Min = Math.round(durationMin * 0.60);
      timeline.push({ time: dose1Min, label: "Caffeine dose 1", detail: `1× ${caffeineProduct} (~${(dose1Min / 60).toFixed(1)}h in)`, type: "caffeine" });
      timeline.push({ time: dose2Min, label: "Caffeine dose 2", detail: `1× ${caffeineProduct} (~${(dose2Min / 60).toFixed(1)}h in)`, type: "caffeine" });
    }
  } else {
    if (cafProduct) timeline.push({ time: -45, label: "Caffeine", detail: `1× ${caffeineProduct} (${cafProduct.caffeine}mg)`, type: "caffeine" });
    timeline.push({ time: -30, label: "Top-off", detail: `1× ${fuelProduct} or sip Drink Mix`, type: "fuel" });
  }

  const startMin = 25;
  for (let i = 0; i < numGels; i++) {
    const raceMin = startMin + i * (gelIntervalMin ?? 0);
    if (raceMin < durationMin) {
      const km = Math.round(raceMin / effectivePace * 10) / 10;
      const itemLabel = product.type === "food" ? "Food" : product.type === "drink" ? "Drink" : "Gel";
      timeline.push({ time: raceMin, label: `${itemLabel} #${i + 1}`, detail: `1× ${fuelProduct} (~km ${km})`, type: "fuel", km });
    }
  }
  // ── Real food at aid stations (ultra only) ──
  // One real food item per hour from the aidTier food list, cycling, starting at 60 min
  let realFoodTotalCho = 0, realFoodTotalProtein = 0, realFoodTotalKcal = 0;
  if (isUltra && durationH >= 5) {
    const aidFoods = AID_STATION_STRATEGY[aidTier].foods;
    let foodIdx = 0;
    for (let t = 60; t < durationMin - 20; t += 60) {
      const foodEntry = aidFoods[foodIdx % aidFoods.length];
      const p = PRODUCTS[foodEntry.name];
      if (p) {
        realFoodTotalCho      += p.cho;
        realFoodTotalProtein  += p.protein;
        realFoodTotalKcal     += p.kcal;
        const km = Math.round(t / effectivePace * 10) / 10;
        timeline.push({ time: t, label: "Aid Station", detail: `${foodEntry.name} — ${foodEntry.note}`, type: "food", km });
      }
      foodIdx++;
    }
  }

  timeline.push({
    time: Math.round(durationMin) + 10, label: "Recovery",
    detail: `${Math.round(bodyWeightKg)}g CHO + ${isUltra ? "30–40" : "20–25"}g protein within 30 min`,
    type: "recovery",
  });

  timeline.sort((a, b) => a.time - b.time);

  return {
    durationMin: Math.round(durationMin), durationH: Math.round(durationH * 100) / 100,
    effectivePace: Math.round(effectivePace * 100) / 100,
    avgGradePct, climbRatio, descentRatio,
    climbKcal: Math.round(climbKcal), descentKcal: Math.round(descentKcal),
    totalKcal, kcalPerHour,
    glycogenG: Math.round(glycogenG), glycogenKcal,
    choPerHourTarget, choPerHourLow: tier.low, choPerHourHigh: tier.high, tierNote: tier.note,
    totalChoNeeded, sweatRateMlPerH, totalFluidL, sodiumPerH, totalSodium,
    caffeineLow, caffeineHigh, numGels, gelIntervalMin, timeline, fuelProduct,
    isUltra, effortDistanceKm, fatFractionOfEnergy, fatGPerH, proteinGPerH, totalProteinG, totalFatG, aidTier,
    realFoodTotalCho, realFoodTotalProtein, realFoodTotalKcal,
    cfg,
  };
}

// ─── THEME ────────────────────────────────────────────────────────────

const BASE_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Instrument+Serif&family=DM+Sans:wght@400;500;600&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }
  input[type=number]::-webkit-inner-spin-button,
  input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  input[type=number] { -moz-appearance: textfield; }
  ::selection { background: var(--selection-bg); color: var(--text); }
  input:focus, select:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 2px var(--focus-ring); outline: none; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  html { scrollbar-width: none; }
  html::-webkit-scrollbar { display: none; }
  .grid-course { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 16px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .grid-2-narrow { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .aid-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }
  @media (max-width: 600px) {
    .grid-course { grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .grid-4 { grid-template-columns: repeat(2, 1fr); }
    .grid-3 { grid-template-columns: repeat(2, 1fr); }
    .grid-2 { grid-template-columns: 1fr; }
    .grid-2-narrow { grid-template-columns: repeat(2, 1fr); }
    .aid-grid { grid-template-columns: repeat(2, 1fr); }
  }
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
    --sport-active-bg: #7ab860;
    --sport-active-text: #0a1208;
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
    --ultra-bg:     #0a0f18;
    --ultra-border: #1a2430;
    --ultra-text:   #7898c0;
    --ultra-label:  #4a6888;
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
    --sport-active-bg: #3a6e28;
    --sport-active-text: #ffffff;
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
    --ultra-bg:     #eef2fa;
    --ultra-border: #c0cce8;
    --ultra-text:   #3858a0;
    --ultra-label:  #5878c0;
    --selection-bg: #a8d890;
    --focus-ring:   rgba(58,110,40,0.2);
    --color-scheme: light;
  }
`;

// ─── FORMATTERS & CONSTANTS ───────────────────────────────────────────

const fmtDuration = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
const fmtPace = (mpk) => `${Math.floor(mpk)}:${String(Math.round((mpk % 1) * 60)).padStart(2, "0")}`;

const TABS = [{ id: "plan", label: "Protocol" }, { id: "calc", label: "Calculations" }, { id: "refs", label: "References" }];

// ─── COMPONENTS ───────────────────────────────────────────────────────

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
            background: "var(--input-bg)", border: "1px solid var(--input-border)",
            borderRadius: 7, color: "var(--input-text)", padding: "9px 10px",
            fontSize: 15, fontFamily: "'JetBrains Mono', monospace",
            width: "100%", minWidth: 0, transition: "border-color 0.15s",
            minHeight: 44,
          }}
        />
        {unit && <span style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "monospace", flexShrink: 0 }}>{unit}</span>}
      </div>
      {helpText && <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 4, fontFamily: "monospace" }}>{helpText}</div>}
    </div>
  );
}

function PaceInput({ label, value, onChange, helpText }) {
  const [raw, setRaw] = useState(() => fmtPace(value));
  const lastExternal = useRef(value);

  // Sync display if value changes from outside (e.g. GPX upload)
  useEffect(() => {
    if (Math.abs(lastExternal.current - value) > 0.001) {
      setRaw(fmtPace(value));
    }
    lastExternal.current = value;
  }, [value]);

  const handleChange = (e) => {
    const str = e.target.value;
    setRaw(str);
    // Accept MM:SS once seconds are two digits
    const full = str.match(/^(\d{1,2}):(\d{2})$/);
    if (full) {
      const m = parseInt(full[1], 10);
      const s = parseInt(full[2], 10);
      if (s < 60 && m > 0) onChange(m + s / 60);
    }
    // Accept plain number like "5" → 5:00
    if (/^\d{1,2}$/.test(str)) {
      const m = parseInt(str, 10);
      if (m > 0 && m < 20) onChange(m);
    }
  };

  const handleBlur = () => setRaw(fmtPace(value));

  return (
    <div>
      <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-label)", marginBottom: 5 }}>
        {label}
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="text"
          value={raw}
          onChange={handleChange}
          onBlur={handleBlur}
          inputMode="numeric"
          placeholder="5:30"
          style={{
            background: "var(--input-bg)", border: "1px solid var(--input-border)",
            borderRadius: 7, color: "var(--input-text)", padding: "9px 10px",
            fontSize: 15, fontFamily: "'JetBrains Mono', monospace",
            width: "100%", minWidth: 0, transition: "border-color 0.15s",
            minHeight: 44,
          }}
        />
        <span style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "monospace", flexShrink: 0 }}>min/km</span>
      </div>
      {helpText && <div style={{ color: "var(--text-muted)", fontSize: 10, marginTop: 4, fontFamily: "monospace" }}>{helpText}</div>}
    </div>
  );
}

function SelectInput({ label, value, onChange, options, grouped }) {
  return (
    <div>
      <label style={{ display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-label)", marginBottom: 5 }}>
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: "var(--input-bg)", border: "1px solid var(--input-border)",
          borderRadius: 7, color: "var(--input-text)", padding: "9px 10px",
          fontSize: 13, fontFamily: "'JetBrains Mono', monospace",
          width: "100%", cursor: "pointer", transition: "border-color 0.15s",
          minHeight: 44,
        }}
      >
        {grouped
          ? Object.entries(grouped).map(([grp, opts]) => (
              <optgroup key={grp} label={grp}>
                {opts.map(o => <option key={o} value={o}>{o}</option>)}
              </optgroup>
            ))
          : options.map(o => <option key={o} value={o}>{o}</option>)
        }
      </select>
    </div>
  );
}

function StatCard({ label, value, unit, warn, accent, formula }) {
  const [show, setShow] = useState(false);
  const bg = warn ? "var(--warn-bg)" : accent ? "var(--ultra-bg)" : "var(--stat-bg)";
  const border = warn ? "var(--warn-border)" : accent ? "var(--ultra-border)" : "var(--stat-border)";
  const labelColor = warn ? "var(--warn-label)" : accent ? "var(--ultra-label)" : "var(--text-muted)";
  const valueColor = warn ? "var(--warn-text)" : accent ? "var(--ultra-text)" : "var(--text)";
  return (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: labelColor }}>
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
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: valueColor, lineHeight: 1 }}>
        {value}
        {unit && <span style={{ fontSize: 12, fontWeight: 400, color: labelColor, marginLeft: 5 }}>{unit}</span>}
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
  const dotColor = { meal: "var(--text-dim)", fuel: "var(--accent)", caffeine: "var(--warn-label)", recovery: "var(--text-dim)", food: "var(--ultra-text)" }[item.type] || "var(--text-dim)";
  const timeLabel = item.time < 0 ? `${item.time}m` : item.time > 200 ? "Post" : `+${item.time}m`;

  return (
    <div style={{ display: "flex", gap: 12, minHeight: 52 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 40, flexShrink: 0 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, marginTop: 4, flexShrink: 0 }} />
        {!isLast && <div style={{ width: 1, flex: 1, background: "var(--timeline-line)", marginTop: 4 }} />}
      </div>
      <div style={{ flex: 1, paddingBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--text-muted)", minWidth: 36 }}>{timeLabel}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{item.label}</span>
        </div>
        <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 2, marginLeft: 44 }}>{item.detail}</div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────

export default function FuelPlanner() {
  const [isDark, setIsDark] = useState(true);

  // Sport
  const [sportType, setSportType] = useState("Trail");

  // Course inputs
  const [distanceKm, setDistanceKm] = useState(21);
  const [elevationGainM, setElevationGainM] = useState(1000);
  const [bodyWeightKg, setBodyWeightKg] = useState(75);
  const [flatPaceMinPerKm, setFlatPaceMinPerKm] = useState(5.5);

  // Conditions
  const [tempC, setTempC] = useState(15);
  const [humidityPct, setHumidityPct] = useState(50);
  const isHot = tempC >= 25 || humidityPct > 70;

  // Fueling
  const [fuelProduct, setFuelProduct] = useState("Maurten Gel 160");
  const [caffeineProduct, setCaffeineProduct] = useState("Maurten Gel 100 Caf");

  // UI
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

  // ── Sentry: device/browser context (once on mount) ──
  useEffect(() => {
    Sentry.setContext("device", {
      screen_width:  window.screen.width,
      screen_height: window.screen.height,
      pixel_ratio:   window.devicePixelRatio,
      pointer_type:  window.matchMedia("(pointer: coarse)").matches ? "touch" : "mouse",
      display_mode:  window.matchMedia("(display-mode: standalone)").matches ? "pwa" : "browser",
    });
    const nav = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
    if (nav) Sentry.setContext("network", { effective_type: nav.effectiveType, downlink_mbps: nav.downlink });
    Sentry.setTag("locale",       navigator.language);
    Sentry.setTag("color_scheme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  const plan = useMemo(() => computePlan({
    sportType, distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm,
    tempC, humidityPct, isHot, fuelProduct, caffeineProduct,
  }), [sportType, distanceKm, elevationGainM, bodyWeightKg, flatPaceMinPerKm, tempC, humidityPct, fuelProduct, caffeineProduct]);

  // ── Sentry: app usage tags ──
  useEffect(() => {
    Sentry.setTag("sport_type", sportType);
    Sentry.setTag("is_ultra",   String(plan.isUltra));
  }, [sportType, plan.isUltra]);

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
        Sentry.setTag("gpx_used", "true");
        Sentry.addBreadcrumb({ category: "gpx", message: `Uploaded: ${file.name} — ${parsed.distanceKm}km, +${parsed.elevationGainM}m`, level: "info" });
      } catch (err) {
        setGpxError(err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // ── Weather ──
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

  const onWeatherSuccess = (w) => {
    setWeather(w);
    Sentry.setTag("weather_fetched", "true");
    Sentry.addBreadcrumb({ category: "weather", message: `Fetched: ${w.location}, ${w.temp}°C, ${w.humidity}% humidity`, level: "info" });
  };

  const fetchWeather = () => {
    Sentry.addBreadcrumb({ category: "weather", message: "Weather fetch triggered", level: "info" });
    setWeatherLoading(true);
    setWeatherError(null);
    if (gpxFile?.startLat != null) {
      fetchWeatherAt(gpxFile.startLat, gpxFile.startLon)
        .then(onWeatherSuccess)
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
        try { onWeatherSuccess(await fetchWeatherAt(coords.latitude, coords.longitude)); }
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
  };

  // ── Helpers ──
  const inlineInputStyle = {
    background: "var(--input-bg)", border: "1px solid var(--input-border)", borderRadius: 7,
    color: "var(--input-text)", padding: "9px 10px", fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace", outline: "none",
    colorScheme: isDark ? "dark" : "light", transition: "border-color 0.15s",
    minHeight: 44,
  };

  const labelStyle = {
    display: "block", fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
    textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-label)", marginBottom: 5,
  };

  const product = PRODUCTS[fuelProduct];

  return (
    <div style={{ minHeight: "100vh", background: "var(--page-bg)", color: "var(--text)", fontFamily: "'DM Sans', 'Inter', sans-serif" }}>
      <style>{`${BASE_CSS}\n${isDark ? DARK_CSS : LIGHT_CSS}`}</style>

      {/* ── Header ── */}
      <header style={{ maxWidth: 800, margin: "0 auto", padding: "24px 16px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: 26, color: "var(--header-title)", letterSpacing: "-0.02em", lineHeight: 1 }}>
            Fuel Planner
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--header-sub)", marginTop: 6, letterSpacing: "0.12em" }}>
            ROAD · TRAIL · SCIENCE-BASED
          </div>
        </div>
        <button
          onClick={() => setIsDark(!isDark)}
          title="Toggle theme"
          style={{
            background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 8,
            color: "var(--text-dim)", padding: "8px 12px", fontSize: 15,
            cursor: "pointer", lineHeight: 1, minHeight: 44,
          }}
        >
          {isDark ? "☀️" : "🌙"}
        </button>
      </header>

      <main style={{ maxWidth: 800, margin: "0 auto", padding: "16px 16px 56px" }}>

        {/* ── Race Profile card ── */}
        <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 14, padding: "20px 20px", marginBottom: 14 }}>

          {/* Sport selector */}
          <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
            {["Road", "Trail"].map(s => (
              <button
                key={s}
                onClick={() => setSportType(s)}
                style={{
                  flex: 1, padding: "10px 8px",
                  background: sportType === s ? "var(--sport-active-bg)" : "var(--input-bg)",
                  border: `1px solid ${sportType === s ? "var(--sport-active-bg)" : "var(--input-border)"}`,
                  borderRadius: 8,
                  color: sportType === s ? "var(--sport-active-text)" : "var(--text-muted)",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                  fontWeight: sportType === s ? 700 : 400,
                  textTransform: "uppercase", letterSpacing: "0.1em",
                  cursor: "pointer", transition: "all 0.15s", minHeight: 44,
                }}
              >
                {s}
              </button>
            ))}
          </div>
          {sportType !== "Road" && (
            <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)", marginTop: -12, marginBottom: plan.isUltra ? 8 : 16 }}>
              {SPORT_CONFIG[sportType].desc}
            </div>
          )}
          {plan.isUltra && (
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "var(--ultra-text)", background: "var(--ultra-bg)", border: "1px solid var(--ultra-border)", borderRadius: 6, padding: "5px 10px", marginBottom: 16 }}>
              Ultra detected ({sportType === "Trail" ? `${Math.round(plan.effortDistanceKm)} km effort-distance` : `${distanceKm} km`}) — fat, protein & aid station planning enabled
            </div>
          )}

          {/* Course */}
          <Divider label="Course" />
          <div className="grid-course">
            <NumberInput label="Distance" value={distanceKm} onChange={setDistanceKm} unit="km" min={1} max={400} />
            <NumberInput label="Elevation +" value={elevationGainM} onChange={setElevationGainM} unit="m" min={0} max={15000} step={50} />
            <NumberInput label="Body Weight" value={bodyWeightKg} onChange={setBodyWeightKg} unit="kg" min={40} max={150} />
            <PaceInput label="Flat Pace" value={flatPaceMinPerKm} onChange={setFlatPaceMinPerKm} helpText="Road race pace" />
          </div>

          {/* GPX */}
          <input ref={gpxInputRef} type="file" accept=".gpx" style={{ display: "none" }} onChange={handleGpxUpload} />
          {!gpxFile ? (
            <button
              onClick={() => gpxInputRef.current.click()}
              style={{
                background: "none", border: "1px dashed var(--input-border)", borderRadius: 8,
                color: "var(--text-muted)", padding: "10px 16px",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 7, transition: "all 0.15s",
                minHeight: 44, width: "100%",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--input-border)"; e.currentTarget.style.color = "var(--text-muted)"; }}
            >
              ↑ Load GPX — auto-fill distance & elevation
            </button>
          ) : (
            <div style={{ background: "var(--gpx-bg)", border: "1px solid var(--gpx-border)", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: "var(--accent-text)", fontWeight: 600 }}>✓ {gpxFile.name}</div>
                <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  {gpxFile.distanceKm} km · +{gpxFile.elevationGainM} m · {gpxFile.points.toLocaleString()} pts
                </div>
              </div>
              <button onClick={() => { setGpxFile(null); setGpxError(null); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontFamily: "monospace", fontSize: 14, minWidth: 32, minHeight: 32 }}>✕</button>
            </div>
          )}
          {gpxError && <div style={{ color: "var(--warn-text)", fontFamily: "monospace", fontSize: 11, marginTop: 6 }}>{gpxError}</div>}

          {/* Race Day & Forecast */}
          <Divider label="Race Day & Forecast" />
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, flexWrap: "wrap" }}>
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
                padding: "9px 16px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                cursor: weatherLoading ? "default" : "pointer", whiteSpace: "nowrap",
                transition: "all 0.15s", minHeight: 44,
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
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }}>
                  <span style={{ color: "var(--text)" }}>{weather.temp}°C <span style={{ fontSize: 11, color: "var(--text-muted)" }}>feels {weather.feelsLike}°C</span></span>
                  <span style={{ color: "var(--text-dim)" }}>💧 {weather.humidity}%</span>
                  <span style={{ color: "var(--text-dim)" }}>💨 {weather.windKmh} km/h</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={applyWeather} style={{ background: "var(--chip-bg)", border: "1px solid var(--card-border)", borderRadius: 7, color: "var(--chip-text)", padding: "8px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, cursor: "pointer", fontWeight: 600, minHeight: 40 }}>
                  Apply to plan
                </button>
                <button onClick={() => { setWeather(null); setWeatherError(null); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, minWidth: 32, minHeight: 32 }}>✕</button>
              </div>
            </div>
          )}

          {/* Conditions */}
          <Divider label="Conditions" />
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, flexWrap: "wrap" }}>
            <div style={{ minWidth: 100 }}>
              <NumberInput label="Temperature" value={tempC} onChange={setTempC} unit="°C" min={-10} max={45} />
            </div>
            <div style={{ minWidth: 100 }}>
              <NumberInput label="Humidity" value={humidityPct} onChange={setHumidityPct} unit="%" min={0} max={100} />
            </div>
            <div style={{ paddingBottom: 4 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", minHeight: 44 }}>
                <input type="checkbox" checked={isHot} readOnly
                  style={{ accentColor: "var(--accent)", width: 16, height: 16, flexShrink: 0 }} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "var(--text-label)" }}>Hot / humid (+8% energy)</span>
              </label>
            </div>
          </div>

          {/* Fueling */}
          <Divider label="Fueling" />
          <div className="grid-2">
            <SelectInput label="Primary Fuel" value={fuelProduct} onChange={setFuelProduct} grouped={PRODUCT_GROUPS} />
            <SelectInput label="Caffeine Source" value={caffeineProduct} onChange={setCaffeineProduct} options={CAFFEINE_PRODUCTS} />
          </div>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display: "flex", gap: 2, marginBottom: 14, background: "var(--tab-bar)", borderRadius: 10, padding: "3px" }}>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                flex: 1, padding: "10px 16px",
                background: activeTab === t.id ? "var(--tab-active)" : "transparent",
                border: activeTab === t.id ? "1px solid var(--card-border)" : "1px solid transparent",
                borderRadius: 8,
                color: activeTab === t.id ? "var(--tab-text-on)" : "var(--tab-text-off)",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                fontWeight: activeTab === t.id ? 600 : 400,
                textTransform: "uppercase", letterSpacing: "0.1em",
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: activeTab === t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                minHeight: 44,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Protocol Tab ── */}
        {activeTab === "plan" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Effort stats: Duration, Energy, CHO/h */}
            <div className="grid-3">
              <StatCard label="Est. Duration" value={fmtDuration(plan.durationMin)}
                formula={`Flat: ${fmtPace(flatPaceMinPerKm)}/km\n+elev: +${(plan.effectivePace - flatPaceMinPerKm - plan.cfg.paceAdj).toFixed(2)} min/km${plan.cfg.paceAdj > 0 ? `\n+terrain: +${plan.cfg.paceAdj} min/km` : ""}\n= ${fmtPace(plan.effectivePace)}/km × ${distanceKm}km`} />
              <StatCard label="Energy Cost" value={plan.totalKcal.toLocaleString()} unit="kcal"
                formula={`Minetti (2002) @ avg grade ${plan.avgGradePct}%\nClimb ×${plan.climbRatio.toFixed(2)} × ${bodyWeightKg}kg × ${(distanceKm/2).toFixed(1)}km = ${plan.climbKcal} kcal\nDescent ×${plan.descentRatio.toFixed(2)} × ${bodyWeightKg}kg × ${(distanceKm/2).toFixed(1)}km = ${plan.descentKcal} kcal\n× ${plan.cfg.terrainMult} terrain${isHot ? "\n× 1.08 heat" : ""}\n= ${plan.totalKcal} kcal`} />
              <StatCard label="CHO Target" value={plan.choPerHourTarget} unit="g/h"
                formula={`${plan.durationH}h → tier ${plan.choPerHourLow}–${plan.choPerHourHigh} g/h\nMid-range: ${plan.choPerHourTarget} g/h\n"${plan.tierNote}"\nJeukendrup (2011, 2014)`} />
            </div>

            {/* Execution stats */}
            <div className="grid-4">
              <StatCard label="In-Race CHO" value={plan.isUltra ? plan.totalChoNeeded + Math.round(plan.realFoodTotalCho) : plan.totalChoNeeded} unit="g total"
                formula={plan.isUltra ? `${plan.totalChoNeeded}g from gels\n+${Math.round(plan.realFoodTotalCho)}g from aid station food\n= ${plan.totalChoNeeded + Math.round(plan.realFoodTotalCho)}g total` : undefined} />
              <StatCard label="Fluid" value={plan.sweatRateMlPerH} unit="ml/h"
                formula={`Base 600 ml/h @ 15°C (Sawka 2007)\n+${Math.max(0, tempC - 15)}°C × 25 ml/h${humidityPct > 70 ? `\n× 1.15 humidity` : ""}${isHot ? `\n× 1.10 heat` : ""}\n= ${plan.sweatRateMlPerH} ml/h → ${plan.totalFluidL}L total\n\nIndividual variation ±50%.`} />
              <StatCard label="Sodium" value={plan.sodiumPerH} unit="mg/h"
                formula={`${plan.sweatRateMlPerH} ml/h × 800 mg/L\n= ${plan.sodiumPerH} mg/h\n→ ${plan.totalSodium} mg total\nRange: 200–2000 mg/L (Lara 2017)`} />
              <StatCard label="Caffeine" value={`${plan.caffeineLow}–${plan.caffeineHigh}`} unit="mg"
                formula={`3–6 mg/kg × ${bodyWeightKg}kg\n${plan.isUltra ? "Split: 2 in-race doses\nat 30% and 60% of race time" : "Take 45–60 min pre-race"}\nGrgic et al. (2021) BJSM`} />
            </div>

            {/* Ultra: fat & protein */}
            {plan.isUltra && plan.durationH >= 5 && (
              <div className="grid-2-narrow">
                <StatCard label="Fat Oxidation" value={`~${Math.round(plan.fatFractionOfEnergy * 100)}%`} unit="of energy" accent
                  formula={`Duration ${plan.durationH}h\n→ est. ${Math.round(plan.fatFractionOfEnergy * 100)}% from fat\n(~${plan.fatGPerH}g fat/h · ${plan.totalFatG}g total)\nFraction increases ~30% at 5h → ~55% at 15h+\nBrooks & Mercier (1994) J Appl Physiol 76(6):2253`} />
                <StatCard label="Protein Target" value={plan.proteinGPerH} unit="g/h" accent
                  formula={`${plan.durationH <= 8 ? "0.25" : "0.30"}g/kg/h × ${bodyWeightKg}kg\n= ${plan.proteinGPerH}g/h → ${plan.totalProteinG}g total\nUse real food (eggs, broth, PB&J)\nTarnopolsky (2004); Keinänen (2022)`} />
              </div>
            )}

            {/* Carry list */}
            <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "18px 20px" }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", marginBottom: 14 }}>Carry List</div>
              <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>In-Race</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--accent-text)", fontWeight: 600 }}>{plan.numGels}× {fuelProduct}</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                    {plan.numGels * product.cho}g CHO{plan.gelIntervalMin ? ` · every ~${plan.gelIntervalMin} min` : ""}
                  </div>
                </div>
                {caffeineProduct !== NO_CAFFEINE && (
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>Caffeine</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--warn-label)", fontWeight: 600 }}>
                      {plan.isUltra ? "2×" : "1×"} {caffeineProduct}
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>
                      {PRODUCTS[caffeineProduct].caffeine}mg each · {plan.isUltra ? "at 30% & 60% race time" : "take at −45 min"}
                    </div>
                  </div>
                )}
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>Hydration</div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--text)", fontWeight: 600 }}>{plan.totalFluidL}L</div>
                  <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>{plan.sweatRateMlPerH} ml/h · {plan.sodiumPerH} mg Na/h</div>
                </div>
                {plan.isUltra && (
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "var(--ultra-text)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7 }}>Aid Station Food</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, color: "var(--ultra-text)", fontWeight: 600 }}>{Math.round(plan.realFoodTotalCho)}g CHO</div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}>+{Math.round(plan.realFoodTotalProtein)}g pro · {Math.round(plan.realFoodTotalKcal)} kcal</div>
                  </div>
                )}
              </div>
            </div>

            {/* Aid Station Strategy (ultra only) */}
            {plan.isUltra && (
              <div style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "18px 20px" }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", marginBottom: 6 }}>
                  Aid Station Strategy
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", marginBottom: 14 }}>
                  <strong style={{ color: "var(--ultra-text)" }}>{AID_STATION_STRATEGY[plan.aidTier].label}</strong> — {AID_STATION_STRATEGY[plan.aidTier].focus}
                </div>
                <div className="aid-grid">
                  {AID_STATION_STRATEGY[plan.aidTier].foods.map(f => {
                    const p = PRODUCTS[f.name];
                    return (
                      <div key={f.name} style={{ background: "var(--stat-bg)", border: "1px solid var(--stat-border)", borderRadius: 8, padding: "10px 12px" }}>
                        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>{f.name}</div>
                        {p && (
                          <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-dim)" }}>
                            {p.cho}g CHO · {p.kcal} kcal{p.sodium > 0 ? ` · ${p.sodium}mg Na` : ""}{p.protein > 0 ? ` · ${p.protein}g pro` : ""}
                          </div>
                        )}
                        <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>{f.note}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
                    Elevation: +{(plan.effectivePace - flatPaceMinPerKm - plan.cfg.paceAdj).toFixed(2)} min/km<br />
                    {plan.cfg.paceAdj > 0 && <>{sportType} surface: +{plan.cfg.paceAdj.toFixed(1)} min/km<br /></>}
                    <span style={{ color: "var(--text)" }}>→ {fmtPace(plan.effectivePace)}/km effective · {fmtDuration(plan.durationMin)}</span>
                  </> },
                  { n: "2", title: "Energy Expenditure", body: <>
                    Minetti (2002) polynomial — metabolic cost on slopes<br />
                    Avg climb grade: {plan.avgGradePct}% (gain / half-distance)<br />
                    Climb ×{plan.climbRatio.toFixed(2)} × {bodyWeightKg}kg × {(distanceKm/2).toFixed(1)}km = {plan.climbKcal} kcal<br />
                    Descent ×{plan.descentRatio.toFixed(2)} × {bodyWeightKg}kg × {(distanceKm/2).toFixed(1)}km = {plan.descentKcal} kcal<br />
                    × {plan.cfg.terrainMult} terrain{isHot ? " · ×1.08 heat" : ""}<br />
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
                    {plan.isUltra
                      ? <><span style={{ color: "var(--text)" }}>→ Split into 2 in-race doses: ~30% and ~60% of race time</span><br />Avoids GI stress if taken on empty stomach; maintains late-race alertness</>
                      : <span style={{ color: "var(--text)" }}>→ Take 45–60 min pre-race or split in-race</span>
                    }<br />
                    <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Thomas et al. (2016) MSSE 48(3):543; Grgic et al. (2021) BJSM 55:929</span>
                  </> },
                  ...(plan.isUltra && plan.durationH >= 5 ? [{
                    n: "7", title: "Ultra Nutrition — Fat & Protein", body: <>
                      <span style={{ color: "var(--ultra-text)" }}>Fat oxidation</span><br />
                      ~{Math.round(plan.fatFractionOfEnergy * 100)}% of energy from fat at {plan.durationH}h<br />
                      → ~{plan.fatGPerH}g fat/h · {plan.totalFatG}g total<br />
                      Complement CHO with fat from real food (avocado, nut butter, egg)<br />
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Brooks & Mercier (1994) J Appl Physiol 76(6):2253 — crossover concept<br />Fat fraction increases from ~30% at 5h to ~55% at 15h+ (estimate)</span><br /><br />
                      <span style={{ color: "var(--ultra-text)" }}>Protein</span><br />
                      {plan.durationH <= 8 ? "0.25" : "0.30"}g/kg/h × {bodyWeightKg}kg = {plan.proteinGPerH}g/h → {plan.totalProteinG}g total<br />
                      Prevents muscle catabolism; supports gut recovery between aid stations<br />
                      Sources: hard-boiled egg, broth, PB&J, RX Bar<br />
                      <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Tarnopolsky (2004) Nutrition 20(7):662; Keinänen et al. (2022) Nutrients 14(12):2405</span>
                    </>
                  }] : []),
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
                  "Sodium needs are highly individual. Sweat testing gives real data.",
                  "Caffeine sensitivity varies widely. Test in training — not on race day.",
                  "Fat oxidation estimates are population averages; fat-adapted athletes may oxidise more.",
                  "Ultra protein needs are approximate; appetite suppression is a real limiter.",
                  "Weather, altitude, sleep, stress, and pre-race nutrition all affect requirements.",
                ].map((c, i) => <div key={i}>· {c}</div>)}
              </div>
            </div>
          </div>
        )}

        {/* ── References Tab ── */}
        {activeTab === "refs" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {[
              {
                section: "Energy Expenditure",
                refs: [
                  {
                    cite: "Margaria R, Cerretelli P, Aghemo P, Sassi G (1963). Energy cost of running. J Appl Physiol 18(2):367–370.",
                    use: "Baseline: 1 kcal/kg/km for flat running. Calibration anchor for the Minetti ratio method.",
                  },
                  {
                    cite: "Minetti AE, Moia C, Roi GS, Susta D, Ferretti G (2002). Energy cost of walking and running at extreme uphill and downhill slopes. J Appl Physiol 93(3):1039–1046.",
                    use: "Polynomial EC(g) = 155.4g⁵ − 30.4g⁴ − 43.3g³ + 46.3g² + 19.5g + 3.6 (J/kg/m horizontal). Used to scale energy cost by slope grade.",
                  },
                  {
                    cite: "di Prampero PE (1986). The energy cost of human locomotion on land and in water. Int J Sports Med 7(2):55–72.",
                    use: "Confirms Margaria's flat-running economy value (~1 kcal/kg/km).",
                  },
                ],
              },
              {
                section: "Carbohydrate Intake",
                refs: [
                  {
                    cite: "Jeukendrup AE (2011). Nutrition for endurance sports: marathon, triathlon, and road cycling. J Sports Sci 29(S1):S91–99.",
                    use: "CHO intake tiers by duration: <1h optional, 1–2h 30–60 g/h, 2–3h 60–80 g/h.",
                  },
                  {
                    cite: "Jeukendrup AE (2014). A step towards personalized sports nutrition: carbohydrate intake during exercise. Sports Med 44(S1):25–33.",
                    use: "Updates the 80–90 g/h tier threshold to events >2.5h (from >3h). Multiple-transport CHO (glucose:fructose ≈ 2:1) required for absorption >60 g/h.",
                  },
                  {
                    cite: "Thomas DT, Erdman KA, Burke LM (2016). Position of the Academy of Nutrition and Dietetics, Dietitians of Canada, and the American College of Sports Medicine: Nutrition and Athletic Performance. Med Sci Sports Exerc 48(3):543–568.",
                    use: "ACSM/AND/DC position stand on CHO, protein, fluid, and caffeine for athletes. General framework for targets.",
                  },
                ],
              },
              {
                section: "Hydration & Sodium",
                refs: [
                  {
                    cite: "Sawka MN, Burke LM, Eichner ER, Maughan RJ, Montain SJ, Stachenfeld NS (2007). American College of Sports Medicine position stand: Exercise and fluid replacement. Med Sci Sports Exerc 39(2):377–390.",
                    use: "Sweat rate reference (~600 ml/h at thermoneutral) and fluid replacement guidelines. Basis for the temperature-scaling model.",
                  },
                  {
                    cite: "Lara B, Gallo-Salazar C, Puente C, Arán-Fillat T, Salinero JJ, Del Coso J (2017). Interindividual variability in sweat electrolyte concentration in marathoners. J Int Soc Sports Nutr 14:1.",
                    use: "Sweat sodium concentration: population mean ~800 mg/L, range 200–2000 mg/L. Used for sodium loss estimate.",
                  },
                ],
              },
              {
                section: "Caffeine",
                refs: [
                  {
                    cite: "Grgic J, Grgic I, Pickering C, Schoenfeld BJ, Bishop DJ, Pedisic Z (2021). Wake up and smell the coffee: caffeine supplementation and exercise performance — an umbrella review of 21 published meta-analyses. Br J Sports Med 55(15):929–936.",
                    use: "3–6 mg/kg effective dose range. Timing (45–60 min pre-exercise) and in-race split strategy for ultras.",
                  },
                ],
              },
              {
                section: "Ultra-Endurance: Fat Oxidation",
                refs: [
                  {
                    cite: "Brooks GA, Mercier J (1994). Balance of carbohydrate and lipid utilization during exercise: the \"crossover\" concept. J Appl Physiol 76(6):2253–2261.",
                    use: "Fat oxidation fraction increases with duration and decreases with intensity. Basis for the duration-scaling fat estimate (30% at 5h → 55% at 15h+).",
                  },
                  {
                    cite: "Volek JS, Freidenreich DJ, Saenz C, et al. (2016). Metabolic characteristics of keto-adapted ultra-endurance runners. Metabolism 65(3):100–110.",
                    use: "Context for elevated fat oxidation in adapted ultra athletes. Reinforces that fat contribution is meaningful in multi-hour events.",
                  },
                ],
              },
              {
                section: "Ultra-Endurance: Protein",
                refs: [
                  {
                    cite: "Tarnopolsky MA (2004). Protein requirements for endurance athletes. Nutrition 20(7–8):662–668.",
                    use: "Protein needs in prolonged endurance: 0.25 g/kg/h during events, higher for multi-day. Basis for the 0.25 g/kg/h target for <8h ultras.",
                  },
                  {
                    cite: "Keinänen OA, Tiilikainen E, Tanskanen M, et al. (2022). Nutritional strategies of recreational ultra-marathon runners: findings from a systematic review. Nutrients 14(12):2405.",
                    use: "Reviews protein intake practices in ultra-marathons. Supports 0.30 g/kg/h for events >8h to counter catabolism and support recovery.",
                  },
                ],
              },
            ].map(({ section, refs }) => (
              <div key={section} style={{ background: "var(--card-bg)", border: "1px solid var(--card-border)", borderRadius: 12, padding: "18px 20px" }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-muted)", marginBottom: 14 }}>
                  {section}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {refs.map((r, i) => (
                    <div key={i} style={{ borderLeft: "2px solid var(--accent-dim)", paddingLeft: 14 }}>
                      <div style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)", lineHeight: 1.6, marginBottom: 5 }}>
                        {r.cite}
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.55 }}>
                        <span style={{ color: "var(--text-muted)" }}>Used for: </span>{r.use}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Footer ── */}
        <div style={{ marginTop: 40, textAlign: "center", fontFamily: "monospace", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.7 }}>
          Not medical advice. Margaria (1963) · Minetti (2002) · Jeukendrup (2011, 2014) · Thomas, Erdman & Burke (2016) · Sawka (2007) · Lara (2017) · Grgic (2021) · Brooks & Mercier (1994) · Tarnopolsky (2004) · Keinänen (2022).<br />
          Always validate your fueling strategy in training before race day.
        </div>
      </main>
    </div>
  );
}
