/**
 * radarEngine.js
 * Tracks company signals and builds radar scores.
 * Persists to disk via radar.json — no DB dependency.
 * Attaches credibility score from credibilityEngine to each radar entry.
 *
 * MEMORY FIXES:
 * 1. saveToDisk() is now DEBOUNCED (2s window) — previously called synchronously
 *    inside updateRadar() on every signal. Burst signals no longer cause
 *    repeated writeFileSync calls.
 * 2. MAX_RADAR_ITEMS reduced from 200 → 100 — radarMap held up to 200 full
 *    objects each with signals[], guidance{}, credibility fields etc.
 * 3. radarMap is pruned when it exceeds MAX_RADAR_ITEMS * 1.5 (150) —
 *    previously it grew unbounded in memory even though getRadar() sliced to 200.
 *    Now stale/low-score entries are evicted from the Map itself.
 * 4. setInterval save changed from 3 min → 10 min (disk writes are cheap but
 *    frequent JSON.stringify of 100+ entries adds GC pressure).
 */

const fs   = require("fs");
const path = require("path");

const RADAR_FILE = path.join(__dirname, "../../data/radar.json");

const radarMap = new Map();

const MIN_SCORE_TO_SHOW  = 20;
const MAX_RADAR_ITEMS    = 100;   // reduced from 200
const DECAY_PER_HOUR     = 5;
const MAX_SIGNAL_HISTORY = 5;
const PRUNE_THRESHOLD    = 150;   // prune radarMap when it exceeds this

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
    month:    "short", day: "numeric",
    hour:     "numeric", minute: "numeric",
    hour12:   true
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

// ── DEBOUNCED save — batches burst signals into one write ─────────────────────
let _saveTimer = null;
function saveToDisk() {
  if (_saveTimer) return;          // already scheduled
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const dir = path.dirname(RADAR_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(RADAR_FILE, JSON.stringify(getRadar()), "utf8");
    } catch(e) {}
  }, 2000);
}

loadFromDisk();
setInterval(saveToDisk, 10 * 60 * 1000);  // reduced from 3 min → 10 min

function getCredibility(code) {
  if (!code) return null;
  try {
    const { getCredibilityForScrip } = require("./credibilityEngine");
    return getCredibilityForScrip(String(code));
  } catch(e) {
    return null;
  }
}

function getGuidanceSummary(code) {
  if (!code) return null;
  try {
    const { getGuidanceForScrip } = require("./presentationParser");
    const g = getGuidanceForScrip(String(code));
    if (!g || !g.hasData) return null;
    return {
      quarter:        g.quarter,
      revenueTargets: g.guidance?.revenue  || [],
      ebitdaTargets:  g.guidance?.ebitda   || [],
      capexTargets:   g.guidance?.capex    || [],
      orderTargets:   g.guidance?.orders   || [],
      extractedAt:    g.extractedAt
    };
  } catch(e) {
    return null;
  }
}

// ── Prune radarMap — remove decayed/low-score entries when too large ──────────
function pruneRadarMap() {
  if (radarMap.size <= PRUNE_THRESHOLD) return;
  // Score each entry and remove those that have decayed below threshold
  const toDelete = [];
  for (const [key, entry] of radarMap.entries()) {
    if (applyDecay(entry) < MIN_SCORE_TO_SHOW) toDelete.push(key);
  }
  for (const key of toDelete) radarMap.delete(key);

  // If still over threshold, remove oldest by receivedAt
  if (radarMap.size > PRUNE_THRESHOLD) {
    const sorted = [...radarMap.entries()]
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt);
    const excess = radarMap.size - MAX_RADAR_ITEMS;
    for (let i = 0; i < excess; i++) radarMap.delete(sorted[i][0]);
  }
}

function updateRadar(company, signal) {
  if (!company || !signal) return;

  const signalScore = SIGNAL_SCORES[signal.type] || 5;
  if (signalScore < MIN_SCORE_TO_SHOW) return;

  const key = normalizeName(company).toLowerCase();

  if (!radarMap.has(key)) {
    radarMap.set(key, {
      company:          normalizeName(company),
      code:             signal.code || null,
      score:            0,
      signals:          [],
      strength:         "WEAK",
      pdfUrl:           null,
      time:             null,
      receivedAt:       Date.now(),
      savedAt:          signal.savedAt || Date.now(),
      exchanges:        [],
      _orderInfo:       null,
      mcapRatio:        null,
      credibilityScore: null,
      credibilityLabel: null,
      credibilityColor: null,
      guidance:         null
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

  if (signal._orderInfo)              data._orderInfo = signal._orderInfo;
  if (signal.mcapRatio !== undefined) data.mcapRatio  = signal.mcapRatio;

  const cred = getCredibility(data.code);
  if (cred) {
    data.credibilityScore = cred.overallScore;
    data.credibilityLabel = cred.label;
    data.credibilityColor = cred.color;
  }

  const guidance = getGuidanceSummary(data.code);
  if (guidance) {
    data.guidance = guidance;
  }

  data.score      = Math.min(100, data.score + signalScore);
  data.receivedAt = Date.now();
  data.savedAt    = signal.savedAt || Date.now();
  data.time       = signal.time    || getIndianTime();
  if (signal.pdfUrl) data.pdfUrl = signal.pdfUrl;

  if      (data.score >= 70) data.strength = "VERY STRONG";
  else if (data.score >= 40) data.strength = "STRONG";
  else if (data.score >= 20) data.strength = "MODERATE";
  else                       data.strength = "WEAK";

  // Prune the map before save if it's grown too large
  pruneRadarMap();

  saveToDisk();  // debounced — safe to call on every signal
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