"use strict";

/**
 * resolveBacktestSignals.js
 * Location: server/scripts/resolveBacktestSignals.js
 *
 * Resolves all PENDING backtest signals from past dates using
 * Upstox Historical Candle API — no external deps, uses your
 * existing UPSTOX_ACCESS_TOKEN from .env
 *
 * USAGE:
 *   node server/scripts/resolveBacktestSignals.js
 *   node server/scripts/resolveBacktestSignals.js --dry-run
 *   node server/scripts/resolveBacktestSignals.js --date 2026-04-23
 *   node server/scripts/resolveBacktestSignals.js --from 2026-04-01
 *
 * RESOLUTION LOGIC:
 *   BUY  → WIN if day HIGH >= Target  | LOSS if day LOW <= StopLoss
 *   SELL → WIN if day LOW  <= Target  | LOSS if day HIGH >= StopLoss
 *   Both hit same day → LOSS (conservative, SL assumed first)
 *   Neither hit       → EXPIRED at close price
 *
 *   isSwing signals: checked across up to MAX_SWING_DAYS trading days
 */

require("dotenv").config();

const fs    = require("fs");
const path  = require("path");
const https = require("https");

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_FILE      = path.join(process.cwd(), "data", "backtest_signals.json");
const DRY_RUN        = process.argv.includes("--dry-run");
const MAX_SWING_DAYS = 10;
const DELAY_MS       = 300; // ms between Upstox API calls

const DATE_ARG = (() => { const i = process.argv.indexOf("--date"); return i !== -1 ? process.argv[i+1] : null; })();
const FROM_ARG = (() => { const i = process.argv.indexOf("--from"); return i !== -1 ? process.argv[i+1] : null; })();

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadData() {
  if (!fs.existsSync(DATA_FILE)) { console.error("❌ backtest_signals.json not found:", DATA_FILE); process.exit(1); }
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}

