"use strict";

/**
 * gannDataFetcher.js
 * Location: server/services/intelligence/gannDataFetcher.js
 *
 * MARKET HOURS UPDATE:
 *   - fetchAndIngestAll() only runs Mon–Fri 09:00–15:45 IST.
 *   - Outside market hours: skips all HTTP calls, zero data usage.
 *   - Last LTP is preserved in swingStore / gannIntegration cache,
 *     so the frontend still shows last known Gann values.
 *   - Daily scheduler fires at 09:00 IST (not 09:30) so first fetch
 *     lands before significant market movement.
 *   - No polling loop during closed hours — completely silent.
 */

const fs   = require("fs");
const path = require("path");

const { ingestSwingData } = require("./gannIntegration");
const { isMarketOpen, marketStatus } = require("./marketHours");

// ─── Config ───────────────────────────────────────────────────────────────────
const MCAP_DB_PATH  = path.join(__dirname, "../../data/marketCapDB.json");
const UPSTOX_BASE   = "https://api.upstox.com/v2";
const RATE_LIMIT_MS = 350;   // ~3 req/sec — safe for Upstox free tier
const MAX_STOCKS    = 200;

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

// ─── Instrument map ───────────────────────────────────────────────────────────
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
 * Compute 52w high/low + swing pivots from candles.
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

  if (swingHigh.price === -Infinity) swingHigh = { price: high52w, date: high52wDate.slice(0, 10) };
  if (swingLow.price  ===  Infinity) swingLow  = { price: low52w,  date: low52wDate.slice(0, 10) };

  return { high52w, low52w, swingHigh, swingLow };
}

// ─── Upstox candle fetch ──────────────────────────────────────────────────────
async function fetchCandles(symbol) {
  const token = getToken();
  if (!token) throw new Error("No Upstox token available");

  const instrKey = getInstrumentKey(symbol);
  if (!instrKey) throw new Error(`No instrument key for ${symbol} — skipped`);

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
  return raw.map(([ts, o, h, l, c, v]) => ({
    timestamp: ts, open: o, high: h, low: l, close: c, volume: v,
  }));
}

// ─── Main fetch loop ──────────────────────────────────────────────────────────
async function fetchAndIngestAll() {
  // ── MARKET HOURS GUARD ────────────────────────────────────────────────────
  // Only fetch during Mon–Fri 09:00–15:45 IST. Outside these hours we do
  // nothing — the frontend shows the last cached Gann values with a
  // "Last known price" indicator. Zero data usage when market is closed.
  if (!isMarketOpen()) {
    const status = marketStatus();
    console.log(`📐 Gann fetcher: market is ${status} — skipping fetch, preserving last values`);
    return;
  }

  // ── Instrument map check ──────────────────────────────────────────────────
  const mapSize = Object.keys(_instrumentMap).length;
  if (mapSize === 0) {
    console.warn("📐 Gann fetcher: instrument map is EMPTY — all fetches will fail.");
  } else {
    console.log(`📐 Gann fetcher: instrument map has ${mapSize} symbols — starting data pull`);
  }

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
    // Re-check market hours on each iteration — stop mid-loop if market closes
    if (!isMarketOpen()) {
      console.log(`📐 Gann fetcher: market closed mid-run — stopping at ${ok} stocks`);
      break;
    }

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
      if (ok % 20 === 0) console.log(`📐 Gann fetcher: ${ok}/${entries.length} done…`);
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
 * Starts the Gann data fetcher.
 *
 * Behaviour:
 *   - If market is open NOW → run immediately (server restarted during hours).
 *   - If market is closed → skip initial run, schedule only the 09:00 IST daily refresh.
 *   - Daily refresh fires every Mon–Fri at 09:00 IST (03:30 UTC).
 *   - After 15:45 IST the fetcher goes completely silent until next morning.
 *   - Zero HTTP calls outside market hours.
 */
function startGannDataFetcher() {
  // Only run immediately if market is actually open right now
  if (isMarketOpen()) {
    console.log(`📐 Gann fetcher: market is open — starting initial data pull`);
    fetchAndIngestAll().catch(e =>
      console.error("📐 Gann fetcher initial run error:", e.message)
    );
  } else {
    console.log(`📐 Gann fetcher: market is ${marketStatus()} — skipping initial fetch`);
  }

  // Schedule daily refresh at 09:00 IST (03:30 UTC) every weekday
  scheduleDailyRefresh();
}

function scheduleDailyRefresh() {
  const now     = new Date();
  const nextRun = new Date();

  // Target 03:30 UTC = 09:00 IST
  nextRun.setUTCHours(3, 30, 0, 0);

  // If 09:00 IST already passed today, schedule for tomorrow
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  // Skip to Monday if next run lands on weekend
  const nextDay = nextRun.getUTCDay();
  if (nextDay === 0) nextRun.setUTCDate(nextRun.getUTCDate() + 1); // Sun → Mon
  if (nextDay === 6) nextRun.setUTCDate(nextRun.getUTCDate() + 2); // Sat → Mon

  const msUntil = nextRun - now;
  const minsUntil = Math.round(msUntil / 60000);
  console.log(`📐 Gann fetcher: next daily refresh in ${minsUntil} min (${nextRun.toISOString()})`);

  setTimeout(() => {
    // Double-check it's actually a market day before fetching
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