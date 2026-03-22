/**
 * liveMcap.js
 * Fetches live MCap + company data from BSE.
 * Caches aggressively to avoid rate limits.
 * Also updates static marketCap store when live data is fetched.
 */

const axios = require("axios");

const FMP_KEY = "ch4kAf6MzKzLUkpdPD2pc2BX6XWkF3MQ";

const mcapCache    = {};
const profileCache = {};
const yahooCache   = {};
const holdingCache = {};

const LIVE_CACHE_TTL   =  2 * 60 * 1000; // 2 min for live price (was 30s — too aggressive)
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for profile

const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":    "https://www.bseindia.com",
  "Accept":     "application/json, text/plain, */*"
};

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":    "https://www.nseindia.com",
  "Accept":     "application/json, text/plain, */*"
};

function parseMcap(d) {
  // Try all known MCap field names from BSE API
  const raw = d?.MarketCapCr || d?.Mktcap || d?.mktcap || d?.MktCap
            || d?.mktCap     || d?.MKTCAP  || d?.market_cap || null;
  if (!raw) return null;
  const v = parseFloat(String(raw).replace(/,/g, ""));
  return v > 0 ? v : null;
}

// ── 1. BSE Live Quote — MCap only ──
async function getLiveMcap(code) {
  if (!code) return null;
  const c = String(code).trim();
  if (!c || c === "0" || c.length < 4) return null;

  // Return cached if fresh
  if (mcapCache[c] && (Date.now() - mcapCache[c].fetchedAt) < LIVE_CACHE_TTL) {
    return mcapCache[c].mcap;
  }

  // Try BSE getScripHeaderData
  try {
    const res = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Scrip_Cd=${c}`,
      { headers: BSE_HEADERS, timeout: 5000 }
    );
    const mcap = parseMcap(res.data);
    if (mcap && mcap > 0) {
      mcapCache[c] = { mcap, fetchedAt: Date.now() };

      // ── Also update static marketCap store so orderBookEngine can use it ──
      try {
        const { updateFromResult } = require("./marketCap");
        updateFromResult(c, { mcap });
      } catch(e) {}

      return mcap;
    }
  } catch(e) {}

  // Try BSE quote API as fallback
  try {
    const res = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/getQuote/w?scripcode=${c}&type=EQ`,
      { headers: BSE_HEADERS, timeout: 5000 }
    );
    const d    = res.data?.Header || res.data || {};
    const mcap = parseMcap(d);
    if (mcap && mcap > 0) {
      mcapCache[c] = { mcap, fetchedAt: Date.now() };
      try {
        const { updateFromResult } = require("./marketCap");
        updateFromResult(c, { mcap });
      } catch(e) {}
      return mcap;
    }
  } catch(e) {}

  return null;
}

// ── 2. BSE Full Company Profile ──
async function getCompanyProfile(code) {
  if (!code) return null;
  const c = String(code).trim();
  if (!c || c.length < 4) return null;

  if (profileCache[c] && (Date.now() - profileCache[c].fetchedAt) < PROFILE_CACHE_TTL) {
    return profileCache[c].profile;
  }

  try {
    const [headerRes, aboutRes] = await Promise.allSettled([
      axios.get(`https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Scrip_Cd=${c}`, { headers: BSE_HEADERS, timeout: 6000 }),
      axios.get(`https://api.bseindia.com/BseIndiaAPI/api/CompanyProfile/w?scrip_cd=${c}`,     { headers: BSE_HEADERS, timeout: 6000 })
    ]);

    const h = headerRes.status === "fulfilled" ? (headerRes.value.data || {}) : {};
    const a = aboutRes.status  === "fulfilled" ? (aboutRes.value.data  || {}) : {};

    const mcap      = parseMcap(h);
    const price     = parseFloat(h?.CurrRate || h?.Ltrade || 0) || null;
    const prev      = parseFloat(h?.PrevClose || 0) || null;
    const change    = price && prev ? parseFloat((price - prev).toFixed(2)) : null;
    const changePct = price && prev ? parseFloat(((price - prev) / prev * 100).toFixed(2)) : null;

    if (mcap) {
      mcapCache[c] = { mcap, fetchedAt: Date.now() };
      try { const { updateFromResult } = require("./marketCap"); updateFromResult(c, { mcap }); } catch(e) {}
    }

    const profile = {
      code,
      name:          h?.LongName      || h?.CompanyName || a?.CompanyName || null,
      sector:        h?.Sector        || a?.Sector       || null,
      industry:      h?.Industry      || a?.Industry     || null,
      about:         a?.CompanyProfile|| a?.About        || a?.CompanyDesc || null,
      nseSymbol:     h?.NSESymbol     || a?.NSESymbol    || null,
      price, prev, change, changePct,
      dayHigh:       parseFloat(h?.DayHigh   || 0) || null,
      dayLow:        parseFloat(h?.DayLow    || 0) || null,
      volume:        parseFloat(h?.TotalTradedQty || h?.Volume || 0) || null,
      mcap,
      pe:            parseFloat(h?.PE        || 0) || null,
      eps:           parseFloat(h?.EPS       || 0) || null,
      bookValue:     parseFloat(h?.BookVal   || 0) || null,
      faceValue:     parseFloat(h?.FaceValue || 0) || null,
      dividendYield: parseFloat(h?.DivYield  || 0) || null,
      high52:        parseFloat(h?.High52    || 0) || null,
      low52:         parseFloat(h?.Low52     || 0) || null,
    };

    profileCache[c] = { profile, fetchedAt: Date.now() };
    return profile;
  } catch(e) { return null; }
}

