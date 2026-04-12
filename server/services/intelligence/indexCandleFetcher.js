"use strict";

/**
 * indexCandleFetcher.js
 * Location: server/services/intelligence/indexCandleFetcher.js
 *
 * PURPOSE:
 *   Fetches real daily close prices for NIFTY 50 and BANK NIFTY from Upstox
 *   so optionsIntegration.js can compute genuine HV20, HV60, and VRP.
 *
 * FIXES IN THIS VERSION:
 *
 * FIX TOKEN-1 — Token not available at startup time:
 *   Root cause: startIndexCandleFetcher() is called inside loadInstrumentMaster()
 *   .finally() block, but startStreamer() (which sets currentToken in upstoxStream)
 *   is called 2000ms LATER via setTimeout. So at the moment fetchAll() runs,
 *   upstoxStream.getAccessToken() returns null and the fetch fails silently.
 *   Fix A: added setToken(t) so server.js can inject the token directly before
 *           calling startIndexCandleFetcher().
 *   Fix B: getToken() now tries _tokenOverride first, then upstoxStream, then env.
 *   Fix C: startIndexCandleFetcher() now retries fetchAll() after 4s and 10s if
 *           the first attempt fails due to missing token — covers the window where
 *           upstoxStream hasn't connected yet.
 *
 * FIX RETRY-1 — No retry on transient fetch failure:
 *   fetchAll() previously logged a warning and moved on if one symbol failed.
 *   On startup the token may not be ready yet for the first call.
 *   Fix: added retryFetchAll() which retries up to 3 times with exponential backoff
 *   (4s, 8s, 16s). Once either symbol succeeds we have HV data for that symbol.
 *
 * ORIGINAL DESIGN (preserved):
 *   - getIndexCloses(symbol) returns oldest-first daily closes for HV calc
 *   - scheduleDailyRefresh() fires at 09:05 IST every weekday
 *   - Does NOT wipe existing data on failure (keeps last good fetch)
 */

const UPSTOX_BASE   = "https://api.upstox.com/v2";
const RATE_LIMIT_MS = 500;

const INDEX_INSTRUMENT_KEYS = {
  NIFTY:     "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  NIFTY50:   "NSE_INDEX|Nifty 50",
};

// In-memory store: symbol → number[] of daily closes (oldest → newest)
const closesStore = {};

// ── FIX TOKEN-1A: module-level token override set by server.js ────────────────
let _tokenOverride = null;

/**
 * setToken(token)
 * Call from server.js before startIndexCandleFetcher() to guarantee
 * the token is available on first fetch:
 *
 *   const icf = require('./services/intelligence/indexCandleFetcher');
 *   icf.setToken(upstoxAccessToken);
 *   icf.startIndexCandleFetcher();
 */
function setToken(token) {
  if (token) {
    _tokenOverride = token;
    console.log("📈 IndexCandleFetcher: token set via setToken()");
  }
}

// ── Token getter ──────────────────────────────────────────────────────────────
let _getToken;
try {
  const stream = require("../upstoxStream");
  _getToken = stream.getAccessToken || stream.getUpstoxToken;
} catch (_) {}

// FIX TOKEN-1B: priority order — override → upstoxStream → env
function getToken() {
  if (_tokenOverride) return _tokenOverride;
  if (typeof _getToken === "function") {
    const t = _getToken();
    if (t) return t;
  }
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }

// ── Fetch daily candles for one index ────────────────────────────────────────
async function fetchIndexCandles(symbol) {
  const token = getToken();
  if (!token) throw new Error("No Upstox token available");

  const instrKey = INDEX_INSTRUMENT_KEYS[symbol.toUpperCase()];
  if (!instrKey) throw new Error(`Unknown index symbol: ${symbol}`);

  const encodedKey = encodeURIComponent(instrKey);
  const toDate     = fmtDate(new Date());
  const fromDate   = fmtDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  const url        = `${UPSTOX_BASE}/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${symbol}: ${text.slice(0, 120)}`);
  }

  const json = await res.json();
  const raw  = json?.data?.candles || [];
  if (raw.length === 0) throw new Error(`Empty candle response for ${symbol}`);

  // Upstox returns newest-first — reverse to oldest-first for HV calc
  const closes = raw
    .map(c => parseFloat(c[4]))
    .filter(c => c > 0)
    .reverse();

  return closes;
}

