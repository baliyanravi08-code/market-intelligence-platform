"use strict";

/**
 * gannDataFetcher.js
 * Location: server/services/intelligence/gannDataFetcher.js
 *
 * FIX: added real index candle fetching for NIFTY, BANKNIFTY, SENSEX.
 *
 * Previously gannDataFetcher only fetched NSE EQ stocks (from marketCapDB).
 * Index symbols (NIFTY, BANKNIFTY, SENSEX) were never fetched, so
 * swingStore had no real swing data for them. gannIntegration fell back
 * to ±15% fake estimates for 52w high/low and swing pivots.
 *
 * Fix: fetchAndIngestAll() now calls fetchIndexCandles() first for all
 * three indices before the stock loop. Real 52w high/low and swing
 * pivots are computed from 365 days of actual daily candles — same
 * algorithm as the stock fetcher. swingStore is populated with real data
 * so gannIntegration uses genuine levels instead of ±15% guesses.
 */

const fs   = require("fs");
const path = require("path");

const { ingestSwingData } = require("./gannIntegration");
const { isMarketOpen, marketStatus } = require("./marketHours");

// ─── Config ───────────────────────────────────────────────────────────────────
const MCAP_DB_PATH  = path.join(__dirname, "../../data/marketCapDB.json");
const UPSTOX_BASE   = "https://api.upstox.com/v2";
const RATE_LIMIT_MS = 350;
const MAX_STOCKS    = 200;

// ─── Index instrument keys (for Upstox historical-candle API) ─────────────────
const INDEX_CONFIGS = [
  {
    symbol:    "NIFTY",
    instrKey:  "NSE_INDEX|Nifty 50",
    priceUnit: 10,   // ~10 Rs per trading day movement for NIFTY
  },
  {
    symbol:    "BANKNIFTY",
    instrKey:  "NSE_INDEX|Nifty Bank",
    priceUnit: 30,   // BANKNIFTY moves faster
  },
  {
    symbol:    "SENSEX",
    instrKey:  "BSE_INDEX|SENSEX",
    priceUnit: 30,
  },
  {
    symbol:    "FINNIFTY",
    instrKey:  "NSE_INDEX|Nifty Fin Service",
    priceUnit: 10,
  },
];

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

// ─── Instrument map (for EQ stocks) ──────────────────────────────────────────
let _instrumentMap = {};

function setInstrumentMap(map) {
  if (map && typeof map === "object") {
    _instrumentMap = map;
    console.log(`📐 Gann fetcher: instrument map set — ${Object.keys(map).length} symbols`);
  }
}

function getInstrumentKey(symbol) {
  const key = _instrumentMap[symbol];
  if (!key) {
    console.warn(`📐 Gann fetcher: no instrument key for ${symbol} — skipping`);
    return null;
  }
  return key;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }

/**
 * Compute 52w high/low + swing pivots from daily candles.
 * Works for both index candles and stock candles.
 */
function computeLevels(candles) {
  if (!candles || candles.length === 0) return null;

  let high52w = -Infinity, low52w = Infinity;
  let high52wDate = "", low52wDate = "";

  for (const c of candles) {
    if (c.high > high52w) { high52w = c.high; high52wDate = c.timestamp; }
    if (c.low  < low52w)  { low52w  = c.low;  low52wDate  = c.timestamp; }
  }

  // Use last 60 candles for swing detection
  const recent = candles.slice(-60);
  let swingHigh = { price: -Infinity, date: "" };
  let swingLow  = { price:  Infinity, date: "" };

  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i];
    if (
      c.high > recent[i-1].high && c.high > recent[i-2].high &&
      c.high > recent[i+1].high && c.high > recent[i+2].high
    ) {
      if (c.high > swingHigh.price) swingHigh = { price: c.high, date: c.timestamp.slice(0, 10) };
    }
    if (
      c.low < recent[i-1].low && c.low < recent[i-2].low &&
      c.low < recent[i+1].low && c.low < recent[i+2].low
    ) {
      if (c.low < swingLow.price) swingLow = { price: c.low, date: c.timestamp.slice(0, 10) };
    }
  }

  // Fallback to 52w extremes if no swing pivot found
  if (swingHigh.price === -Infinity) swingHigh = { price: high52w, date: high52wDate.slice(0, 10) };
  if (swingLow.price  ===  Infinity) swingLow  = { price: low52w,  date: low52wDate.slice(0, 10) };

  return { high52w, low52w, swingHigh, swingLow };
}