// ── 3. Yahoo Finance ──
async function getYahooData(bseCode) {
  const c = String(bseCode).trim();
  if (yahooCache[c] && (Date.now() - yahooCache[c].fetchedAt) < PROFILE_CACHE_TTL) return yahooCache[c].data;

  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${c}.BO?modules=financialData,defaultKeyStatistics,incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, timeout: 8000 }
    );
    const result = res.data?.quoteSummary?.result?.[0];
    if (!result) return null;

    const fin = result.financialData || {};
    const inc = result.incomeStatementHistoryQuarterly?.incomeStatementHistory || [];
    const bal = result.balanceSheetHistoryQuarterly?.balanceSheetStatements    || [];
    const latestBal = bal[0] || {};

    const data = {
      totalDebt:       latestBal.totalDebt?.raw ? Math.round(latestBal.totalDebt.raw / 10000000) : null,
      totalCash:       latestBal.cash?.raw       ? Math.round(latestBal.cash.raw      / 10000000) : null,
      debtToEquity:    fin.debtToEquity?.raw    || null,
      currentRatio:    fin.currentRatio?.raw    || null,
      returnOnEquity:  fin.returnOnEquity?.raw  ? (fin.returnOnEquity.raw  * 100).toFixed(1) : null,
      returnOnAssets:  fin.returnOnAssets?.raw  ? (fin.returnOnAssets.raw  * 100).toFixed(1) : null,
      revenueGrowth:   fin.revenueGrowth?.raw   ? (fin.revenueGrowth.raw   * 100).toFixed(1) : null,
      profitMargin:    fin.profitMargins?.raw    ? (fin.profitMargins.raw   * 100).toFixed(1) : null,
      operatingMargin: fin.operatingMargins?.raw ? (fin.operatingMargins.raw* 100).toFixed(1) : null,
      quarters: inc.slice(0, 4).map(q => ({
        date:    q.endDate?.fmt || null,
        revenue: q.totalRevenue?.raw ? Math.round(q.totalRevenue.raw / 10000000) : null,
        profit:  q.netIncome?.raw    ? Math.round(q.netIncome.raw    / 10000000) : null,
        ebitda:  q.ebitda?.raw       ? Math.round(q.ebitda.raw       / 10000000) : null,
      }))
    };
    yahooCache[c] = { data, fetchedAt: Date.now() };
    return data;
  } catch(e) { return null; }
}

// ── 4. FMP ──
async function getFMPData(nseSymbol) {
  if (!nseSymbol) return null;
  const sym = `${nseSymbol}.NS`;
  const key = `fmp_${sym}`;
  if (yahooCache[key] && (Date.now() - yahooCache[key].fetchedAt) < PROFILE_CACHE_TTL) return yahooCache[key].data;

  try {
    const [incomeRes, balanceRes, ratioRes] = await Promise.allSettled([
      axios.get(`https://financialmodelingprep.com/api/v3/income-statement/${sym}?period=quarter&limit=4&apikey=${FMP_KEY}`, { timeout: 8000 }),
      axios.get(`https://financialmodelingprep.com/api/v3/balance-sheet-statement/${sym}?period=quarter&limit=1&apikey=${FMP_KEY}`, { timeout: 8000 }),
      axios.get(`https://financialmodelingprep.com/api/v3/ratios-ttm/${sym}?apikey=${FMP_KEY}`, { timeout: 8000 })
    ]);
    const income  = incomeRes.status  === "fulfilled" ? (incomeRes.value.data  || []) : [];
    const balance = balanceRes.status === "fulfilled" ? (balanceRes.value.data || []) : [];
    const ratios  = ratioRes.status   === "fulfilled" ? (ratioRes.value.data?.[0] || {}) : {};
    const lb      = balance[0] || {};
    const data = {
      totalDebt:       lb.totalDebt           ? Math.round(lb.totalDebt           / 10000000) : null,
      totalCash:       lb.cashAndEquivalents   ? Math.round(lb.cashAndEquivalents  / 10000000) : null,
      debtToEquity:    lb.totalDebt && lb.totalEquity ? (lb.totalDebt / lb.totalEquity).toFixed(2) : null,
      currentRatio:    ratios.currentRatioTTM    || null,
      returnOnEquity:  ratios.returnOnEquityTTM  ? (ratios.returnOnEquityTTM  * 100).toFixed(1) : null,
      returnOnAssets:  ratios.returnOnAssetsTTM  ? (ratios.returnOnAssetsTTM  * 100).toFixed(1) : null,
      profitMargin:    ratios.netProfitMarginTTM ? (ratios.netProfitMarginTTM  * 100).toFixed(1) : null,
      operatingMargin: ratios.operatingProfitMarginTTM ? (ratios.operatingProfitMarginTTM * 100).toFixed(1) : null,
      quarters: income.slice(0, 4).map(q => ({
        date:    q.date || null,
        revenue: q.revenue   ? Math.round(q.revenue   / 10000000) : null,
        profit:  q.netIncome ? Math.round(q.netIncome / 10000000) : null,
        ebitda:  q.ebitda    ? Math.round(q.ebitda    / 10000000) : null,
        eps:     q.eps || null,
      })),
      source: "FMP"
    };
    yahooCache[key] = { data, fetchedAt: Date.now() };
    return data;
  } catch(e) { return null; }
}