function saveData(data) {
  if (DRY_RUN) return;
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function todayIST() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function isBuySignal(signalType) {
  return !["SELL","STRONG_SELL","SHORT","STRONG SELL"].includes((signalType||"").toUpperCase());
}

function getTradingDays(fromStr, toStr) {
  const days = [];
  const cur  = new Date(`${fromStr}T00:00:00+05:30`);
  const end  = new Date(`${toStr}T00:00:00+05:30`);
  while (cur <= end) {
    if (cur.getDay() !== 0 && cur.getDay() !== 6) days.push(cur.toISOString().slice(0,10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function addTradingDays(dateStr, n) {
  const cur = new Date(`${dateStr}T00:00:00+05:30`);
  let added = 0;
  while (added < n) { cur.setDate(cur.getDate()+1); if (cur.getDay()!==0 && cur.getDay()!==6) added++; }
  return cur.toISOString().slice(0,10);
}

// ── Upstox Historical Candle API ──────────────────────────────────────────────
// Endpoint: GET /v2/historical-candle/{instrumentKey}/{interval}/{toDate}/{fromDate}
// instrument key format for NSE equity: NSE_EQ|{SYMBOL}
// interval: day | week | month | 1minute | 30minute etc.
// Returns candles: [ [timestamp, open, high, low, close, volume, oi], ... ]

const _ohlcCache = {}; // "SYMBOL|DATE" → {open,high,low,close} | null

function getToken() {
  // Try upstoxStream first (in case it's been set at runtime), then env
  try {
    const stream = require("../services/upstoxStream");
    const t = stream.getAccessToken();
    if (t) return t;
  } catch (_) {}
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

async function fetchOHLC(symbol, dateStr) {
  const cacheKey = `${symbol}|${dateStr}`;
  if (cacheKey in _ohlcCache) return _ohlcCache[cacheKey];

  const token = getToken();
  if (!token) {
    console.error("❌ No Upstox access token found. Set UPSTOX_ACCESS_TOKEN in .env");
    process.exit(1);
  }

  // Upstox needs from=dateStr, to=dateStr for a single day's candle
  const instrKey = encodeURIComponent(`NSE_EQ|${symbol.toUpperCase()}`);
  const result   = await new Promise((resolve) => {
    const options = {
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

          // candle format: [timestamp, open, high, low, close, volume, oi]
          // For a single day request we get exactly one candle
          const [, open, high, low, close] = candles[0];
          if (high == null || low == null) return resolve(null);
          resolve({ open, high, low, close });
        } catch { resolve(null); }
      });
    });

    req.on("error",   () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });

  _ohlcCache[cacheKey] = result;
  return result;
}

// ── Check one signal against one day's OHLC ───────────────────────────────────
function checkDay(sig, ohlc) {
  const buy = isBuySignal(sig.signalType);
  let result, exitPrice;

  if (buy) {
    const hitT  = ohlc.high >= sig.target;
    const hitSL = ohlc.low  <= sig.stopLoss;
    if      (hitT && hitSL) { result = "LOSS"; exitPrice = sig.stopLoss; }
    else if (hitT)           { result = "WIN";  exitPrice = sig.target;   }
    else if (hitSL)          { result = "LOSS"; exitPrice = sig.stopLoss; }
    else                     return { hit: false };
  } else {
    const hitT  = ohlc.low  <= sig.target;
    const hitSL = ohlc.high >= sig.stopLoss;
    if      (hitT && hitSL) { result = "LOSS"; exitPrice = sig.stopLoss; }
    else if (hitT)           { result = "WIN";  exitPrice = sig.target;   }
    else if (hitSL)          { result = "LOSS"; exitPrice = sig.stopLoss; }
    else                     return { hit: false };
  }

  const pnlPct = buy
    ? +((( exitPrice - sig.entry) / sig.entry) * 100).toFixed(2)
    : +((( sig.entry - exitPrice) / sig.entry) * 100).toFixed(2);

  return { hit: true, result, exitPrice, pnlPct };
}

// ── Apply resolution to data object ───────────────────────────────────────────
function applyResolution(data, sig, res) {
  const idx = data.signals.findIndex(s => s.signalId === sig.signalId);
  if (idx === -1) return;

  data.signals[idx] = {
    ...data.signals[idx],
    status:       res.result,
    exitPrice:    res.exitPrice,
    exitTime:     "15:30",
    pnlPct:       res.pnlPct,
    resolvedBy:   "BACKFILL_UPSTOX",
    resolvedDate: res.resolvedDate,
    highReached:  res.highReached,
    lowReached:   res.lowReached,
    lastLTP:      res.lastLTP,
  };

  // Update session counters
  const sessKey = Object.keys(data.sessions || {}).find(k => k.startsWith(sig.date));
  if (sessKey && data.sessions[sessKey]) {
    const sess = data.sessions[sessKey];
    sess.resolved = (sess.resolved || 0) + 1;
    if (res.result === "WIN")     sess.wins    = (sess.wins    || 0) + 1;
    if (res.result === "LOSS")    sess.losses  = (sess.losses  || 0) + 1;
    if (res.result === "EXPIRED") sess.expired = (sess.expired || 0) + 1;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log("\n" + "═".repeat(60));
  console.log("  Backtest Signal Resolver — Upstox Historical API");
  if (DRY_RUN) console.log("  ⚠️  DRY RUN — nothing will be written");
  console.log("═".repeat(60) + "\n");

  const data  = loadData();
  const today = todayIST();

  const pending = data.signals.filter(s => {
    if (s.status !== "PENDING") return false;
    if (s.date >= today)        return false;
    if (DATE_ARG && s.date !== DATE_ARG) return false;
    if (FROM_ARG && s.date <  FROM_ARG)  return false;
    return true;
  });

  if (!pending.length) {
    console.log("✅ No past pending signals — everything already resolved.\n");
    return;
  }

  const dates = [...new Set(pending.map(s => s.date))].sort();
  console.log(`📊 ${pending.length} pending signal(s) across ${dates.length} date(s)`);
  console.log(`   ${dates.join("  ")}\n`);

  let totalWin = 0, totalLoss = 0, totalExpired = 0, totalFailed = 0;

  for (const date of dates) {
    const daySignals = pending.filter(s => s.date === date);
    console.log(`── ${date}  (${daySignals.length} signals) ${"─".repeat(28)}`);

    for (const sig of daySignals) {
      const isSwing = !!sig.isSwing;

      let checkDates;
      if (isSwing) {
        const maxDate = addTradingDays(sig.date, MAX_SWING_DAYS);
        const endDate = maxDate < today ? maxDate : addTradingDays(today, -1);
        checkDates    = getTradingDays(sig.date, endDate);
      } else {
        // Intraday signal captured after market hours → check NEXT trading day
        // because the signal was meant for next day's open (PRE type, 18:55 capture)
        const captureHour = parseInt((sig.captureTime || "09:00").split(":")[0]);
        if (captureHour >= 16) {
          // After market — signal is for next trading day
          checkDates = [addTradingDays(sig.date, 1)].filter(d => d < today);
        } else {
          checkDates = [sig.date];
        }
      }

      if (!checkDates.length) {
        console.log(`   ${sig.symbol.padEnd(15)} ⏭️  skipping — check date is today or future`);
        continue;
      }

      let resolved  = false;
      let finalOHLC = null;
      let trackHigh = sig.highReached || sig.entry;
      let trackLow  = sig.lowReached  || sig.entry;

      for (const checkDate of checkDates) {
        process.stdout.write(`   ${sig.symbol.padEnd(15)} ${(sig.signalType||"BUY").padEnd(12)} [${checkDate}] … `);

        const ohlc = await fetchOHLC(sig.symbol, checkDate);
        await sleep(DELAY_MS);

        if (!ohlc) {
          console.log("❌ no data from Upstox");
          continue;
        }

        finalOHLC  = ohlc;
        trackHigh  = Math.max(trackHigh, ohlc.high);
        trackLow   = Math.min(trackLow,  ohlc.low);

        const check = checkDay(sig, ohlc);

        if (check.hit) {
          const icon = check.result === "WIN" ? "🟢 WIN " : "🔴 LOSS";
          console.log(`${icon}  exit:₹${check.exitPrice.toFixed(1)}  P&L:${check.pnlPct >= 0 ? "+" : ""}${check.pnlPct}%`);

          if (!DRY_RUN) {
            applyResolution(data, sig, {
              result: check.result, exitPrice: check.exitPrice,
              pnlPct: check.pnlPct, resolvedDate: checkDate,
              highReached: trackHigh, lowReached: trackLow, lastLTP: ohlc.close,
            });
          }

          if (check.result === "WIN") totalWin++; else totalLoss++;
          resolved = true;
          break;
        } else {
          console.log(`⚪ no hit   H:${ohlc.high.toFixed(1)} L:${ohlc.low.toFixed(1)}`);
        }
      }

      if (!resolved) {
        if (!finalOHLC) {
          console.log(`   ${sig.symbol.padEnd(15)} ❌ FAILED — Upstox returned no data`);
          totalFailed++;
          continue;
        }

        const buy    = isBuySignal(sig.signalType);
        const closeP = finalOHLC.close || sig.entry;
        const pnlPct = buy
          ? +((( closeP - sig.entry) / sig.entry) * 100).toFixed(2)
          : +((( sig.entry - closeP) / sig.entry) * 100).toFixed(2);

        console.log(`   ${sig.symbol.padEnd(15)} ⚪ EXPIRED  close:₹${closeP.toFixed(1)}  P&L:${pnlPct >= 0 ? "+" : ""}${pnlPct}%`);

        if (!DRY_RUN) {
          applyResolution(data, sig, {
            result: "EXPIRED", exitPrice: closeP, pnlPct,
            resolvedDate: checkDates[checkDates.length - 1],
            highReached: trackHigh, lowReached: trackLow, lastLTP: closeP,
          });
        }
        totalExpired++;
      }
    }
    console.log();
  }

  if (!DRY_RUN) saveData(data);

  const resolved = totalWin + totalLoss;
  const accuracy = resolved > 0 ? Math.round((totalWin / resolved) * 100) : 0;

  console.log("═".repeat(60));
  console.log(`  🟢 Win:      ${totalWin}`);
  console.log(`  🔴 Loss:     ${totalLoss}`);
  console.log(`  ⚪ Expired:  ${totalExpired}`);
  console.log(`  ❌ No data:  ${totalFailed}`);
  console.log(`  📈 Accuracy: ${accuracy}%  (${totalWin}W / ${totalLoss}L of ${resolved} resolved)`);
  if (DRY_RUN) console.log("\n  [DRY RUN] Nothing was written.");
  else         console.log(`\n  ✅ Saved → ${DATA_FILE}`);
  console.log("═".repeat(60) + "\n");
}

run().catch(err => { console.error("❌ Fatal:", err.message); process.exit(1); });