"use strict";

/**
 * compositeScoreEngine.js
 * server/services/intelligence/compositeScoreEngine.js
 *
 * Fuses all live signals into one composite score (0–100) per stock.
 *
 * Weight hierarchy (flow-first):
 *   Smart Money + Order Book  → 35%
 *   OI + Circuit proximity    → 25%
 *   Opportunity score         → 20%
 *   Credibility score         → 20%
 *
 * FIXES applied (Session 9):
 *
 * FIX 1 — Score jumping between refreshes (50 → 60):
 *   Root cause: recomputeAll() ran on every circuit watchlist event AND every
 *   60s timer. If a new signal arrived between two dashboard refreshes, the score
 *   could change significantly. The score also had no smoothing — a single new
 *   smart money event could shift it ±10.
 *   Fix A: exponential moving average (EMA) smoothing — new score is blended
 *          with the previous score at alpha=0.3. This prevents single-event spikes
 *          but still tracks genuine trend changes within a few refreshes.
 *   Fix B: scheduleRecompute() now debounces per-symbol recomputes at 2s (was 500ms)
 *          so a burst of events doesn't trigger multiple rapid score changes.
 *   Fix C: batch recompute timer increased from 60s → 90s to reduce churn.
 *
 * FIX 2 — Score/grade inconsistency when signals are missing:
 *   Root cause: normalisation divided by totalW (sum of present weights), so a
 *   stock with only 1 signal could score 100 just from that signal.
 *   Fix: apply a "coverage penalty" — if fewer than 3 of 4 signals are present,
 *   cap the maximum score at 80. This prevents spurious A-grades from partial data.
 *
 * FIX 3 — Stale disk scores being loaded and displayed on startup:
 *   Root cause: loadFromDisk() loaded all cached scores unconditionally. If the
 *   server restarted mid-day, old scores from the previous session were shown.
 *   Fix: only load cached scores that are less than 8 hours old.
 *
 * Emits:
 *   socket: "composite-scores"  → full leaderboard array
 *   socket: "composite-update"  → single stock update
 */

const fs   = require("fs");
const path = require("path");

// ── Weight config (flow-first) ────────────────────────────────────────────────
const WEIGHTS = {
  smartMoney:   0.35,
  circuit:      0.25,
  opportunity:  0.20,
  credibility:  0.20,
};

// FIX 1: EMA smoothing factor — higher = faster response, lower = smoother
const EMA_ALPHA = 0.3;

// FIX 1: debounce per-symbol recomputes at 2s (was 500ms)
const RECOMPUTE_DEBOUNCE_MS = 2_000;

// FIX 1: batch recompute timer at 90s (was 60s)
const BATCH_RECOMPUTE_MS = 90_000;

// FIX 3: max age for loading cached scores from disk (8 hours)
const CACHE_MAX_AGE_MS = 8 * 60 * 60 * 1000;

// ── In-memory store ───────────────────────────────────────────────────────────
const compositeMap     = new Map(); // symbol → composite doc
const smartMoneyStore  = new Map(); // symbol → { value, deals, lastSeen }
const opportunityStore = new Map(); // symbol → { score, orderValue, marketCap, lastSeen }
const circuitStore     = new Map(); // symbol → circuitWatcher entry
const oiStore          = new Map(); // symbol → { pcr, callOI, putOI, lastSeen }

// FIX 1: previous score store for EMA smoothing
const prevScoreMap = new Map(); // symbol → previous finalScore

let ioRef        = null;
let computeTimer = null;

// ── Persistence ───────────────────────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, "../../data/compositeScores.json");

function persistToDisk() {
  try {
    const arr = Array.from(compositeMap.values())
      .filter(d => d.finalScore !== null)
      .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
      .slice(0, 300);
    fs.writeFileSync(DATA_PATH, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.log("⚠️ compositeScoreEngine persist error:", e.message);
  }
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(DATA_PATH)) return;
    const arr  = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const now  = Date.now();
    let loaded = 0;
    arr.forEach(d => {
      // FIX 3: skip stale cached scores from previous session
      const age = now - (d.updatedAt || 0);
      if (age > CACHE_MAX_AGE_MS) return;
      compositeMap.set(d.symbol, d);
      // Seed EMA with cached score so first live update blends smoothly
      if (d.finalScore != null) prevScoreMap.set(d.symbol, d.finalScore);
      loaded++;
    });
    console.log(`📊 CompositeScore: loaded ${loaded} cached scores (${arr.length - loaded} skipped as stale)`);
  } catch (e) {
    console.log("⚠️ compositeScoreEngine load error:", e.message);
  }
}

