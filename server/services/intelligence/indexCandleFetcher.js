"use strict";

/**
 * indexCandleFetcher.js
 * Location: server/services/intelligence/indexCandleFetcher.js
 *
 * PURPOSE:
 *   Fetches real daily close prices for NIFTY 50 and BANK NIFTY from Upstox
 *   so optionsIntegration.js can compute genuine HV20, HV60, and VRP.
 *
 * WHY THIS FILE EXISTS:
 *   optionsIntegration.js was using a fake closesProxy:
 *     ivHist.map(iv => spotPrice * (1 - iv))
 *   This is mathematically wrong — HV needs real sequential daily closes.
 *   The fake proxy produced HV = null or garbage → VRP = null → all show "—".
 *
 * USAGE:
 *   Called from optionsIntegration.js on startup + daily refresh.
 *   Exposes getIndexCloses(symbol) → number[] of daily closes (oldest first).
 *
 * WIRING IN server.js (add after loadInstrumentMaster resolves):
 *   const { startIndexCandleFetcher } = require('./services/intelligence/indexCandleFetcher');
 *   startIndexCandleFetcher();
 */

const UPSTOX_BASE   = "https://api.upstox.com/v2";
const RATE_LIMIT_MS = 500;

// Upstox instrument keys for indices (these are fixed, not from instrument master)
const INDEX_INSTRUMENT_KEYS = {
  NIFTY:     "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  NIFTY50:   "NSE_INDEX|Nifty 50",   // alias
};

// In-memory store: symbol → number[] of daily closes (oldest → newest)
const closesStore = {};

// ─── Token getter (same pattern as gannDataFetcher.js) ────────────────────────
let _getToken;
try {
  const stream = require("../upstoxStream");
  _getToken = stream.getAccessToken || stream.getUpstoxToken;
} catch (_) {}

function getToken() {
  if (typeof _getToken === "function") return _getToken();
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }

// ─── Fetch daily candles for one index ───────────────────────────────────────
async function fetchIndexCandles(symbol) {
  const token = getToken();
  if (!token) throw new Error("No Upstox token available");

  const instrKey = INDEX_INSTRUMENT_KEYS[symbol.toUpperCase()];
  if (!instrKey) throw new Error(`Unknown index symbol: ${symbol}`);

  const encodedKey = encodeURIComponent(instrKey);
  const toDate     = fmtDate(new Date());
  // 252 trading days ≈ 365 calendar days — fetch 1 year of history
  const fromDate   = fmtDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

  const url = `${UPSTOX_BASE}/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${symbol}: ${text.slice(0, 120)}`);
  }

  const json = await res.json();
  // Upstox returns candles newest-first: [[ts, o, h, l, c, v], ...]
  const raw  = json?.data?.candles || [];

  if (raw.length === 0) throw new Error(`Empty candle response for ${symbol}`);

  // Extract close prices, reverse to oldest-first for HV calculation
  const closes = raw
    .map(c => parseFloat(c[4]))          // index 4 = close
    .filter(c => c > 0)
    .reverse();                           // oldest → newest

  return closes;
}

// ─── Fetch and store closes for all tracked indices ───────────────────────────
async function fetchAll() {
  const symbols = ["NIFTY", "BANKNIFTY"];

  for (const sym of symbols) {
    try {
      const closes = await fetchIndexCandles(sym);
      closesStore[sym] = closes;
      console.log(`📈 IndexCandleFetcher: ${sym} — ${closes.length} daily closes loaded (HV ready)`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.warn(`⚠️ IndexCandleFetcher: ${sym} failed — ${err.message}`);
      // Don't wipe existing data on failure — keep last good fetch
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getIndexCloses(symbol) → number[]
 *
 * Returns daily close prices oldest-first for HV calculation.
 * Returns [] if not yet fetched (HV will be null — same as before, but
 * this will resolve within 30s of server start).
 *
 * symbol: "NIFTY", "BANKNIFTY", "NIFTY50" (case-insensitive)
 */
function getIndexCloses(symbol) {
  if (!symbol) return [];
  const sym = symbol.toUpperCase().replace(/\s+/g, "");
  // Handle common aliases
  if (sym === "NIFTY50") return closesStore["NIFTY"] || [];
  return closesStore[sym] || [];
}

/**
 * startIndexCandleFetcher()
 *
 * Call this from server.js after the Upstox token is available.
 * Fetches immediately then refreshes daily at 09:05 IST (after market open).
 */
function startIndexCandleFetcher() {
  // Fetch immediately on startup
  fetchAll().catch(e =>
    console.error("📈 IndexCandleFetcher startup error:", e.message)
  );

  // Refresh daily at 09:05 IST (03:35 UTC) — after market opens and first candle forms
  function scheduleDailyRefresh() {
    const now     = new Date();
    const nextRun = new Date();
    nextRun.setUTCHours(3, 35, 0, 0);
    if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

    const msUntil = nextRun - now;
    console.log(`📈 IndexCandleFetcher: next daily refresh in ${Math.round(msUntil / 60000)} min`);

    setTimeout(() => {
      fetchAll()
        .catch(e => console.error("📈 IndexCandleFetcher daily error:", e.message))
        .finally(() => scheduleDailyRefresh());
    }, msUntil);
  }

  scheduleDailyRefresh();
}

module.exports = { startIndexCandleFetcher, getIndexCloses, fetchAll };