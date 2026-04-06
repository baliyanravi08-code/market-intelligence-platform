/**
 * api/commodities.js
 * Server-side Gold + Silver price fetcher.
 * FIXED 06 Apr 2026 — all sources are truly free, no API key required.
 *
 * Source chain:
 *   1. fawazahmed0 currency-api via jsDelivr CDN (GitHub, always free, no key)
 *   2. fawazahmed0 fallback CDN (pages.dev mirror)
 *   3. Yahoo Finance GC=F / SI=F futures scrape
 *   4. Hardcoded last-known fallback — UI never breaks
 */

const axios = require("axios");

let cache     = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 1000;

// ── Source 1: fawazahmed0 via jsDelivr (truly free, no key, GitHub-backed) ────
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

  const goldPrice   = r1.data?.xau?.usd;
  const silverPrice = r2.data?.xag?.usd;

  if (!goldPrice) throw new Error("No XAU/USD in fawaz jsDelivr response");
  if (goldPrice < 1500 || goldPrice > 5000) throw new Error(`Implausible gold: $${goldPrice}`);

  return {
    GOLD:   { price: Math.round(goldPrice   * 100) / 100, change24h: 0 },
    SILVER: { price: Math.round((silverPrice || 33.8) * 100) / 100, change24h: 0 },
  };
}

// ── Source 2: fawazahmed0 mirror on Cloudflare Pages ─────────────────────────
async function fetchFawazMirror() {
  const [r1, r2] = await Promise.all([
    axios.get("https://latest.currency-api.pages.dev/v1/currencies/xau.json", { timeout: 8000 }),
    axios.get("https://latest.currency-api.pages.dev/v1/currencies/xag.json", { timeout: 8000 }),
  ]);

  const goldPrice   = r1.data?.xau?.usd;
  const silverPrice = r2.data?.xag?.usd;

  if (!goldPrice) throw new Error("No XAU/USD in fawaz pages.dev response");
  if (goldPrice < 1500 || goldPrice > 5000) throw new Error(`Implausible gold: $${goldPrice}`);

  return {
    GOLD:   { price: Math.round(goldPrice   * 100) / 100, change24h: 0 },
    SILVER: { price: Math.round((silverPrice || 33.8) * 100) / 100, change24h: 0 },
  };
}

// ── Source 3: Yahoo Finance futures GC=F (gold) SI=F (silver) ─────────────────
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

  const goldMeta   = goldRes.data?.chart?.result?.[0]?.meta;
  const silverMeta = silverRes.data?.chart?.result?.[0]?.meta;

  if (!goldMeta?.regularMarketPrice) throw new Error("No gold price from Yahoo");

  const gp = goldMeta.regularMarketPrice;
  const gv = goldMeta.chartPreviousClose || gp;
  const sp = silverMeta?.regularMarketPrice || 33.8;
  const sv = silverMeta?.chartPreviousClose || sp;

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

// ── Source 4: hardcoded fallback (Apr 2026) ───────────────────────────────────
function getFallbackPrices() {
  return {
    GOLD:   { price: 3020.50, change24h: 0 },
    SILVER: { price: 33.80,   change24h: 0 },
    _stale: true,
  };
}

// ── Main fetcher with cascade ─────────────────────────────────────────────────
async function getCommodities() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;

  const sources = [
    { name: "fawazahmed0-jsdelivr",  fn: fetchFawaz       },
    { name: "fawazahmed0-pages.dev", fn: fetchFawazMirror },
    { name: "yahoo-finance-futures", fn: fetchYahoo       },
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