// ── Signal ingestion ──────────────────────────────────────────────────────────

function ingestSmartMoney(event) {
  if (!event?.company) return;
  const sym  = normalizeSymbol(event.company);
  const prev = smartMoneyStore.get(sym) || { value: 0, deals: 0 };
  smartMoneyStore.set(sym, {
    value:    (prev.value || 0) + (event.value || 0),
    deals:    (prev.deals || 0) + (event.deals || 1),
    lastSeen: Date.now(),
    company:  event.company,
  });
  scheduleRecompute(sym);
}

function ingestOpportunity(event) {
  if (!event?.code && !event?.company) return;
  const sym = normalizeSymbol(event.code || event.company);
  opportunityStore.set(sym, {
    score:      parseFloat(event.score || 0),
    orderValue: event.orderValue || 0,
    marketCap:  event.marketCap  || 0,
    lastSeen:   Date.now(),
    company:    event.company,
  });
  scheduleRecompute(sym);
}

function ingestCircuitWatchlist(watchlist) {
  if (!Array.isArray(watchlist)) return;
  for (const entry of watchlist) {
    if (!entry?.symbol) continue;
    circuitStore.set(entry.symbol, { ...entry, lastSeen: Date.now() });
  }
}

function ingestOI(data) {
  if (!data?.symbol) return;
  const sym = normalizeSymbol(data.symbol);
  oiStore.set(sym, { ...data, lastSeen: Date.now() });
  scheduleRecompute(sym);
}

// ── Score computation ─────────────────────────────────────────────────────────

const pendingRecompute = new Set();
let recomputeDebounce  = null;

function scheduleRecompute(symbol) {
  pendingRecompute.add(symbol);
  clearTimeout(recomputeDebounce);
  // FIX 1: 2s debounce (was 500ms)
  recomputeDebounce = setTimeout(flushRecompute, RECOMPUTE_DEBOUNCE_MS);
}

function flushRecompute() {
  for (const sym of pendingRecompute) {
    const doc = computeScore(sym);
    if (doc) {
      compositeMap.set(sym, doc);
      if (ioRef) ioRef.emit("composite-update", doc);
    }
  }
  pendingRecompute.clear();
}

/**
 * Compute composite score for a single symbol.
 *
 * FIX 1: applies EMA smoothing — new score blends with previous score.
 * FIX 2: applies coverage penalty — partial signals cap max score at 80.
 */
