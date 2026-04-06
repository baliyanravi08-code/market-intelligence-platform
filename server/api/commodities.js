/**
 * api/commodities.js
 * FIXED 06 Apr 2026:
 * - fawazahmed0 XAU/USD: the API returns USD per 1 XAU correctly (~3020)
 *   BUT the currency key is "xau" and rates are in terms of "how much of X per 1 XAU"
 *   So xau.usd = USD per 1 troy oz gold ✅ — previous bug was misreading the value
 * - Added price sanity check with auto-inversion if value looks like reciprocal
 * - Yahoo Finance added as Source 2 (gives correct futures price + 24h change)
 */

const axios = require("axios");

let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000;

function sanitizeGold(price) {
  if (!price || isNaN(price)) return null;
  // If price looks like reciprocal (e.g. 0.000214 = 1/4676), invert it
  if (price < 1) return Math.round((1 / price) * 100) / 100;
  // If price is in the 1500–5000 range, it's correct
  if (price >= 1500 && price <= 5000) return Math.round(price * 100) / 100;
  // If price is way too high (like 4676 for silver), it's inverted gold
  return null;
}

function sanitizeSilver(price) {
  if (!price || isNaN(price)) return null;
  if (price < 1) return Math.round((1 / price) * 100) / 100;
  if (price >= 15 && price <= 200) return Math.round(price * 100) / 100;
  return null;
}

// ── Source 1: Yahoo Finance futures (GC=F gold, SI=F silver) ─────────────────
// Most reliable, gives real futures price + 24h change, no key needed
async function fetchYahoo() {
  const [goldRes, silverRes] = await Promise.all([
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF", {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      params:  { interval: "1d", range: "2d" },
    }),
    axios.get("https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF", {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
      params:  { interval: "1d", range: "2d" },
    }),
  ]);

  const gm = goldRes.data?.chart?.result?.[0]?.meta;
  const sm = silverRes.data?.chart?.result?.[0]?.meta;

  if (!gm?.regularMarketPrice) throw new Error("No gold price from Yahoo");

  const gp = gm.regularMarketPrice;
  const gv = gm.chartPreviousClose || gp;
  const sp = sm?.regularMarketPrice || 33.8;
  const sv = sm?.chartPreviousClose || sp;

  if (gp < 1500 || gp > 5000) throw new Error(`Implausible Yahoo gold: $${gp}`);

  return {
    GOLD: {
      price:    Math.round(gp * 100) / 100,
      change24h: gv > 0 ? Math.round(((gp - gv) / gv) * 10000) / 100 : 0,
    },
    SILVER: {
      price:    Math.round(sp * 100) / 100,
      change24h: sv > 0 ? Math.round(((sp - sv) / sv) * 10000) / 100 : 0,
    },
  };
}

// ── Source 2: fawazahmed0 via jsDelivr CDN ────────────────────────────────────
async function fetchFawaz() {
  const [r1, r2] = await Promise.all([
    axios.get(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json",
      { timeout: 8000 }
    ),
    axios.get(
      "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xag.json",
      { timeout: 8000 }
    ),
  ]);

  const rawGold   = r1.data?.xau?.usd;
  const rawSilver = r2.data?.xag?.usd;

  const goldPrice   = sanitizeGold(rawGold);
  const silverPrice = sanitizeSilver(rawSilver);

  if (!goldPrice) throw new Error(`Fawaz gold price unusable: ${rawGold}`);

  return {
    GOLD:   { price: goldPrice,          change24h: 0 },
    SILVER: { price: silverPrice || 33.8, change24h: 0 },
  };
}

// ── Source 3: fawazahmed0 Cloudflare Pages mirror ─────────────────────────────
async function fetchFawazMirror() {
  const [r1, r2] = await Promise.all([
    axios.get("https://latest.currency-api.pages.dev/v1/currencies/xau.json", { timeout: 8000 }),
    axios.get("https://latest.currency-api.pages.dev/v1/currencies/xag.json", { timeout: 8000 }),
  ]);

  const rawGold   = r1.data?.xau?.usd;
  const rawSilver = r2.data?.xag?.usd;

  const goldPrice   = sanitizeGold(rawGold);
  const silverPrice = sanitizeSilver(rawSilver);

  if (!goldPrice) throw new Error(`Fawaz mirror gold price unusable: ${rawGold}`);

  return {
    GOLD:   { price: goldPrice,          change24h: 0 },
    SILVER: { price: silverPrice || 33.8, change24h: 0 },
  };
}

// ── Source 4: hardcoded fallback (Apr 2026) ───────────────────────────────────
function getFallbackPrices() {
  return {
    GOLD:   { price: 3020.50, change24h: 0 },
    SILVER: { price: 33.80,   change24h: 0 },
    _stale: true,
  };
}

// ── Main fetcher ──────────────────────────────────────────────────────────────
async function getCommodities() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  const sources = [
    { name: "yahoo-finance-futures",  fn: fetchYahoo       },
    { name: "fawazahmed0-jsdelivr",   fn: fetchFawaz       },
    { name: "fawazahmed0-pages.dev",  fn: fetchFawazMirror },
  ];

  let result = null;

  for (const source of sources) {
    try {
      result = await source.fn();
      console.log(`✅ Commodities: ${source.name} OK — Gold $${result.GOLD.price} Silver $${result.SILVER.price}`);
      break;
    } catch (e) {
      console.warn(`⚠️ Commodities: ${source.name} failed: ${e.message}`);
    }
  }

  if (!result) {
    result = getFallbackPrices();
    console.warn("⚠️ Commodities: all sources failed — using hardcoded fallback");
  }

  cache     = result;
  cacheTime = Date.now();
  return result;
}

async function commoditiesRoute(req, res) {
  try {
    const data = await getCommodities();
    res.json(data);
  } catch (e) {
    console.error("Commodities route error:", e.message);
    res.json(getFallbackPrices());
  }
}

module.exports = { commoditiesRoute, getCommodities };