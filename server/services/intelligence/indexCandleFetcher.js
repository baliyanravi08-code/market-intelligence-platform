"use strict";

/**
 * indexCandleFetcher.js
 * Location: server/services/intelligence/indexCandleFetcher.js
 *
 * MEMORY FIX v2:
 *  1. closesStore trimmed to last 120 days (was unlimited 365-day array)
 *     HV20 needs 20 bars, HV60 needs 60 — 120 is more than enough
 *     Old: 365 floats × 2 symbols — minor but cleaned up
 *  2. getDebugInfo() added — lets /api/debug/hv show cache state
 *
 * ORIGINAL FIXES PRESERVED:
 *  FIX TOKEN-1 — Token not available at startup time (setToken + retry)
 *  FIX RETRY-1 — Retry fetchAll() with exponential backoff
 */

const UPSTOX_BASE    = "https://api.upstox.com/v2";
const RATE_LIMIT_MS  = 500;
const MAX_CLOSES     = 120;   // FIX: only keep last 120 daily closes (HV60 needs 60)

const INDEX_INSTRUMENT_KEYS = {
  NIFTY:     "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  NIFTY50:   "NSE_INDEX|Nifty 50",
};

// In-memory store: symbol → number[] of daily closes (oldest → newest)
const closesStore = {};

// ── Token override set by server.js ───────────────────────────────────────────
let _tokenOverride = null;

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

  // FIX: only fetch last 130 days instead of 365 — plenty for HV60
  const fromDate   = fmtDate(new Date(Date.now() - 130 * 24 * 60 * 60 * 1000));
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
    .reverse()
    .slice(-MAX_CLOSES);   // FIX: trim to MAX_CLOSES

  return closes;
}

// ── Fetch all tracked indices ─────────────────────────────────────────────────
async function fetchAll() {
  const symbols  = ["NIFTY", "BANKNIFTY"];
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

// ── Retry fetchAll() with backoff if token not ready yet ──────────────────────
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

function getIndexCloses(symbol) {
  if (!symbol) return [];
  const sym = symbol.toUpperCase().replace(/\s+/g, "");
  if (sym === "NIFTY50")   return closesStore["NIFTY"]     || [];
  if (sym === "BANKNIFTY") return closesStore["BANKNIFTY"] || [];
  if (sym === "NIFTY")     return closesStore["NIFTY"]     || [];
  if (sym.includes("BANK")) return closesStore["BANKNIFTY"] || [];
  return closesStore[sym] || [];
}

function getDebugInfo() {
  return {
    nifty:     { closes: (closesStore["NIFTY"]     || []).length },
    banknifty: { closes: (closesStore["BANKNIFTY"] || []).length },
    tokenSet:  !!(_tokenOverride),
  };
}

function startIndexCandleFetcher() {
  console.log("📈 IndexCandleFetcher: starting…");
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
  setToken,
  getDebugInfo,
};