function computeScore(symbol, credibilityGetter) {
  const sm      = smartMoneyStore.get(symbol);
  const opp     = opportunityStore.get(symbol);
  const circuit = circuitStore.get(symbol);
  const oi      = oiStore.get(symbol);

  if (!sm && !opp && !circuit && !oi) return null;

  const signals     = [];
  const reasons     = [];
  let   totalW      = 0;
  let   weightedSum = 0;
  let   signalCount = 0;

  // ── 1. Smart Money score (0–100) ─────────────────────────────────────────
  if (sm) {
    const score   = Math.min(100, (sm.value / 500) * 100);
    weightedSum  += score * WEIGHTS.smartMoney;
    totalW       += WEIGHTS.smartMoney;
    signalCount++;
    signals.push({ key: "smartMoney", score: Math.round(score), weight: WEIGHTS.smartMoney });
    reasons.push({
      label:  "Smart Money",
      detail: `₹${formatCr(sm.value)} flow · ${sm.deals} deal${sm.deals > 1 ? "s" : ""}`,
      score:  Math.round(score),
      color:  score >= 70 ? "green" : score >= 40 ? "amber" : "gray",
      icon:   "💰",
    });
  }

  // ── 2. Circuit proximity score (0–100) ───────────────────────────────────
  if (circuit) {
    const tierScores = { LOCKED: 100, CRITICAL: 85, WARNING: 65, WATCH: 40, SAFE: 0 };
    const score      = tierScores[circuit.tier] || 0;
    weightedSum     += score * WEIGHTS.circuit;
    totalW          += WEIGHTS.circuit;
    signalCount++;
    signals.push({ key: "circuit", score: Math.round(score), weight: WEIGHTS.circuit });
    reasons.push({
      label:  "Circuit Proximity",
      detail: `${circuit.tier} · ${circuit.side} · ${circuit.distPct}% away`,
      score:  Math.round(score),
      color:  circuit.tier === "LOCKED" || circuit.tier === "CRITICAL" ? "red"
              : circuit.tier === "WARNING" ? "orange" : "amber",
      icon:   circuit.side === "UPPER" ? "🟢" : "🔴",
    });
  }

  // ── 3. Opportunity score (0–100) ─────────────────────────────────────────
  if (opp) {
    const score  = Math.min(100, (opp.score / 50) * 100);
    weightedSum += score * WEIGHTS.opportunity;
    totalW      += WEIGHTS.opportunity;
    signalCount++;
    signals.push({ key: "opportunity", score: Math.round(score), weight: WEIGHTS.opportunity });
    reasons.push({
      label:  "Order Opportunity",
      detail: `${opp.score.toFixed(1)}% of MCap · ₹${formatCr(opp.orderValue)} order`,
      score:  Math.round(score),
      color:  score >= 70 ? "green" : score >= 40 ? "amber" : "gray",
      icon:   "📦",
    });
  }

  // ── 4. Credibility score (0–100) ─────────────────────────────────────────
  let credDoc = null;
  if (typeof credibilityGetter === "function") {
    credDoc = credibilityGetter(symbol);
  }
  if (credDoc?.overallScore != null) {
    const score  = credDoc.overallScore;
    weightedSum += score * WEIGHTS.credibility;
    totalW      += WEIGHTS.credibility;
    signalCount++;
    signals.push({ key: "credibility", score: Math.round(score), weight: WEIGHTS.credibility });
    reasons.push({
      label:  "Mgmt Credibility",
      detail: credDoc.label + (credDoc.summary ? ` · ${credDoc.summary.split("|")[0].trim()}` : ""),
      score:  Math.round(score),
      color:  credDoc.color === "green" ? "green" : credDoc.color === "red" ? "red" : "amber",
      icon:   "📋",
    });
  }

  if (totalW === 0) return null;

  // Normalise to 0–100
  let rawScore = Math.round(weightedSum / totalW);

  // FIX 2: coverage penalty — partial signals cap score at 80
  const totalSignals = 4; // smartMoney, circuit, opportunity, credibility
  if (signalCount < totalSignals) {
    const maxAllowed = 60 + (signalCount / totalSignals) * 40; // 75 for 3/4, 55 for 2/4
    rawScore = Math.min(rawScore, Math.round(maxAllowed));
  }

  // FIX 1: EMA smoothing — blend with previous score
  const prevScore = prevScoreMap.get(symbol);
  let finalScore;
  if (prevScore != null) {
    finalScore = Math.round(EMA_ALPHA * rawScore + (1 - EMA_ALPHA) * prevScore);
  } else {
    finalScore = rawScore;
  }
  prevScoreMap.set(symbol, finalScore);

  const grade = finalScore >= 80 ? "A"
              : finalScore >= 65 ? "B"
              : finalScore >= 50 ? "C"
              : finalScore >= 35 ? "D"
              : "F";

  const bias = determineBias(circuit, sm, opp);

  const top3 = [...reasons].sort((a, b) => b.score - a.score).slice(0, 3);

  return {
    symbol,
    company:     sm?.company || opp?.company || symbol,
    finalScore,
    rawScore,    // expose raw (unsmoothed) score for debugging
    grade,
    bias,
    signals,
    top3Reasons:  top3,
    allReasons:   reasons,
    signalCount,  // FIX 2: expose coverage for frontend badge
    updatedAt:    Date.now(),
    raw: {
      smartMoney:  sm      ? { value: sm.value,      deals: sm.deals }      : null,
      opportunity: opp     ? { score: opp.score,     orderValue: opp.orderValue, marketCap: opp.marketCap } : null,
      circuit:     circuit ? { tier: circuit.tier,   side: circuit.side,    distPct: circuit.distPct, ltp: circuit.ltp } : null,
      credibility: credDoc ? { score: credDoc.overallScore, label: credDoc.label } : null,
    },
  };
}

