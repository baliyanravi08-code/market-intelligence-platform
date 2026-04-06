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
 * Emits:
 *   socket: "composite-scores"  → full leaderboard array
 *   socket: "composite-update"  → single stock update
 *
 * Usage in coordinator.js:
 *   const { startCompositeEngine, getCompositeScores, getCompositeForScrip } = require("./compositeScoreEngine");
 *   startCompositeEngine(io, { getCircuitWatchlist, getSmartMoneyFlows, getOpportunities, getCredibilityForScrip, getOIData });
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── Weight config (flow-first) ────────────────────────────────────────────────
const WEIGHTS = {
  smartMoney:   0.35,   // INSTITUTIONAL_DEAL, BLOCK_DEAL, INSIDER_BUY flows
  circuit:      0.25,   // proximity to circuit limit + tier
  opportunity:  0.20,   // order-value / market-cap ratio
  credibility:  0.20,   // management guidance hit rate
};

// ── In-memory store ───────────────────────────────────────────────────────────
// compositeMap: symbol → composite doc
const compositeMap = new Map();

// Raw signal stores — updated by ingest functions below
const smartMoneyStore  = new Map();   // symbol → { value, deals, lastSeen }
const opportunityStore = new Map();   // symbol → { score (ratio%), orderValue, marketCap, lastSeen }
const circuitStore     = new Map();   // symbol → circuitWatcher watchlist entry
const oiStore          = new Map();   // symbol → { pcr, callOI, putOI, lastSeen }

let ioRef = null;
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
    const arr = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    arr.forEach(d => compositeMap.set(d.symbol, d));
    console.log(`📊 CompositeScore: loaded ${arr.length} cached scores`);
  } catch (e) {
    console.log("⚠️ compositeScoreEngine load error:", e.message);
  }
}

// ── Signal ingestion ──────────────────────────────────────────────────────────

/**
 * Ingest a smart money event from smartMoneyTracker.js
 * shape: { company, value, deals, signal:"SMART_MONEY", time }
 */
function ingestSmartMoney(event) {
  if (!event?.company) return;
  const sym = normalizeSymbol(event.company);
  const prev = smartMoneyStore.get(sym) || { value: 0, deals: 0 };
  smartMoneyStore.set(sym, {
    value:    (prev.value || 0) + (event.value || 0),
    deals:    (prev.deals || 0) + (event.deals || 1),
    lastSeen: Date.now(),
    company:  event.company,
  });
  scheduleRecompute(sym);
}

/**
 * Ingest an opportunity event from opportunityEngine.js
 * shape: { company, code, score (ratio%), orderValue, marketCap, time }
 */
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

/**
 * Ingest the full circuit watchlist from circuitWatcher.js
 * shape: array of { symbol, ltp, distPct, side, tier, changePercent, ... }
 */
function ingestCircuitWatchlist(watchlist) {
  if (!Array.isArray(watchlist)) return;
  for (const entry of watchlist) {
    if (!entry?.symbol) continue;
    circuitStore.set(entry.symbol, { ...entry, lastSeen: Date.now() });
  }
}

/**
 * Ingest OI data (from nseOIListener / optionChainEngine)
 * shape: { symbol, pcr, callOI, putOI, maxPain, expiry }
 */
function ingestOI(data) {
  if (!data?.symbol) return;
  const sym = normalizeSymbol(data.symbol);
  oiStore.set(sym, { ...data, lastSeen: Date.now() });
  scheduleRecompute(sym);
}

// ── Score computation ─────────────────────────────────────────────────────────

const pendingRecompute = new Set();
let recomputeDebounce = null;

