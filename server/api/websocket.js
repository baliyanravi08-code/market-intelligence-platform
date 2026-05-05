"use strict";

/**
 * backtestEngine.js
 * Location: server/services/backtestEngine.js
 *
 * CHANGES vs previous version:
 *
 *  1. Added fetchUpstoxOHLC()     — fetches today's OHLC from Upstox historical
 *                                   candle API using your existing access token.
 *                                   Zero new npm deps.
 *  2. Added runEODResolution()    — at 3:30 PM, resolves ALL still-pending signals
 *                                   using real HIGH/LOW from Upstox (not just last
 *                                   LTP tick which could be stale/missing).
 *  3. Added scheduleEODResolution() — self-scheduling timer at 3:30 PM IST daily.
 *  4. init() now calls scheduleEODResolution() alongside scheduleIntradayExpiry().
 *  5. runEODResolution exported for manual trigger via a route if needed.
 *
 *  WHY TWO PASSES:
 *   • 3:25 PM runIntradayExpiry()  — fast first pass, uses lastKnownLTP (live ticks).
 *                                    Catches most signals instantly during market hours.
 *   • 3:30 PM runEODResolution()   — authoritative second pass using Upstox OHLC.
 *                                    Catches anything missed: halted stocks, symbols
 *                                    not in your Upstox subscription, PRE-captured
 *                                    signals that arrived after stream started, etc.
 *
 *  Removed duplicate `backtest-live-tick` emit (upstoxStream.js handles it).
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ── Storage ───────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(process.cwd(), "data");
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

// ── In-memory active signals (PENDING only) ───────────────────────────────────
const activeSignals = new Map();

// ── Track last known LTP per symbol ──────────────────────────────────────────
const lastKnownLTP = new Map();

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
  return mins >= 555 && mins <= 935;
}

// ── Capture a session of signals ──────────────────────────────────────────────
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
      status:      "PENDING",
      exitPrice:   null,
      exitTime:    null,
      pnlPct:      null,
      resolvedBy:  null,
      highReached: entry,
      lowReached:  entry,
      lastLTP:     entry,
    };

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

// ── Live LTP tick ─────────────────────────────────────────────────────────────
function onLTPTick(symbol, price) {
  lastKnownLTP.set(symbol, price);

  if (!activeSignals.has(symbol)) return;
  const pending = activeSignals.get(symbol).filter(s => s.status === "PENDING");
  if (!pending.length) return;

  for (const sig of pending) {
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

    if (hit) _resolveSignal(sig, hit, price, `AUTO_${hit === "WIN" ? "TARGET" : "SL"}`);
  }
  // NOTE: backtest-live-tick emitted by upstoxStream.js — do NOT add here
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

  const data = loadData();
  const idx  = data.signals.findIndex(s => s.signalId === sigRecord.signalId);
  if (idx !== -1) {
    data.signals[idx] = { ...data.signals[idx], ...sigRecord };

    const sessKey = Object.keys(data.sessions).find(k => k.startsWith(sigRecord.date));
    if (sessKey && data.sessions[sessKey]) {
      data.sessions[sessKey].resolved++;
      if (result.includes("WIN"))  data.sessions[sessKey].wins++;
      if (result.includes("LOSS")) data.sessions[sessKey].losses++;
    }
    saveData(data);
  }

  console.log(`🎯 Backtest: ${sigRecord.symbol} → ${result} @ ₹${exitPrice} (${resolvedBy}) P&L: ${sigRecord.pnlPct}%`);

  if (ioRef) {
    ioRef.emit("backtest-resolved", {
      signalId: sigRecord.signalId, symbol: sigRecord.symbol,
      result, exitPrice, pnlPct: sigRecord.pnlPct, resolvedBy, exitTime,
    });
  }
}

// ── Manual override ───────────────────────────────────────────────────────────
function manualResolve(signalId, result, exitPrice) {
  for (const sigs of activeSignals.values()) {
    const sig = sigs.find(s => s.signalId === signalId);
    if (sig && sig.status === "PENDING") {
      _resolveSignal(sig, result === "WIN" ? "MANUAL_WIN" : "MANUAL_LOSS", exitPrice, "MANUAL");
      return { success: true };
    }
  }
  const data = loadData();
  const sig  = data.signals.find(s => s.signalId === signalId);
  if (!sig) return { error: "Signal not found" };
  _resolveSignal(sig, result === "WIN" ? "MANUAL_WIN" : "MANUAL_LOSS", exitPrice, "MANUAL");
  return { success: true };
}

// ── Intraday expiry at 3:25 PM (fast pass — uses live LTP) ───────────────────
function runIntradayExpiry() {
  const today = todayStr();
  const data  = loadData();
  let expiredCount = 0, winCount = 0, lossCount = 0;

  for (const sig of data.signals) {
    if (sig.date !== today || sig.status !== "PENDING" || sig.isSwing) continue;

    const ltp = lastKnownLTP.get(sig.symbol) || sig.lastLTP || sig.highReached || sig.entry;

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
    if (result === "WIN")       winCount++;
    else if (result === "LOSS") lossCount++;
    else                        expiredCount++;
  }

  for (const [sym, sigs] of activeSignals.entries()) {
    const remaining = sigs.filter(s => s.isSwing && s.status === "PENDING");
    if (!remaining.length) activeSignals.delete(sym);
    else activeSignals.set(sym, remaining);
  }

  console.log(`⏰ Backtest: intraday expiry — WIN:${winCount} LOSS:${lossCount} EXPIRED:${expiredCount}`);
  if (ioRef) {
    ioRef.emit("backtest-expiry-complete", {
      date: today, wins: winCount, losses: lossCount,
      expired: expiredCount, total: winCount + lossCount + expiredCount,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EOD RESOLUTION  —  3:30 PM authoritative pass via Upstox Historical API
// ─────────────────────────────────────────────────────────────────────────────

function getUpstoxToken() {
  // Lazy-load upstoxStream to avoid circular require at module load time
  try {
    const stream = require("./upstoxStream");
    const t = stream.getAccessToken();
    if (t) return t;
  } catch (_) {}
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// Fetch a single day's OHLC from Upstox historical candle API
// Endpoint: GET /v2/historical-candle/{instrumentKey}/day/{toDate}/{fromDate}
// Candle array: [timestamp, open, high, low, close, volume, oi]
function fetchUpstoxOHLC(symbol, dateStr) {
  return new Promise((resolve) => {
    const token    = getUpstoxToken();
    if (!token) { console.warn("⚠️  EOD: No Upstox token available"); return resolve(null); }

    const instrKey = encodeURIComponent(`NSE_EQ|${symbol.toUpperCase()}`);
    const options  = {
      hostname: "api.upstox.com",
      path:     `/v2/historical-candle/${instrKey}/day/${dateStr}/${dateStr}`,
      method:   "GET",
      headers:  {
        "Accept":        "application/json",
        "Authorization": `Bearer ${token}`,
      },
      timeout: 10000,
    };

    const req = https.get(options, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const json    = JSON.parse(raw);
          const candles = json?.data?.candles;
          if (!candles || !candles.length) return resolve(null);
          const [, open, high, low, close] = candles[0];
          if (high == null || low == null) return resolve(null);
          resolve({ open, high, low, close });
        } catch { resolve(null); }
      });
    });

    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function runEODResolution() {
  const today = todayStr();
  const data  = loadData();

  const pendingToday = data.signals.filter(s => s.date === today && s.status === "PENDING");
  if (!pendingToday.length) {
    console.log("⏰ EOD: No pending signals for today.");
    return { wins: 0, losses: 0, expired: 0, failed: 0 };
  }

  const symbols = [...new Set(pendingToday.map(s => s.symbol))];
  console.log(`⏰ EOD Resolution: fetching OHLC for ${symbols.length} symbol(s) via Upstox…`);

  // Fetch OHLC for all symbols
  const ohlcMap = {};
  for (const sym of symbols) {
    ohlcMap[sym] = await fetchUpstoxOHLC(sym, today);
    if (!ohlcMap[sym]) console.log(`   ⚠️  ${sym}: no data from Upstox`);
    await new Promise(r => setTimeout(r, 250)); // rate limit
  }

  // Re-load fresh in case _resolveSignal already wrote some (from live ticks)
  const freshData = loadData();
  let wins = 0, losses = 0, expired = 0, failed = 0;

  for (const sig of freshData.signals) {
    if (sig.date !== today || sig.status !== "PENDING") continue;

    const ohlc = ohlcMap[sig.symbol];
    if (!ohlc) { failed++; continue; }

    // Update tracking with real day data
    sig.highReached = Math.max(sig.highReached || sig.entry, ohlc.high);
    sig.lowReached  = Math.min(sig.lowReached  || sig.entry, ohlc.low);
    sig.lastLTP     = ohlc.close;

    const isBuy = !["SELL","STRONG_SELL","SHORT","STRONG SELL"]
      .includes((sig.signalType || "").toUpperCase());

    let result, exitPrice;

    if (isBuy) {
      const hitT  = ohlc.high >= sig.target;
      const hitSL = ohlc.low  <= sig.stopLoss;
      if      (hitT && hitSL) { result = "LOSS";    exitPrice = sig.stopLoss; }
      else if (hitT)           { result = "WIN";     exitPrice = sig.target;   }
      else if (hitSL)          { result = "LOSS";    exitPrice = sig.stopLoss; }
      else                     { result = "EXPIRED"; exitPrice = ohlc.close;   }
    } else {
      const hitT  = ohlc.low  <= sig.target;
      const hitSL = ohlc.high >= sig.stopLoss;
      if      (hitT && hitSL) { result = "LOSS";    exitPrice = sig.stopLoss; }
      else if (hitT)           { result = "WIN";     exitPrice = sig.target;   }
      else if (hitSL)          { result = "LOSS";    exitPrice = sig.stopLoss; }
      else                     { result = "EXPIRED"; exitPrice = ohlc.close;   }
    }

    _resolveSignal(sig, result, exitPrice, "EOD_UPSTOX");
    if (result === "WIN")    wins++;
    else if (result === "LOSS") losses++;
    else expired++;
  }

  console.log(`✅ EOD Resolution: WIN:${wins} LOSS:${losses} EXPIRED:${expired} FAILED:${failed}`);

  if (ioRef) {
    ioRef.emit("backtest-eod-complete", {
      date: today, wins, losses, expired, failed,
      total: wins + losses + expired,
    });
  }

  return { wins, losses, expired, failed };
}

// Schedule runEODResolution at 3:30 PM IST daily
function scheduleEODResolution() {
  const now = getIST();
  const eod = new Date(now);
  eod.setHours(15, 30, 0, 0);

  let ms = eod - now;

  if (ms <= 0) {
    // Already past 3:30 PM — check if there are still pending signals
    const data       = loadData();
    const hasPending = data.signals.some(s => s.date === todayStr() && s.status === "PENDING");
    if (hasPending) {
      console.log("⏰ EOD: past 3:30 PM with pending signals — running now");
      runEODResolution();
    }
    ms += 24 * 60 * 60 * 1000; // next day
  }

  setTimeout(async () => {
    await runEODResolution();
    scheduleEODResolution(); // self-reschedule
  }, ms);

  const minsUntil = Math.round(ms / 60000);
  console.log(`⏰ Backtest: EOD resolution scheduled in ${Math.floor(minsUntil/60)}h ${minsUntil%60}m (3:30 PM IST via Upstox)`);
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function getAnalytics(days = 30) {
  const data   = loadData();
  const cutoff = new Date(getIST());
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth()+1).padStart(2,"0")}-${String(cutoff.getDate()).padStart(2,"0")}`;

  const RESOLVED = ["WIN","LOSS","MANUAL_WIN","MANUAL_LOSS","EXPIRED"];
  const signals  = data.signals.filter(s => s.date >= cutoffStr && RESOLVED.includes(s.status));

  const acc = (arr) => {
    if (!arr.length) return { wins: 0, losses: 0, expired: 0, total: 0, pct: 0, avgPnl: 0 };
    const wins    = arr.filter(s => s.status.includes("WIN")).length;
    const expired = arr.filter(s => s.status === "EXPIRED").length;
    const losses  = arr.length - wins - expired;
    const avgPnl  = arr.reduce((sum, s) => sum + (s.pnlPct || 0), 0) / arr.length;
    const resolved = wins + losses;
    return {
      wins, losses, expired, total: arr.length,
      pct:    resolved > 0 ? Math.round((wins / resolved) * 100) : 0,
      avgPnl: +avgPnl.toFixed(2),
    };
  };

  const byType    = {};
  const bySector  = {};
  const byStock   = {};
  const dailyMap  = {};

  for (const s of signals) {
    (byType[s.signalType]  = byType[s.signalType]  || []).push(s);
    (bySector[s.sector]    = bySector[s.sector]    || []).push(s);
    (byStock[s.symbol]     = byStock[s.symbol]     || []).push(s);
    (dailyMap[s.date]      = dailyMap[s.date]      || []).push(s);
  }

  const rsiRanges  = { "<30": [], "30-50": [], "50-60": [], "60-70": [], ">70": [] };
  const techRanges = { "<40": [], "40-60": [], "60-75": [], "75-90": [], ">90": [] };
  const timeSlots  = { "9:15-10:00": [], "10:00-11:30": [], "11:30-13:00": [], "13:00-15:25": [] };

  for (const s of signals) {
    const r = s.rsi;
    if      (r < 30) rsiRanges["<30"].push(s);
    else if (r < 50) rsiRanges["30-50"].push(s);
    else if (r < 60) rsiRanges["50-60"].push(s);
    else if (r < 70) rsiRanges["60-70"].push(s);
    else             rsiRanges[">70"].push(s);

    const t = s.techScore;
    if      (t < 40) techRanges["<40"].push(s);
    else if (t < 60) techRanges["40-60"].push(s);
    else if (t < 75) techRanges["60-75"].push(s);
    else if (t < 90) techRanges["75-90"].push(s);
    else             techRanges[">90"].push(s);

    const [h, m] = (s.captureTime || "09:15").split(":").map(Number);
    const mins   = h * 60 + m;
    if      (mins < 600) timeSlots["9:15-10:00"].push(s);
    else if (mins < 690) timeSlots["10:00-11:30"].push(s);
    else if (mins < 780) timeSlots["11:30-13:00"].push(s);
    else                 timeSlots["13:00-15:25"].push(s);
  }

  const dailyTrend = Object.entries(dailyMap)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([date, arr]) => ({ date, ...acc(arr) }));

  return {
    overall:  acc(signals),
    byType:   Object.fromEntries(Object.entries(byType).map(([k,v])  => [k, acc(v)])),
    byRSI:    Object.fromEntries(Object.entries(rsiRanges).map(([k,v])  => [k, acc(v)])),
    byTech:   Object.fromEntries(Object.entries(techRanges).map(([k,v]) => [k, acc(v)])),
    byTime:   Object.fromEntries(Object.entries(timeSlots).map(([k,v])  => [k, acc(v)])),
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

// ── Intraday expiry scheduler ─────────────────────────────────────────────────
function scheduleIntradayExpiry() {
  const now = getIST();
  const exp = new Date(now);
  exp.setHours(15, 25, 0, 0);

  let ms = exp - now;

  if (ms <= 0) {
    const data       = loadData();
    const hasPending = data.signals.some(s => s.date === todayStr() && s.status === "PENDING" && !s.isSwing);
    if (hasPending) {
      console.log("⏰ Backtest: past 3:25 PM with pending signals — running intraday expiry now");
      runIntradayExpiry();
    }
    ms += 24 * 60 * 60 * 1000;
  }

  setTimeout(() => { runIntradayExpiry(); scheduleIntradayExpiry(); }, ms);

  const minsUntil = Math.round(ms / 60000);
  console.log(`⏰ Backtest: intraday expiry scheduled in ${Math.floor(minsUntil/60)}h ${minsUntil%60}m (3:25 PM IST)`);
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init(io) {
  ioRef = io;
  reloadActiveSignals();
  scheduleIntradayExpiry();
  scheduleEODResolution();  // ← NEW: authoritative EOD pass at 3:30 PM via Upstox
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
  runEODResolution,  // ← exported for manual trigger via route
};