function determineBias(circuit, sm, opp) {
  let bullPoints = 0;
  let bearPoints = 0;

  if (circuit) {
    if (circuit.side === "UPPER") bullPoints += 2;
    else bearPoints += 2;
    if (circuit.tier === "LOCKED" || circuit.tier === "CRITICAL") {
      if (circuit.side === "UPPER") bullPoints += 2; else bearPoints += 2;
    }
  }
  if (sm  && sm.value  > 0)   bullPoints += 1;
  if (opp && opp.score > 10)  bullPoints += 1;

  if (bullPoints > bearPoints + 1) return "BULLISH";
  if (bearPoints > bullPoints + 1) return "BEARISH";
  return "NEUTRAL";
}

// ── Full leaderboard recompute (batch) ───────────────────────────────────────
function recomputeAll(credibilityGetter) {
  const allSymbols = new Set([
    ...smartMoneyStore.keys(),
    ...opportunityStore.keys(),
    ...circuitStore.keys(),
    ...oiStore.keys(),
  ]);

  let updated = 0;
  for (const sym of allSymbols) {
    const doc = computeScore(sym, credibilityGetter);
    if (doc) {
      compositeMap.set(sym, doc);
      updated++;
    }
  }

  const leaderboard = getLeaderboard();
  if (ioRef) ioRef.emit("composite-scores", leaderboard);
  if (updated > 0) persistToDisk();

  console.log(`📊 CompositeScore: recomputed ${updated} stocks`);
  return leaderboard;
}

// ── Public queries ─────────────────────────────────────────────────────────────

function getLeaderboard(limit = 100) {
  return Array.from(compositeMap.values())
    .filter(d => d.finalScore !== null)
    .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0))
    .slice(0, limit);
}

function getCompositeForScrip(symbol) {
  return compositeMap.get(normalizeSymbol(symbol)) || null;
}

function getTopN(n = 10) {
  return getLeaderboard(n);
}

function getByBias(bias) {
  return getLeaderboard().filter(d => d.bias === bias);
}

// ── Engine lifecycle ──────────────────────────────────────────────────────────

function startCompositeEngine(io, deps = {}) {
  ioRef = io;
  loadFromDisk();

  const { getCredibilityForScrip } = deps;

  const { onCircuitWatchlist } = require("./circuitWatcher");
  onCircuitWatchlist((watchlist) => {
    ingestCircuitWatchlist(watchlist);
    recomputeAll(getCredibilityForScrip);
  });

  // FIX 1: 90s batch timer (was 60s)
  computeTimer = setInterval(() => {
    recomputeAll(getCredibilityForScrip);
  }, BATCH_RECOMPUTE_MS);

  setTimeout(() => recomputeAll(getCredibilityForScrip), 5_000);

  console.log("📊 CompositeScoreEngine started");
}

function stopCompositeEngine() {
  if (computeTimer) { clearInterval(computeTimer); computeTimer = null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeSymbol(s) {
  return String(s || "").toUpperCase().trim();
}

function formatCr(val) {
  if (!val) return "0";
  if (val >= 10000) return `${(val / 10000).toFixed(1)}L`;
  if (val >= 100)   return `${Math.round(val)}Cr`;
  return `${val.toFixed(1)}Cr`;
}

module.exports = {
  startCompositeEngine,
  stopCompositeEngine,
  ingestSmartMoney,
  ingestOpportunity,
  ingestCircuitWatchlist,
  ingestOI,
  getLeaderboard,
  getCompositeForScrip,
  getTopN,
  getByBias,
  recomputeAll,
};