"use strict";

/**
 * gannDataFetcher.js
 * Location: server/services/intelligence/gannDataFetcher.js
 *
 * Reads marketCapDB.json → finds every entry with a symbol field (NSE stocks)
 * → fetches 1-year daily candles from Upstox → computes 52w high/low + swing pivots
 * → feeds ingestSwingData() so the Gann engine has real levels for every stock.
 *
 * Runs once at startup, then refreshes daily at 09:00 AM IST.
 * Rate-limited to 3 requests/sec to stay within Upstox free-tier limits.
 */

const fs   = require("fs");
const path = require("path");

const { ingestSwingData } = require("./gannIntegration");

// ─── Config ───────────────────────────────────────────────────────────────────

const MCAP_DB_PATH  = path.join(__dirname, "../../data/marketCapDB.json");
const UPSTOX_BASE   = "https://api.upstox.com/v2";
const RATE_LIMIT_MS = 350;  // ~3 req/sec — safe for Upstox
const MAX_STOCKS    = 200;  // cap so startup isn't slow

// ─── Token getter ─────────────────────────────────────────────────────────────

let _getToken;
try {
  const stream = require("../upstoxStream");
  _getToken = stream.getAccessToken || stream.getUpstoxToken;
} catch (_) {}

function getToken() {
  if (typeof _getToken === "function") return _getToken();
  return process.env.UPSTOX_ANALYTICS_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || "";
}

// ─── Instrument map getter ────────────────────────────────────────────────────
// Uses the real instrument map from server.js (symbol → NSE_EQ|ISIN key)
// Falls back to guessing NSE_EQ|SYMBOL if map not available yet

let _instrumentMap = {};

function setInstrumentMap(map) {
  if (map && typeof map === "object") _instrumentMap = map;
}

function getInstrumentKey(symbol) {
  return _instrumentMap[symbol] || `NSE_EQ|${symbol}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Format Date → "YYYY-MM-DD" */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Returns { high52w, low52w, swingHigh, swingLow } from array of candles.
 * swingHigh/swingLow = most significant pivot in last 60 candles (≈3 months).
 */
function computeLevels(candles) {
  if (!candles || candles.length === 0) return null;

  let high52w = -Infinity, low52w = Infinity;
  let high52wDate = "", low52wDate = "";

  for (const c of candles) {
    if (c.high > high52w) { high52w = c.high; high52wDate = c.timestamp; }
    if (c.low  < low52w)  { low52w  = c.low;  low52wDate  = c.timestamp; }
  }

  const recent = candles.slice(-60);
  let swingHigh = { price: -Infinity, date: "" };
  let swingLow  = { price:  Infinity, date: "" };

  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    if (c.high > recent[i-1].high && c.high > recent[i-2].high &&
        c.high > recent[i+1].high && c.high > recent[i+2].high) {
      if (c.high > swingHigh.price) {
        swingHigh = { price: c.high, date: c.timestamp.slice(0, 10) };
      }
    }
    if (c.low < recent[i-1].low && c.low < recent[i-2].low &&
        c.low < recent[i+1].low && c.low < recent[i+2].low) {
      if (c.low < swingLow.price) {
        swingLow = { price: c.low, date: c.timestamp.slice(0, 10) };
      }
    }
  }

  if (swingHigh.price === -Infinity) swingHigh = { price: high52w, date: high52wDate.slice(0, 10) };
  if (swingLow.price  ===  Infinity) swingLow  = { price: low52w,  date: low52wDate.slice(0, 10)  };

  return { high52w, low52w, swingHigh, swingLow };
}

// ─── Upstox historical candles ────────────────────────────────────────────────

async function fetchCandles(symbol) {
  const token = getToken();
  if (!token) throw new Error("No Upstox token available");

  const instrKey = getInstrumentKey(symbol);
  if (!instrKey) throw new Error(`No instrument key for ${symbol}`);

  const encodedKey = encodeURIComponent(instrKey);
  const toDate     = fmtDate(new Date());
  const fromDate   = fmtDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));

  const url = `${UPSTOX_BASE}/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:        "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${symbol}: ${text.slice(0, 120)}`);
  }

  const json = await res.json();
  const raw  = json?.data?.candles || [];

  return raw.map(([ts, o, h, l, c, v]) => ({
    timestamp: ts,
    open: o, high: h, low: l, close: c, volume: v,
  }));
}

// ─── Main fetch loop ──────────────────────────────────────────────────────────

async function fetchAndIngestAll() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(MCAP_DB_PATH, "utf8"));
  } catch (e) {
    console.error("📐 Gann fetcher: could not read marketCapDB.json —", e.message);
    return;
  }

  const entries = Object.values(db)
    .filter(e => e.symbol && e.lastPrice > 0)
    .slice(0, MAX_STOCKS);

  console.log(`📐 Gann fetcher: starting data pull for ${entries.length} NSE stocks…`);

  // Log instrument map status
  if (typeof _getInstrumentMap === "function") {
    const map = _getInstrumentMap();
    console.log(`📐 Gann fetcher: instrument map has ${Object.keys(map).length} symbols`);
  } else {
    console.warn("📐 Gann fetcher: instrument map not available — using fallback keys");
  }

  let ok = 0, fail = 0;

  for (const entry of entries) {
    const { symbol, lastPrice, name } = entry;

    try {
      const candles = await fetchCandles(symbol);
      if (candles.length < 10) throw new Error("too few candles");

      const levels = computeLevels(candles);
      if (!levels) throw new Error("could not compute levels");

      ingestSwingData({
        symbol,
        ltp:       lastPrice,
        high52w:   levels.high52w,
        low52w:    levels.low52w,
        swingHigh: levels.swingHigh,
        swingLow:  levels.swingLow,
      });

      ok++;
      if (ok % 20 === 0) {
        console.log(`📐 Gann fetcher: ${ok}/${entries.length} done…`);
      }
    } catch (err) {
      fail++;
      if (fail <= 5) {
        console.warn(`📐 Gann fetcher: skip ${symbol} (${name}) — ${err.message}`);
      }
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`📐 Gann fetcher: complete — ${ok} stocks ingested, ${fail} skipped`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

function startGannDataFetcher() {
  // Defer 15s so instrument master has time to load first
  setTimeout(() => fetchAndIngestAll().catch(e =>
    console.error("📐 Gann fetcher error:", e.message)
  ), 15000);

  function scheduleDailyRefresh() {
    const now     = new Date();
    const nextRun = new Date();
    nextRun.setUTCHours(3, 30, 0, 0);
    if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

    const msUntil = nextRun - now;
    console.log(`📐 Gann fetcher: next daily refresh in ${Math.round(msUntil / 60000)} min`);

    setTimeout(() => {
      fetchAndIngestAll()
        .catch(e => console.error("📐 Gann fetcher daily error:", e.message))
        .finally(() => scheduleDailyRefresh());
    }, msUntil);
  }

  scheduleDailyRefresh();
}

module.exports = { startGannDataFetcher, fetchAndIngestAll, setInstrumentMap };