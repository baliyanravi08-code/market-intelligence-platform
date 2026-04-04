/**
 * ADD THIS TO YOUR server.js / routes
 * GET /api/commodities
 * Fetches Gold + Silver spot prices server-side (no CORS issues)
 * Uses metals.live free API — no key required
 * Fallback: stooq.com (free, reliable, no key)
 */

const axios = require("axios");

let commodityCache = {
  GOLD:   { price: null, change24h: null, fetchedAt: 0 },
  SILVER: { price: null, change24h: null, fetchedAt: 0 },
};

const CACHE_TTL = 60 * 1000; // 60 seconds

async function fetchCommodities() {
  const now = Date.now();
  if (
    commodityCache.GOLD.price !== null &&
    now - commodityCache.GOLD.fetchedAt < CACHE_TTL
  ) {
    return commodityCache;
  }

  // ── Primary: metals.live (free, no key, real spot prices) ────────────────
  try {
    const res = await axios.get("https://api.metals.live/v1/spot", {
      timeout: 8000,
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
    });
    // Response: [{ gold: 3123.45, silver: 34.12, platinum: ... }]
    const data = Array.isArray(res.data) ? res.data[0] : res.data;
    if (data?.gold) {
      commodityCache.GOLD = {
        price:     parseFloat(data.gold),
        change24h: data.gold_change_pct || 0,
        fetchedAt: now
      };
    }
    if (data?.silver) {
      commodityCache.SILVER = {
        price:     parseFloat(data.silver),
        change24h: data.silver_change_pct || 0,
        fetchedAt: now
      };
    }
    if (data?.gold && data?.silver) return commodityCache;
  } catch (e) {
    console.log("⚠️ metals.live failed:", e.message);
  }

  // ── Fallback: stooq.com (free CSV, no key, reliable) ────────────────────
  try {
    const [goldRes, silverRes] = await Promise.all([
      axios.get("https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv", { timeout: 8000 }),
      axios.get("https://stooq.com/q/l/?s=xagusd&f=sd2t2ohlcv&h&e=csv", { timeout: 8000 }),
    ]);

    const parseStooq = (csv) => {
      const lines = csv.trim().split("\n");
      if (lines.length < 2) return null;
      const cols  = lines[1].split(",");
      // Symbol,Date,Time,Open,High,Low,Close,Volume
      const close = parseFloat(cols[6]);
      const open  = parseFloat(cols[3]);
      if (!close || isNaN(close)) return null;
      const changePct = open > 0 ? ((close - open) / open) * 100 : 0;
      return { price: close, change24h: Math.round(changePct * 100) / 100 };
    };

    const gold   = parseStooq(goldRes.data);
    const silver = parseStooq(silverRes.data);

    if (gold) {
      commodityCache.GOLD   = { ...gold,   fetchedAt: now };
    }
    if (silver) {
      commodityCache.SILVER = { ...silver, fetchedAt: now };
    }
    return commodityCache;

  } catch (e) {
    console.log("⚠️ stooq fallback failed:", e.message);
  }

  // ── Last resort: return cached (possibly stale) ──────────────────────────
  return commodityCache;
}

// Express route — add to server.js:
// const { commoditiesRoute } = require("./commodities_route");
// app.get("/api/commodities", commoditiesRoute);

async function commoditiesRoute(req, res) {
  try {
    const data = await fetchCommodities();
    res.json({
      GOLD:   data.GOLD,
      SILVER: data.SILVER,
      cachedAt: data.GOLD.fetchedAt
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = { commoditiesRoute, fetchCommodities };