// ── Fetch all tracked indices ─────────────────────────────────────────────────
async function fetchAll() {
  const symbols = ["NIFTY", "BANKNIFTY"];
  let anySuccess = false;

  for (const sym of symbols) {
    try {
      const closes = await fetchIndexCandles(sym);
      closesStore[sym] = closes;
      console.log(`📈 IndexCandleFetcher: ${sym} — ${closes.length} daily closes loaded (HV ready)`);
      anySuccess = true;
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.warn(`⚠️ IndexCandleFetcher: ${sym} failed — ${err.message}`);
      // Don't wipe existing data on failure — preserve last good fetch
    }
  }

  return anySuccess;
}

// ── FIX RETRY-1: retry fetchAll() with backoff if token not ready yet ─────────
async function retryFetchAll(attempts = 3, baseDelayMs = 4000) {
  for (let i = 0; i < attempts; i++) {
    const success = await fetchAll();
    if (success) return;

    const delay = baseDelayMs * Math.pow(2, i); // 4s, 8s, 16s
    console.log(`📈 IndexCandleFetcher: retry ${i + 1}/${attempts} in ${delay / 1000}s…`);
    await sleep(delay);
  }
  console.warn("📈 IndexCandleFetcher: all retry attempts exhausted — HV will be null until next daily refresh");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * getIndexCloses(symbol) → number[]
 *
 * Returns daily close prices oldest-first for HV calculation.
 * Returns [] if not yet fetched.
 *
 * symbol: "NIFTY", "BANKNIFTY", "NIFTY50", "NIFTY 50", "BANK NIFTY" (all handled)
 */
function getIndexCloses(symbol) {
  if (!symbol) return [];
  const sym = symbol.toUpperCase().replace(/\s+/g, "");
  if (sym === "NIFTY50")   return closesStore["NIFTY"]     || [];
  if (sym === "BANKNIFTY") return closesStore["BANKNIFTY"] || [];
  if (sym === "NIFTY")     return closesStore["NIFTY"]     || [];
  // Handle "BANKNIFTY" variants
  if (sym.includes("BANK")) return closesStore["BANKNIFTY"] || [];
  return closesStore[sym] || [];
}

/**
 * startIndexCandleFetcher()
 *
 * Call from server.js AFTER setting token via setToken():
 *
 *   const icf = require('./services/intelligence/indexCandleFetcher');
 *   icf.setToken(upstoxAccessToken);   // ← inject token first
 *   icf.startIndexCandleFetcher();     // ← then start
 *
 * FIX TOKEN-1C: uses retryFetchAll() so transient token-not-ready
 * failures are retried automatically (4s → 8s → 16s backoff).
 */
function startIndexCandleFetcher() {
  console.log("📈 IndexCandleFetcher: starting…");

  // FIX TOKEN-1C: retry on failure to handle startup token race
  retryFetchAll(3, 4000).catch(e =>
    console.error("📈 IndexCandleFetcher startup error:", e.message)
  );

  scheduleDailyRefresh();
}

function scheduleDailyRefresh() {
  const now     = new Date();
  const nextRun = new Date();

  // 09:05 IST = 03:35 UTC
  nextRun.setUTCHours(3, 35, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

  // Skip to Monday if next run lands on weekend
  const day = nextRun.getUTCDay();
  if (day === 0) nextRun.setUTCDate(nextRun.getUTCDate() + 1); // Sun → Mon
  if (day === 6) nextRun.setUTCDate(nextRun.getUTCDate() + 2); // Sat → Mon

  const msUntil = nextRun - now;
  console.log(`📈 IndexCandleFetcher: next daily refresh in ${Math.round(msUntil / 60000)} min`);

  setTimeout(() => {
    fetchAll()
      .catch(e => console.error("📈 IndexCandleFetcher daily error:", e.message))
      .finally(() => scheduleDailyRefresh());
  }, msUntil);
}

module.exports = {
  startIndexCandleFetcher,
  getIndexCloses,
  fetchAll,
  setToken,        // ← NEW: call before startIndexCandleFetcher()
};