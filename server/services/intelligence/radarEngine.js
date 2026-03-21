/**
 * radarEngine.js
 * Tracks company signals and builds radar scores.
 * Persists to disk via radar.json — no DB dependency.
 */

const fs   = require("fs");
const path = require("path");

const RADAR_FILE = path.join(__dirname, "../../data/radar.json");

const radarMap = new Map();

const MIN_SCORE_TO_SHOW  = 20;
const MAX_RADAR_ITEMS    = 200;
const DECAY_PER_HOUR     = 5;
const MAX_SIGNAL_HISTORY = 5;

const SIGNAL_SCORES = {
  ORDER_ALERT:      40,
  MERGER:           35,
  BLOCK_DEAL:       30,
  RESULT:           25,
  BANK_RESULT:      25,
  CAPEX:            20,
  SMART_MONEY:      20,
  PARTNERSHIP:      15,
  INSIDER_BUY:      15,
  INSIDER_TRADE:    15,
  CORPORATE_ACTION: 10,
  NEWS:              5
};

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short", day: "numeric",
    hour: "numeric", minute: "numeric",
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

function loadFromDisk() {
  try {
    if (fs.existsSync(RADAR_FILE)) {
      const raw  = fs.readFileSync(RADAR_FILE, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        data.forEach(entry => {
          if (!entry.company) return;
          const key = normalizeName(entry.company).toLowerCase();
          radarMap.set(key, entry);
        });
        console.log(`📡 Radar restored: ${radarMap.size} companies loaded`);
      }
    }
  } catch(e) {
    console.log("⚠️ Radar restore failed:", e.message);
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(RADAR_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RADAR_FILE, JSON.stringify(getRadar()), "utf8");
  } catch(e) {}
}

loadFromDisk();
setInterval(saveToDisk, 3 * 60 * 1000);

function updateRadar(company, signal) {
  if (!company || !signal) return;

  const signalScore = SIGNAL_SCORES[signal.type] || 5;
  if (signalScore < MIN_SCORE_TO_SHOW) return;

  const key = normalizeName(company).toLowerCase();

  if (!radarMap.has(key)) {
    radarMap.set(key, {
      company:    normalizeName(company),
      code:       signal.code || null,
      score:      0,
      signals:    [],
      strength:   "WEAK",
      pdfUrl:     null,
      time:       null,
      receivedAt: Date.now(),
      savedAt:    signal.savedAt || Date.now(),
      exchanges:  [],
      _orderInfo: null,
      mcapRatio:  null,
    });
  }

  const data = radarMap.get(key);

  if (signal.code && !data.code) data.code = signal.code;

  const exchange = signal.exchange ||
    (signal.pdfUrl?.includes("bseindia") ? "BSE" : "NSE");
  if (exchange && !data.exchanges.includes(exchange)) {
    data.exchanges.push(exchange);
  }

  data.signals.unshift(signal.type);
  if (data.signals.length > MAX_SIGNAL_HISTORY) {
    data.signals = data.signals.slice(0, MAX_SIGNAL_HISTORY);
  }

  if (signal._orderInfo)          data._orderInfo = signal._orderInfo;
  if (signal.mcapRatio !== undefined) data.mcapRatio = signal.mcapRatio;

  data.score      = Math.min(100, data.score + signalScore);
  data.receivedAt = Date.now();
  data.savedAt    = signal.savedAt || Date.now();
  data.time       = signal.time || getIndianTime();
  if (signal.pdfUrl) data.pdfUrl = signal.pdfUrl;

  if      (data.score >= 70) data.strength = "VERY STRONG";
  else if (data.score >= 40) data.strength = "STRONG";
  else if (data.score >= 20) data.strength = "MODERATE";
  else                       data.strength = "WEAK";

  saveToDisk();
}

function applyDecay(entry) {
  const ageHours = (Date.now() - entry.receivedAt) / 3600000;
  if (ageHours <= 1) return entry.score;
  return Math.max(0, entry.score - Math.floor(ageHours) * DECAY_PER_HOUR);
}

function getRadar() {
  const cleaned = [];
  for (const entry of radarMap.values()) {
    const decayedScore = applyDecay(entry);
    if (decayedScore < MIN_SCORE_TO_SHOW) continue;
    cleaned.push({ ...entry, score: decayedScore });
  }
  return cleaned
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RADAR_ITEMS);
}

module.exports = { updateRadar, getRadar };