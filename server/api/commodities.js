/**
 * api/commodities.js
 * Server-side Gold + Silver price fetcher.
 * Called by server.js at GET /api/commodities
 * Uses metals.live (free, no key) with stooq.com CSV fallback.
 * 60-second server-side cache — browser never hits external APIs directly.
 */

const axios = require("axios");

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

async function fetchMetalsLive() {
  // metals.live — free, no API key, returns XAU/XAG spot in USD
  const res = await axios.get("https://metals.live/api/spot", {
    timeout: 8000,
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
  });
  const data = res.data;
  // Response is array: [{ metal: "gold", price: 2300.5, change: 12.3, change_percent: 0.54 }, ...]
  if (!Array.isArray(data)) throw new Error("Unexpected metals.live response");
  const gold   = data.find(m => m.metal === "gold");
  const silver = data.find(m => m.metal === "silver");
  if (!gold || !silver) throw new Error("Gold/Silver not in metals.live response");
  return {
    GOLD:   { price: gold.price,   change24h: gold.change_percent   || 0 },
    SILVER: { price: silver.price, change24h: silver.change_percent || 0 }
  };
}

async function fetchStooqFallback() {
  // stooq.com CSV fallback — no key needed
  const [goldRes, silverRes] = await Promise.all([
    axios.get("https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv", { timeout: 8000 }),
    axios.get("https://stooq.com/q/l/?s=xagusd&f=sd2t2ohlcv&h&e=csv", { timeout: 8000 })
  ]);
  const parseStooq = (csv) => {
    const lines = csv.trim().split("\n");
    if (lines.length < 2) throw new Error("Bad stooq CSV");
    const cols = lines[1].split(",");
    // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = parseFloat(cols[6]);
    const open  = parseFloat(cols[3]);
    if (!close || isNaN(close)) throw new Error("Bad stooq price");
    const changePct = open > 0 ? ((close - open) / open) * 100 : 0;
    return { price: close, change24h: parseFloat(changePct.toFixed(2)) };
  };
  return {
    GOLD:   parseStooq(goldRes.data),
    SILVER: parseStooq(silverRes.data)
  };
}

async function getCommodities() {
  // Return cache if fresh
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  let result = null;

  // Try metals.live first
  try {
    result = await fetchMetalsLive();
    console.log("✅ Commodities: metals.live OK — Gold $" + result.GOLD.price);
  } catch (e) {
    console.warn("⚠️ metals.live failed:", e.message, "— trying stooq fallback");
  }

  // Fallback to stooq
  if (!result) {
    try {
      result = await fetchStooqFallback();
      console.log("✅ Commodities: stooq fallback OK — Gold $" + result.GOLD.price);
    } catch (e) {
      console.warn("⚠️ stooq fallback also failed:", e.message);
    }
  }

  if (result) {
    cache     = result;
    cacheTime = Date.now();
  }

  return result;
}

// Express route handler — add to server.js:
//   const { commoditiesRoute } = require("./api/commodities");
//   app.get("/api/commodities", commoditiesRoute);
async function commoditiesRoute(req, res) {
  try {
    const data = await getCommodities();
    if (!data) {
      return res.status(503).json({ error: "Commodity prices unavailable" });
    }
    res.json(data);
  } catch (e) {
    console.error("Commodities route error:", e.message);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { commoditiesRoute, getCommodities };