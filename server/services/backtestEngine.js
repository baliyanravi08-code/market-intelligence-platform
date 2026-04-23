/**
 * backtestEngine.js
 * Location: server/services/backtestEngine.js
 *
 * Fully automatic backtest engine:
 * - Receives live LTP ticks from upstoxStream
 * - Auto-resolves WIN/LOSS when price hits target or stop loss
 * - Intraday signals at 3:25 PM: resolved using LAST KNOWN LTP vs target/SL
 *   → WIN if lastLTP >= target, LOSS if lastLTP <= stopLoss, else EXPIRED with real P&L
 * - Swing signals carry forward
 * - All data stored in server/data/backtest_signals.json (no DB needed)
 * - Accuracy breakdown by: signal type, RSI, tech score, time, sector, stock
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "../data");
const DATA_FILE = path.join(DATA_DIR, "backtest_signals.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return { signals: [], sessions: {} };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); }
  catch { return { signals: [], sessions: {} }; }
}

function saveData(data) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── In-memory active signals (PENDING resolution only) ────────────────────────
// Map: symbol → [signalRecord, ...]
const activeSignals = new Map();

// ── FIX: Track last known LTP per symbol ─────────────────────────────────────
// This is used at 3:25 PM expiry to resolve based on actual last price
const lastKnownLTP = new Map(); // symbol → price

let ioRef = null;
function setIO(io) { ioRef = io; }

// ── IST helpers ───────────────────────────────────────────────────────────────
function getIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function todayStr() {
  const d = getIST();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function isMarketOpen() {
  const d   = getIST();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 555 && mins <= 935; // 9:15 to 15:35
}

// ── Capture a session of signals ──────────────────────────────────────────────
/**
 * Call this from marketScanner.js after signals are generated.
 * Each signal object should have:
 *   symbol, signal (type), price/ltp (entry), target, stopLoss,
 *   rsi, techScore, sector, macd, isSwing (optional)
 */