// ── 5. Shareholding ──
async function getShareholding(bseCode, nseSymbol) {
  const c = String(bseCode).trim();
  if (holdingCache[c] && (Date.now() - holdingCache[c].fetchedAt) < PROFILE_CACHE_TTL) return holdingCache[c].data;

  try {
    const res  = await axios.get(`https://api.bseindia.com/BseIndiaAPI/api/ShareHoldingPatterns/w?scripcd=${c}`, { headers: BSE_HEADERS, timeout: 6000 });
    const rows = res.data?.Table || res.data?.table || res.data?.data || [];
    if (rows.length) {
      let promoter = null, fii = null, dii = null, pub = null;
      rows.forEach(row => {
        const cat = (row.category || row.Category || row.CATEGORY || "").toLowerCase();
        const pct = parseFloat(row.percentage || row.Percentage || row.PCNHOT || 0);
        if (cat.includes("promoter")) promoter = pct;
        if (cat.includes("fii") || cat.includes("fpi") || cat.includes("foreign")) fii = pct;
        if (cat.includes("dii") || cat.includes("mutual") || cat.includes("institution")) dii = pct;
        if (cat.includes("public") || cat.includes("retail")) pub = pct;
      });
      const data = { promoter, fii, dii, public: pub, source: "BSE" };
      holdingCache[c] = { data, fetchedAt: Date.now() };
      return data;
    }
  } catch(e) {}

  if (nseSymbol) {
    try {
      const res  = await axios.get(`https://www.nseindia.com/api/corporate-share-holdings-master?index=shareholding&symbol=${nseSymbol}`, { headers: NSE_HEADERS, timeout: 6000 });
      const d    = res.data;
      const data = { promoter: d?.promoter || null, fii: d?.fii || d?.FPI || null, dii: d?.dii || null, public: d?.public || null, source: "NSE" };
      holdingCache[c] = { data, fetchedAt: Date.now() };
      return data;
    } catch(e) {}
  }
  return null;
}

// ── 6. Full Screener ──
async function getFullScreenerData(bseCode, nseSymbol) {
  console.log(`🔍 Screener: ${bseCode} / ${nseSymbol}`);
  const [profile, yahoo, fmp, holding] = await Promise.allSettled([
    getCompanyProfile(bseCode),
    getYahooData(bseCode),
    nseSymbol ? getFMPData(nseSymbol) : Promise.resolve(null),
    getShareholding(bseCode, nseSymbol)
  ]);
  const p = profile.status === "fulfilled" ? profile.value : null;
  const y = yahoo.status   === "fulfilled" ? yahoo.value   : null;
  const f = fmp.status     === "fulfilled" ? fmp.value     : null;
  const h = holding.status === "fulfilled" ? holding.value : null;
  const fin = {
    totalDebt:       f?.totalDebt       || y?.totalDebt       || null,
    totalCash:       f?.totalCash       || y?.totalCash       || null,
    debtToEquity:    f?.debtToEquity    || y?.debtToEquity    || null,
    currentRatio:    f?.currentRatio    || y?.currentRatio    || null,
    returnOnEquity:  f?.returnOnEquity  || y?.returnOnEquity  || null,
    returnOnAssets:  f?.returnOnAssets  || y?.returnOnAssets  || null,
    profitMargin:    f?.profitMargin    || y?.profitMargin    || null,
    operatingMargin: f?.operatingMargin || y?.operatingMargin || null,
    revenueGrowth:   y?.revenueGrowth   || null,
    quarters:        f?.quarters        || y?.quarters        || [],
  };
  return { profile: p, financials: fin, shareholding: h };
}

module.exports = { getLiveMcap, getCompanyProfile, getFullScreenerData };