function scheduleRecompute(symbol) {
  pendingRecompute.add(symbol);
  clearTimeout(recomputeDebounce);
  recomputeDebounce = setTimeout(flushRecompute, 500);
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
 * Returns null if no signals exist for this symbol.
 */
function computeScore(symbol, credibilityGetter) {
  const sm      = smartMoneyStore.get(symbol);
  const opp     = opportunityStore.get(symbol);
  const circuit = circuitStore.get(symbol);
  const oi      = oiStore.get(symbol);

  // Need at least one signal
  if (!sm && !opp && !circuit && !oi) return null;

  const signals  = [];
  const reasons  = [];
  let   totalW   = 0;
  let   weightedSum = 0;

  // ── 1. Smart Money score (0–100) ─────────────────────────────────────────
  if (sm) {
    // Scale: ₹500Cr+ flow = 100, linear below
    const rawScore = Math.min(100, (sm.value / 500) * 100);
    const score    = rawScore;
    weightedSum   += score * WEIGHTS.smartMoney;
    totalW        += WEIGHTS.smartMoney;
    signals.push({ key: "smartMoney", score: Math.round(score), weight: WEIGHTS.smartMoney });
    reasons.push({
      label: "Smart Money",
      detail: `₹${formatCr(sm.value)} flow · ${sm.deals} deal${sm.deals > 1 ? "s" : ""}`,
      score:  Math.round(score),
      color:  score >= 70 ? "green" : score >= 40 ? "amber" : "gray",
      icon:   "💰",
    });
  }

  // ── 2. Circuit proximity score (0–100) ───────────────────────────────────
  if (circuit) {
    const tierScores = { LOCKED: 100, CRITICAL: 85, WARNING: 65, WATCH: 40, SAFE: 0 };
    const tierScore  = tierScores[circuit.tier] || 0;
    // Upper circuit = bullish signal, lower = bearish (we score proximity, not direction)
    const score      = tierScore;
    weightedSum     += score * WEIGHTS.circuit;
    totalW          += WEIGHTS.circuit;
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
    // opp.score is order-value/market-cap %. >20% = multibagger. Cap at 50%.
    const score = Math.min(100, (opp.score / 50) * 100);
    weightedSum += score * WEIGHTS.opportunity;
    totalW      += WEIGHTS.opportunity;
    signals.push({ key: "opportunity", score: Math.round(score), weight: WEIGHTS.opportunity });
    reasons.push({
      label:  "Order Opportunity",
      detail: `${opp.score.toFixed(1)}% of MCap · ₹${formatCr(opp.orderValue)} order`,
      score:  Math.round(score),
      color:  score >= 70 ? "green" : score >= 40 ? "amber" : "gray",
      icon:   "📦",
    });
  }

  // ── 4. Credibility score (0–100) — use injected getter ──────────────────
  const credScrip = symbol;
  let   credDoc   = null;
  if (typeof credibilityGetter === "function") {
    credDoc = credibilityGetter(credScrip);
  }
  if (credDoc?.overallScore != null) {
    const score  = credDoc.overallScore;
    weightedSum += score * WEIGHTS.credibility;
    totalW      += WEIGHTS.credibility;
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

  // Normalize to 0–100 based on actual weights present
  const finalScore = Math.round(weightedSum / totalW);

  const grade = finalScore >= 80 ? "A"
              : finalScore >= 65 ? "B"
              : finalScore >= 50 ? "C"
              : finalScore >= 35 ? "D"
              : "F";

  const bias = determineBias(circuit, sm, opp);

  // Top 3 reasons sorted by score desc
  const top3 = [...reasons].sort((a, b) => b.score - a.score).slice(0, 3);

  return {
    symbol,
    company:    sm?.company || opp?.company || symbol,
    finalScore,
    grade,
    bias,         // "BULLISH" | "BEARISH" | "NEUTRAL"
    signals,
    top3Reasons:  top3,
    allReasons:   reasons,
    updatedAt:    Date.now(),
    // Raw signal snapshots for drill-down
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
  if (sm && sm.value > 0) bullPoints += 1;  // smart money = institutional accumulation
  if (opp && opp.score > 10) bullPoints += 1;

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

/**
 * Start the composite engine.
 *
 * @param {object} io          - socket.io server instance
 * @param {object} deps        - injected signal sources
 *   deps.getCircuitWatchlist  - () => array (from circuitWatcher.getLastPollStocks)
 *   deps.getSmartMoneyFlows   - () => map/object of symbol→flow (optional)
 *   deps.getCredibilityForScrip - (scrip) => credibility doc
 */
function startCompositeEngine(io, deps = {}) {
  ioRef = io;
  loadFromDisk();

  const { getCredibilityForScrip } = deps;

  // Wire circuit watchlist events
  const { onCircuitWatchlist } = require("./circuitWatcher");
  onCircuitWatchlist((watchlist) => {
    ingestCircuitWatchlist(watchlist);
    recomputeAll(getCredibilityForScrip);
  });

  // Batch recompute every 60s to pick up any credibility/OI changes
  computeTimer = setInterval(() => {
    recomputeAll(getCredibilityForScrip);
  }, 60_000);

  // Initial compute from disk-cached circuit data if available
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
  // Lifecycle
  startCompositeEngine,
  stopCompositeEngine,

  // Signal ingestion (called from your listeners/engines)
  ingestSmartMoney,
  ingestOpportunity,
  ingestCircuitWatchlist,
  ingestOI,

  // Queries
  getLeaderboard,
  getCompositeForScrip,
  getTopN,
  getByBias,
  recomputeAll,
};