function captureSession(signals) {
  if (!signals || !signals.length) return { skipped: true, reason: "empty" };

  const data    = loadData();
  const today   = todayStr();
  const now     = getIST();
  const hh      = String(now.getHours()).padStart(2,"0");
  const mm      = String(now.getMinutes()).padStart(2,"0");
  const captureTime = `${hh}:${mm}`;
  const sessionKey  = `${today}_${captureTime}`;

  if (data.sessions[sessionKey]) {
    return { skipped: true, reason: "already_captured", sessionKey };
  }

  const processed = signals.map((s, idx) => {
    const signalId  = `${today}_${idx}_${(s.symbol || s.stock || "UNK").replace(/[^A-Z0-9]/gi,"_")}`;
    const entry     = parseFloat(s.price || s.ltp || s.entry || 0);
    const target    = parseFloat(s.target || s.tp || (entry * 1.03));
    const stopLoss  = parseFloat(s.stopLoss || s.sl || (entry * 0.98));
    const isSwing   = !!(s.isSwing || (s.signal || "").toLowerCase().includes("swing"));

    const record = {
      signalId,
      date:        today,
      captureTime,
      symbol:      (s.symbol || s.stock || "UNKNOWN").toUpperCase(),
      sector:      s.sector || s.industry || "Unknown",
      signalType:  s.signal || s.type || "BUY",
      entry,
      target,
      stopLoss,
      rsi:         parseFloat(s.rsi || 50),
      techScore:   parseFloat(s.techScore || s.strength || s.score || 0),
      macd:        s.macd?.crossover || s.macdSignal || "NEUTRAL",
      isSwing,
      // resolution fields (filled in when WIN/LOSS)
      status:      "PENDING",
      exitPrice:   null,
      exitTime:    null,
      pnlPct:      null,
      resolvedBy:  null,
      highReached: entry,
      lowReached:  entry,
      lastLTP:     entry,  // FIX: track last LTP, starts at entry
    };

    // Register in live tracking map
    if (!activeSignals.has(record.symbol)) activeSignals.set(record.symbol, []);
    activeSignals.get(record.symbol).push(record);

    return record;
  });

  data.sessions[sessionKey] = {
    date: today, captureTime,
    totalSignals: processed.length,
    resolved: 0, wins: 0, losses: 0,
  };
  data.signals.push(...processed);

  // Prune to last 60 days
  const cutoff = new Date(getIST());
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,"0")}-${String(cutoff.getDate()).padStart(2,"0")}`;
  data.signals = data.signals.filter(s => s.date >= cutoffStr);

  saveData(data);
  console.log(`✅ Backtest: captured ${processed.length} signals for ${today} @ ${captureTime}`);

  if (ioRef) ioRef.emit("backtest-session-captured", { sessionKey, count: processed.length, date: today });
  return { success: true, sessionKey, count: processed.length };
}

// ── Live LTP tick — called from upstoxStream for every stock price update ─────
function onLTPTick(symbol, price) {
  // FIX: Always update lastKnownLTP regardless of active signals
  // This ensures we have the latest price at 3:25 PM expiry time
  lastKnownLTP.set(symbol, price);

  if (!activeSignals.has(symbol)) return;

  const pending = activeSignals.get(symbol).filter(s => s.status === "PENDING");
  if (!pending.length) return;

  const resolvedIds = [];

  for (const sig of pending) {
    // FIX: Update lastLTP on the signal record itself
    sig.lastLTP = price;

    if (price > sig.highReached) sig.highReached = price;
    if (price < sig.lowReached)  sig.lowReached  = price;

    const isBuy = !["SELL","STRONG_SELL","SHORT","STRONG SELL"]
      .includes((sig.signalType || "").toUpperCase());

    let hit = null;
    if (isBuy) {
      if (price >= sig.target)        hit = "WIN";
      else if (price <= sig.stopLoss) hit = "LOSS";
    } else {
      if (price <= sig.target)        hit = "WIN";
      else if (price >= sig.stopLoss) hit = "LOSS";
    }

    if (hit) {
      _resolveSignal(sig, hit, price, `AUTO_${hit === "WIN" ? "TARGET" : "SL"}`);
      resolvedIds.push(sig.signalId);
    }
  }

  if (ioRef && resolvedIds.length === 0) {
    // Emit live price for progress bars in UI (throttled — only if pending signals exist)
    ioRef.emit("backtest-live-tick", { symbol, price });
  }
}

// ── Internal resolve ──────────────────────────────────────────────────────────
function _resolveSignal(sigRecord, result, exitPrice, resolvedBy) {
  const now      = getIST();
  const exitTime = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  sigRecord.status     = result;
  sigRecord.exitPrice  = exitPrice;
  sigRecord.exitTime   = exitTime;
  sigRecord.resolvedBy = resolvedBy;

  const isBuy = !["SELL","STRONG_SELL","SHORT","STRONG SELL"]
    .includes((sigRecord.signalType || "").toUpperCase());
  sigRecord.pnlPct = isBuy
    ? +((( exitPrice - sigRecord.entry) / sigRecord.entry) * 100).toFixed(2)
    : +((( sigRecord.entry - exitPrice) / sigRecord.entry) * 100).toFixed(2);

  // Persist
  const data = loadData();
  const idx  = data.signals.findIndex(s => s.signalId === sigRecord.signalId);
  if (idx !== -1) {
    data.signals[idx] = { ...data.signals[idx], ...sigRecord };

    // Update session aggregates
    const sessKey = Object.keys(data.sessions).find(k => k.startsWith(sigRecord.date));
    if (sessKey && data.sessions[sessKey]) {
      data.sessions[sessKey].resolved++;
      if (result.includes("WIN"))  data.sessions[sessKey].wins++;
      if (result.includes("LOSS")) data.sessions[sessKey].losses++;
    }
    saveData(data);
  }

  console.log(`🎯 Backtest: ${sigRecord.symbol} → ${result} @ ₹${exitPrice} (${resolvedBy}) P&L: ${sigRecord.pnlPct}%`);

  // FIX: Always emit resolved event so frontend mirrors the update
  if (ioRef) {
    ioRef.emit("backtest-resolved", {
      signalId:   sigRecord.signalId,
      symbol:     sigRecord.symbol,
      result,
      exitPrice,
      pnlPct:     sigRecord.pnlPct,
      resolvedBy,
      exitTime,
    });
  }
}

// ── Manual WIN/LOSS override ──────────────────────────────────────────────────
function manualResolve(signalId, result, exitPrice) {
  // Check active map first
  for (const sigs of activeSignals.values()) {
    const sig = sigs.find(s => s.signalId === signalId);
    if (sig && sig.status === "PENDING") {
      _resolveSignal(sig, result === "WIN" ? "MANUAL_WIN" : "MANUAL_LOSS", exitPrice, "MANUAL");
      return { success: true };
    }
  }
  // Fallback: load from disk and resolve
  const data = loadData();
  const sig  = data.signals.find(s => s.signalId === signalId);
  if (!sig) return { error: "Signal not found" };
  _resolveSignal(sig, result === "WIN" ? "MANUAL_WIN" : "MANUAL_LOSS", exitPrice, "MANUAL");
  return { success: true };
}

// ── FIX: Intraday expiry at 3:25 PM — resolve using LAST KNOWN LTP ────────────
/**
 * For each PENDING intraday signal at 3:25 PM:
 *   - Use lastLTP (last price received from stream, or sig.lastLTP from in-memory)
 *   - If lastLTP >= target  → WIN  (price was at/above target at close)
 *   - If lastLTP <= stopLoss → LOSS (price was at/below SL at close)
 *   - Otherwise             → EXPIRED with real P&L calculated from lastLTP
 */
function runIntradayExpiry() {
  const today = todayStr();
  const data  = loadData();
  let expiredCount = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const sig of data.signals) {
    if (sig.date !== today || sig.status !== "PENDING" || sig.isSwing) continue;

    // FIX: Get best available last price
    // Priority: live lastKnownLTP map → in-memory sig.lastLTP → sig.highReached → sig.entry
    const ltp = lastKnownLTP.get(sig.symbol)
             || sig.lastLTP
             || sig.highReached
             || sig.entry;

    const isBuy = !["SELL","STRONG_SELL","SHORT","STRONG SELL"]
      .includes((sig.signalType || "").toUpperCase());

    let result;
    if (isBuy) {
      if (ltp >= sig.target)        result = "WIN";
      else if (ltp <= sig.stopLoss) result = "LOSS";
      else                          result = "EXPIRED";
    } else {
      if (ltp <= sig.target)        result = "WIN";
      else if (ltp >= sig.stopLoss) result = "LOSS";
      else                          result = "EXPIRED";
    }

    _resolveSignal(sig, result, ltp, "INTRADAY_EXPIRE");

    if (result === "WIN")      winCount++;
    else if (result === "LOSS") lossCount++;
    else                        expiredCount++;
  }

  // Remove expired intraday from active map
  for (const [sym, sigs] of activeSignals.entries()) {
    const remaining = sigs.filter(s => s.isSwing && s.status === "PENDING");
    if (!remaining.length) activeSignals.delete(sym);
    else activeSignals.set(sym, remaining);
  }

  console.log(`⏰ Backtest: intraday expiry — WIN:${winCount} LOSS:${lossCount} EXPIRED:${expiredCount}`);

  // FIX: Emit a summary event so frontend can refresh its full state
  if (ioRef) {
    ioRef.emit("backtest-expiry-complete", {
      date: today,
      wins: winCount,
      losses: lossCount,
      expired: expiredCount,
      total: winCount + lossCount + expiredCount,
    });
  }
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function getAnalytics(days = 30) {
  const data   = loadData();
  const cutoff = new Date(getIST());
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,"0")}-${String(cutoff.getDate()).padStart(2,"0")}`;

  // FIX: Include EXPIRED in resolved set since we now calculate real P&L for them
  const RESOLVED = ["WIN","LOSS","MANUAL_WIN","MANUAL_LOSS","EXPIRED"];
  const signals  = data.signals.filter(s => s.date >= cutoffStr && RESOLVED.includes(s.status));

  const acc = (arr) => {
    if (!arr.length) return { wins: 0, losses: 0, expired: 0, total: 0, pct: 0, avgPnl: 0 };
    const wins    = arr.filter(s => s.status.includes("WIN")).length;
    const expired = arr.filter(s => s.status === "EXPIRED").length;
    const losses  = arr.length - wins - expired;
    const avgPnl  = arr.reduce((sum, s) => sum + (s.pnlPct || 0), 0) / arr.length;
    // Accuracy = wins out of (wins + losses), ignoring expired in denominator
    const resolved = wins + losses;
    return {
      wins, losses, expired,
      total: arr.length,
      pct: resolved > 0 ? Math.round((wins / resolved) * 100) : 0,
      avgPnl: +avgPnl.toFixed(2),
    };
  };

  // By signal type
  const byType = {};
  for (const s of signals) {
    (byType[s.signalType] = byType[s.signalType] || []).push(s);
  }

  // By RSI range
  const rsiRanges = { "<30": [], "30-50": [], "50-60": [], "60-70": [], ">70": [] };
  for (const s of signals) {
    const r = s.rsi;
    if      (r < 30) rsiRanges["<30"].push(s);
    else if (r < 50) rsiRanges["30-50"].push(s);
    else if (r < 60) rsiRanges["50-60"].push(s);
    else if (r < 70) rsiRanges["60-70"].push(s);
    else             rsiRanges[">70"].push(s);
  }

  // By tech score
  const techRanges = { "<40": [], "40-60": [], "60-75": [], "75-90": [], ">90": [] };
  for (const s of signals) {
    const t = s.techScore;
    if      (t < 40) techRanges["<40"].push(s);
    else if (t < 60) techRanges["40-60"].push(s);
    else if (t < 75) techRanges["60-75"].push(s);
    else if (t < 90) techRanges["75-90"].push(s);
    else             techRanges[">90"].push(s);
  }

  // By time slot
  const timeSlots = { "9:15-10:00": [], "10:00-11:30": [], "11:30-13:00": [], "13:00-15:25": [] };
  for (const s of signals) {
    const [h, m] = (s.captureTime || "09:15").split(":").map(Number);
    const mins   = h * 60 + m;
    if      (mins < 600) timeSlots["9:15-10:00"].push(s);
    else if (mins < 690) timeSlots["10:00-11:30"].push(s);
    else if (mins < 780) timeSlots["11:30-13:00"].push(s);
    else                 timeSlots["13:00-15:25"].push(s);
  }

  // By sector (top 10)
  const bySector = {};
  for (const s of signals) {
    (bySector[s.sector] = bySector[s.sector] || []).push(s);
  }

  // By stock (top 20 by count)
  const byStock = {};
  for (const s of signals) {
    (byStock[s.symbol] = byStock[s.symbol] || []).push(s);
  }

  // Daily trend
  const dailyMap = {};
  for (const s of signals) {
    (dailyMap[s.date] = dailyMap[s.date] || []).push(s);
  }
  const dailyTrend = Object.entries(dailyMap)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([date, arr]) => ({ date, ...acc(arr) }));

  return {
    overall: acc(signals),
    byType:  Object.fromEntries(Object.entries(byType).map(([k,v]) => [k, acc(v)])),
    byRSI:   Object.fromEntries(Object.entries(rsiRanges).map(([k,v]) => [k, acc(v)])),
    byTech:  Object.fromEntries(Object.entries(techRanges).map(([k,v]) => [k, acc(v)])),
    byTime:  Object.fromEntries(Object.entries(timeSlots).map(([k,v]) => [k, acc(v)])),
    bySector: Object.fromEntries(
      Object.entries(bySector).sort(([,a],[,b]) => b.length - a.length).slice(0,10).map(([k,v]) => [k, acc(v)])
    ),
    byStock: Object.fromEntries(
      Object.entries(byStock).sort(([,a],[,b]) => b.length - a.length).slice(0,20).map(([k,v]) => [k, acc(v)])
    ),
    dailyTrend,
    totalSignals: signals.length,
  };
}