// ─── Fetch candles from Upstox (generic — works for both index and EQ) ────────
async function fetchCandles(instrKey) {
  const token = getToken();
  if (!token) throw new Error("No Upstox token available");

  const encodedKey = encodeURIComponent(instrKey);
  const toDate     = fmtDate(new Date());
  const fromDate   = fmtDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
  const url        = `${UPSTOX_BASE}/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  }

  const json = await res.json();
  const raw  = json?.data?.candles || [];
  return raw.map(([ts, o, h, l, c, v]) => ({
    timestamp: ts, open: o, high: h, low: l, close: c, volume: v,
  }));
}

// ─── NEW: Fetch and ingest real index candles ─────────────────────────────────
/**
 * Fetches 365 days of daily candles for NIFTY, BANKNIFTY, SENSEX, FINNIFTY
 * and ingests real 52w high/low + swing pivots into swingStore via ingestSwingData().
 *
 * This replaces the ±15% fake estimates that gannIntegration was using
 * for index symbols when swingStore had no data for them.
 */
async function fetchAndIngestIndexes() {
  console.log("📐 Gann fetcher: fetching real index candles (NIFTY/BANKNIFTY/SENSEX)…");
  let ok = 0, fail = 0;

  for (const cfg of INDEX_CONFIGS) {
    try {
      const candles = await fetchCandles(cfg.instrKey);
      if (candles.length < 10) throw new Error("too few candles");

      const levels = computeLevels(candles);
      if (!levels) throw new Error("could not compute levels");

      // Last close as LTP proxy (real LTP comes from upstoxStream ticks)
      const lastClose = candles[candles.length - 1]?.close || 0;

      ingestSwingData({
        symbol:    cfg.symbol,
        ltp:       lastClose,
        high52w:   levels.high52w,
        low52w:    levels.low52w,
        swingHigh: levels.swingHigh,
        swingLow:  levels.swingLow,
        priceUnit: cfg.priceUnit,
      });

      ok++;
      console.log(
        `📐 Gann index [${cfg.symbol}]: ` +
        `52wH=${levels.high52w} 52wL=${levels.low52w} ` +
        `SwingH=${levels.swingHigh.price}(${levels.swingHigh.date}) ` +
        `SwingL=${levels.swingLow.price}(${levels.swingLow.date})`
      );

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      fail++;
      console.warn(`📐 Gann fetcher: index ${cfg.symbol} failed — ${err.message}`);
    }
  }

  console.log(`📐 Gann fetcher: index fetch complete — ${ok} ok, ${fail} failed`);
}

// ─── Main fetch loop (EQ stocks) ──────────────────────────────────────────────
async function fetchAndIngestAll() {
  // ── MARKET HOURS GUARD ────────────────────────────────────────────────────
  if (!isMarketOpen()) {
    const status = marketStatus();
    console.log(`📐 Gann fetcher: market is ${status} — skipping fetch, preserving last values`);
    return;
  }

  // ── Fetch real index candles FIRST ───────────────────────────────────────
  // This ensures NIFTY/BANKNIFTY/SENSEX have real swing data before
  // the stock loop starts (stock loop can take several minutes).
  await fetchAndIngestIndexes();

  // ── Instrument map check ──────────────────────────────────────────────────
  const mapSize = Object.keys(_instrumentMap).length;
  if (mapSize === 0) {
    console.warn("📐 Gann fetcher: instrument map is EMPTY — skipping stock fetch");
    return;
  }
  console.log(`📐 Gann fetcher: instrument map has ${mapSize} symbols — starting stock pull`);

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

  console.log(`📐 Gann fetcher: pulling data for ${entries.length} NSE stocks…`);

  let ok = 0, fail = 0;

  for (const entry of entries) {
    if (!isMarketOpen()) {
      console.log(`📐 Gann fetcher: market closed mid-run — stopping at ${ok} stocks`);
      break;
    }

    const { symbol, lastPrice, name } = entry;
    try {
      const instrKey = getInstrumentKey(symbol);
      if (!instrKey) { fail++; continue; }

      const candles = await fetchCandles(instrKey);
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
      if (ok % 20 === 0) console.log(`📐 Gann fetcher: ${ok}/${entries.length} stocks done…`);
    } catch (err) {
      fail++;
      if (fail <= 10) {
        console.warn(`📐 Gann fetcher: skip ${symbol} (${name || "?"}) — ${err.message}`);
      }
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`📐 Gann fetcher: complete — ${ok} stocks ingested, ${fail} skipped`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
/**
 * startGannDataFetcher()
 *
 * - If market is open NOW → fetch indexes immediately, then stocks.
 * - If market is closed → skip, schedule 09:00 IST daily refresh.
 * - Index candles are fetched every day at open (real swing levels).
 * - Stock candles fetched in the same loop after indexes.
 */
function startGannDataFetcher() {
  if (isMarketOpen()) {
    console.log(`📐 Gann fetcher: market is open — starting initial data pull`);
    fetchAndIngestAll().catch(e =>
      console.error("📐 Gann fetcher initial run error:", e.message)
    );
  } else {
    console.log(`📐 Gann fetcher: market is ${marketStatus()} — skipping initial fetch`);

    // Even outside market hours, fetch index candles once for yesterday's
    // swing data so gannIntegration has real levels (not ±15% estimates).
    // This runs without the market hours guard.
    fetchAndIngestIndexes().catch(e =>
      console.warn("📐 Gann fetcher: off-hours index fetch failed —", e.message)
    );
  }

  scheduleDailyRefresh();
}

function scheduleDailyRefresh() {
  const now     = new Date();
  const nextRun = new Date();

  // Target 03:30 UTC = 09:00 IST
  nextRun.setUTCHours(3, 30, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

  // Skip weekends
  const nextDay = nextRun.getUTCDay();
  if (nextDay === 0) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  if (nextDay === 6) nextRun.setUTCDate(nextRun.getUTCDate() + 2);

  const msUntil   = nextRun - now;
  const minsUntil = Math.round(msUntil / 60000);
  console.log(`📐 Gann fetcher: next daily refresh in ${minsUntil} min (${nextRun.toISOString()})`);

  setTimeout(() => {
    if (isMarketOpen()) {
      fetchAndIngestAll()
        .catch(e => console.error("📐 Gann fetcher daily error:", e.message))
        .finally(() => scheduleDailyRefresh());
    } else {
      console.log(`📐 Gann fetcher: daily trigger fired but market is ${marketStatus()} — skipping`);
      scheduleDailyRefresh();
    }
  }, msUntil);
}

module.exports = { startGannDataFetcher, fetchAndIngestAll, setInstrumentMap };