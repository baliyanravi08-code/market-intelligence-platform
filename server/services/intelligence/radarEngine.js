const { loadDB } = require("../../database");

const radarMap = new Map();

/* ───────────────────────────── */
/* CONFIG */
/* ───────────────────────────── */

const MIN_SCORE_TO_SHOW = 20;     // hide weak signals (NEWS=5 etc.)
const MAX_RADAR_ITEMS = 200;      // limit radar size
const DECAY_PER_HOUR = 5;         // score decay to keep radar fresh
const MAX_SIGNAL_HISTORY = 5;

/* ───────────────────────────── */

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: true
  });
}

function normalizeName(name) {
  if (!name) return name;
  return name
    .trim()
    .replace(/\s+(limited|ltd\.?|inc\.?|llp\.?|pvt\.?|private)$/i, "")
    .replace(/\s+-\s*\$.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ───────────────────────────── */
/* LOAD FROM DB */
/* ───────────────────────────── */

function loadRadarFromDB() {
  try {
    const db = loadDB();
    if (db.radar?.length) {
      db.radar.forEach(entry => {
        const key = normalizeName(entry.company).toLowerCase();
        radarMap.set(key, entry);
      });

      console.log(`📡 Radar restored: ${radarMap.size} companies loaded`);
    }
  } catch (e) {
    console.log("⚠️ Radar restore failed:", e.message);
  }
}

/* ───────────────────────────── */
/* SCORING */
/* ───────────────────────────── */

const SIGNAL_SCORES = {
  ORDER_ALERT: 40,
  MERGER: 35,
  BLOCK_DEAL: 30,
  RESULT: 25,
  BANK_RESULT: 25,
  CAPEX: 20,
  SMART_MONEY: 20,
  PARTNERSHIP: 15,
  INSIDER_BUY: 15,
  INSIDER_TRADE: 15,
  CORPORATE_ACTION: 10,
  NEWS: 5
};

/* ───────────────────────────── */
/* UPDATE RADAR */
/* ───────────────────────────── */

function updateRadar(company, signal) {

  if (!company || !signal) return;

  const signalScore = SIGNAL_SCORES[signal.type] || 5;

  // Ignore very weak signals (like NEWS)
  if (signalScore < MIN_SCORE_TO_SHOW) return;

  const key = normalizeName(company).toLowerCase();

  if (!radarMap.has(key)) {
    radarMap.set(key, {
      company: normalizeName(company),
      score: 0,
      signals: [],
      strength: "WEAK",
      pdfUrl: null,
      time: null,
      receivedAt: Date.now(),
      exchanges: []
    });
  }

  const data = radarMap.get(key);

  const exchange =
    signal.exchange ||
    (signal.pdfUrl?.includes("bseindia") ? "BSE" : "NSE");

  if (exchange && !data.exchanges.includes(exchange)) {
    data.exchanges.push(exchange);
  }

  data.signals.unshift(signal.type);
  if (data.signals.length > MAX_SIGNAL_HISTORY) {
    data.signals = data.signals.slice(0, MAX_SIGNAL_HISTORY);
  }

  data.score = Math.min(100, data.score + signalScore);
  data.receivedAt = Date.now();
  data.time = signal.time || getIndianTime();

  if (signal.pdfUrl) data.pdfUrl = signal.pdfUrl;

  if (data.score >= 70) data.strength = "VERY STRONG";
  else if (data.score >= 40) data.strength = "STRONG";
  else if (data.score >= 20) data.strength = "MODERATE";
  else data.strength = "WEAK";
}

/* ───────────────────────────── */
/* DECAY OLD SIGNALS */
/* ───────────────────────────── */

function applyDecay(entry) {
  const ageHours = (Date.now() - entry.receivedAt) / 3600000;

  if (ageHours <= 1) return entry.score;

  const decay = Math.floor(ageHours) * DECAY_PER_HOUR;

  return Math.max(0, entry.score - decay);
}

/* ───────────────────────────── */
/* GET RADAR */
/* ───────────────────────────── */

function getRadar() {

  const cleaned = [];

  for (const entry of radarMap.values()) {

    const decayedScore = applyDecay(entry);

    if (decayedScore < MIN_SCORE_TO_SHOW) continue;

    cleaned.push({
      ...entry,
      score: decayedScore
    });
  }

  return cleaned
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RADAR_ITEMS);
}

/* ───────────────────────────── */

loadRadarFromDB();

module.exports = { updateRadar, getRadar };