// ── Data access ───────────────────────────────────────────────────────────────
function getSessionSignals(date) {
  return loadData().signals.filter(s => s.date === (date || todayStr()));
}

function getSessions() {
  const data = loadData();
  return Object.entries(data.sessions)
    .map(([key, s]) => ({ key, ...s }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ── Reload pending signals on server restart ──────────────────────────────────
function reloadActiveSignals() {
  const data  = loadData();
  const today = todayStr();
  let count   = 0;
  for (let i = 0; i < data.signals.length; i++) {
    const sig = data.signals[i];
    if (sig.date === today && sig.status === "PENDING") {
      if (!activeSignals.has(sig.symbol)) activeSignals.set(sig.symbol, []);
      activeSignals.get(sig.symbol).push(data.signals[i]);
      count++;
    }
  }
  if (count) console.log(`🔄 Backtest: reloaded ${count} active pending signals from disk`);
}
// ── FIX: Robust intraday expiry scheduler ────────────────────────────────────
/**
 * Schedules expiry at 3:25 PM IST every trading day.
 * Also checks on startup: if it's already past 3:25 PM today and
 * there are still PENDING signals, run expiry immediately.
 */
function scheduleIntradayExpiry() {
  const now = getIST();
  const exp = new Date(now);
  exp.setHours(15, 25, 0, 0);

  let ms = exp - now;

  if (ms <= 0) {
    // FIX: If we're past 3:25 PM today (e.g. server restarted at 4 PM),
    // check if there are still PENDING signals that need resolution
    const today = todayStr();
    const data  = loadData();
    const hasPending = data.signals.some(
      s => s.date === today && s.status === "PENDING" && !s.isSwing
    );

    if (hasPending) {
      console.log("⏰ Backtest: past 3:25 PM with pending signals — running expiry now");
      runIntradayExpiry();
    }

    // Schedule for tomorrow 3:25 PM
    ms += 24 * 60 * 60 * 1000;
  }

  setTimeout(() => {
    runIntradayExpiry();
    scheduleIntradayExpiry(); // reschedule for next day
  }, ms);

  const minsUntil = Math.round(ms / 60000);
  const hh = Math.floor(minsUntil / 60);
  const mm = minsUntil % 60;
  console.log(`⏰ Backtest: intraday expiry scheduled in ${hh}h ${mm}m`);
}

// ── Init — call from server.js ────────────────────────────────────────────────
function init(io) {
  ioRef = io;
  reloadActiveSignals();
  scheduleIntradayExpiry();
  console.log("✅ Backtest Engine initialized");
}

module.exports = {
  init,
  setIO,
  captureSession,
  onLTPTick,
  manualResolve,
  getAnalytics,
  getSessionSignals,
  getSessions,
  todayStr,
  isMarketOpen,
};