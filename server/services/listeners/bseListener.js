"use strict";

const axios = require("axios");

const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const { orderBookEngine } = require("../intelligence/orderBookEngine");
const sectorEngine        = require("../intelligence/sectorEngine");
const { saveResult, getRetentionHours, getWindowLabel } = require("../../database");
const {
  persistRadar,
  persistOrderBook,
  persistSector,
  persistMegaOrder,
  persistGuidance,
  sendStoredToClient
} = require("../../coordinator");

const orderBookDB = require("../../data/orderBookDB");

const {
  isPresentationFiling,
  handleLivePresentationFiling
} = require("../intelligence/presentationParser");

let ioRef     = null;
let bseCookie = "";
let lastWarmupAt = 0;
const seen    = new Set();

const BSE_HOME = "https://www.bseindia.com/corporates/ann.html";
const BSE_API  = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=&strType=C&subcategory=-1";

// Multiple warmup URLs — try each in order until one gives cookies
const BSE_WARMUP_URLS = [
  "https://www.bseindia.com/corporates/ann.html",
  "https://www.bseindia.com/",
  "https://www.bseindia.com/markets/equity/EQReports/MarketWatch.aspx",
  "https://www.bseindia.com/markets/Equity/EQReports/StockPrcHistori.aspx",
];

const ORDER_BOOK_SECTORS = [
  "infra", "epc", "engineer", "construct", "railway", "defense", "defence",
  "solar", "renewable", "power", "water", "wabag", "rites", "rvnl", "irfc",
  "hal", "bel", "bharat", "ntpc", "l&t", "larsen", "kec", "kalpataru",
  "patel", "techno", "thermax", "cummins", "bhel", "suzlon", "adani green",
  "torrent", "tata power", "greenko", "inox wind"
];

function isOrderBookCompany(company) {
  const c = (company || "").toLowerCase();
  return ORDER_BOOK_SECTORS.some(k => c.includes(k));
}

function buildHistoricalUrl(fromDate, toDate) {
  const fmt = d => `${String(d.getDate()).padStart(2,"0")}%2F${String(d.getMonth()+1).padStart(2,"0")}%2F${d.getFullYear()}`;
  return `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=${fmt(fromDate)}&strScrip=&strSearch=P&strToDate=${fmt(toDate)}&strType=C&subcategory=-1`;
}

// Modern Chrome 123 headers — bypass BSE bot detection
const BROWSER_HEADERS = {
  "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language":           "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding":           "gzip, deflate, br",
  "Connection":                "keep-alive",
  "Cache-Control":             "max-age=0",
  "Sec-Ch-Ua":                 '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  "Sec-Ch-Ua-Mobile":          "?0",
  "Sec-Ch-Ua-Platform":        '"Windows"',
  "Sec-Fetch-Dest":            "document",
  "Sec-Fetch-Mode":            "navigate",
  "Sec-Fetch-Site":            "none",
  "Sec-Fetch-User":            "?1",
  "Upgrade-Insecure-Requests": "1",
};

// API call headers (XHR/fetch style)
const API_HEADERS = {
  "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept":            "application/json, text/plain, */*",
  "Accept-Language":   "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding":   "gzip, deflate, br",
  "Connection":        "keep-alive",
  "Referer":           "https://www.bseindia.com/corporates/ann.html",
  "Origin":            "https://www.bseindia.com",
  "X-Requested-With":  "XMLHttpRequest",
  "Sec-Ch-Ua":         '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  "Sec-Ch-Ua-Mobile":  "?0",
  "Sec-Ch-Ua-Platform":'"Windows"',
  "Sec-Fetch-Site":    "same-origin",
  "Sec-Fetch-Mode":    "cors",
  "Sec-Fetch-Dest":    "empty",
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone:  "Asia/Kolkata",
    month:     "short", day: "numeric",
    hour:      "numeric", minute: "numeric",
    hour12:    true
  });
}

function getTimeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60)   return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function parseExchangeTs(timeStr) {
  if (!timeStr) return null;
  try {
    const d = new Date(timeStr);
    if (!isNaN(d)) return d.getTime();
  } catch {}
  return null;
}

function parseResultQuarterFromTitle(title) {
  const t = (title || "").toLowerCase();

  const monthMap = {
    january:1, jan:1, february:2, feb:2, march:3, mar:3,
    april:4,   apr:4, may:5,      june:6, jun:6,
    july:7,    jul:7, august:8,   aug:8,  september:9, sep:9, sept:9,
    october:10,oct:10,november:11,nov:11, december:12, dec:12,
  };

  const m = t.match(/ended\s+(?:\d+(?:st|nd|rd|th)?\s+)?(\w+)(?:[,\s]+(\d{4}))?/);
  if (m) {
    const monthName = m[1].toLowerCase();
    const month     = monthMap[monthName];
    if (month) {
      let year = m[2] ? parseInt(m[2]) : new Date().getFullYear();
      if (!m[2] && month > new Date().getMonth() + 1) year -= 1;
      const fy    = month >= 4 ? year + 1 : year;
      const short = String(fy).slice(-2);
      if (month >= 4  && month <= 6)  return `Q1FY${short}`;
      if (month >= 7  && month <= 9)  return `Q2FY${short}`;
      if (month >= 10 && month <= 12) return `Q3FY${short}`;
      return `Q4FY${short}`;
    }
  }

  const direct = (title || "").match(/\b(Q[1-4]FY\d{2})\b/i);
  if (direct) return direct[1].toUpperCase();

  return orderBookDB.getCurrentQuarter();
}

function extractConfirmedOBFromText(text) {
  if (!text) return null;
  const t = String(text).replace(/,/g, "").replace(/₹/g, "Rs").replace(/INR/gi, "Rs");

  const patterns = [
    /order\s*book\s+(?:stood\s+at|of|at|is|stands?\s+at|as\s+(?:on|of)[^₹\d]{0,20})\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*backlog\s+(?:of|at|is|stands?\s+at)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /unexecuted\s+order\s+(?:book|backlog)\s+(?:of|at|is)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /outstanding\s+order\s*(?:book|s)?\s+(?:of|at|is|worth)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*book\s*(?:position|size|value)\s+(?:of|at|is)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)\s+order\s*book/i,
    /order\s*book\s+(?:of|at|is)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*lakh\s*cr/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m) {
      let val = parseFloat(m[1]);
      if (i === patterns.length - 1) val = val * 100000;
      if (val > 100) return parseFloat(val.toFixed(2));
    }
  }
  return null;
}

async function enrichResultWithPDF(signal) {
  if (!signal.pdfUrl) return signal;

  try {
    const { extractOrderValueFromPDF } = require("../data/pdfReader");
    const { updateFromResult }         = require("../data/marketCap");

    console.log(`📄 Result PDF scan: ${signal.company}`);

    const pdfResult = await extractOrderValueFromPDF(signal.pdfUrl);

    let confirmedOB  = null;
    let rawPdfText   = null;

    if (typeof pdfResult === "string") {
      rawPdfText  = pdfResult;
      confirmedOB = extractConfirmedOBFromText(pdfResult);
    } else if (typeof pdfResult === "number" && pdfResult > 100) {
      confirmedOB = pdfResult;
    }

    const resultQuarter = parseResultQuarterFromTitle(signal.title);

    if (!confirmedOB || confirmedOB <= 0) {
      console.log(`📄 Result PDF: no OB found for ${signal.company}`);
      return signal;
    }

    console.log(`📦 Result OB: ${signal.company} ₹${confirmedOB}Cr (${resultQuarter})`);

    updateFromResult(String(signal.code), {
      confirmedOrderBook:    confirmedOB,
      confirmedQuarter:      resultQuarter,
      newOrdersSinceConfirm: 0,
    });

    await orderBookDB.updateFromResultFiling(
      String(signal.code),
      signal.company,
      confirmedOB,
      resultQuarter,
      null
    );

    if (!signal.resultSignals) signal.resultSignals = [];
    signal.resultSignals.push(
      `OB ₹${confirmedOB >= 1000 ? (confirmedOB / 1000).toFixed(1) + "K" : confirmedOB}Cr (${resultQuarter})`
    );

  } catch (e) {
    console.log(`📄 Result PDF failed: ${e.message}`);
  }

  return signal;
}

// ── Warmup: try multiple BSE pages, collect cookies ──────────────────────────
async function warmup() {
  // Don't re-warmup more than once every 10 minutes
  if (Date.now() - lastWarmupAt < 10 * 60 * 1000 && bseCookie && bseCookie !== "cookieless") {
    return true;
  }

  for (const url of BSE_WARMUP_URLS) {
    try {
      const res = await axios.get(url, {
        headers: BROWSER_HEADERS,
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
      });

      const cookies = res.headers["set-cookie"];
      if (cookies?.length) {
        bseCookie    = cookies.map(c => c.split(";")[0]).join("; ");
        lastWarmupAt = Date.now();
        console.log("✅ BSE warmup successful");
        return true;
      }

      // Small delay between attempts
      await sleep(1500);

    } catch (err) {
      // Silently continue to next URL
    }
  }

  // Cookie-less sentinel — scan() works without real cookies
  bseCookie    = "cookieless";
  lastWarmupAt = Date.now();
  console.log("⚠️ BSE running cookie-less (announcements still work via API)");
  return true;
}

function extractList(data) {
  if (!data) return [];
  if (typeof data === "string") {
    if (data.trim().startsWith("<")) return [];
    try { data = JSON.parse(data); } catch { return []; }
  }
  if (Array.isArray(data))        return data;
  if (Array.isArray(data.Table))  return data.Table;
  if (Array.isArray(data.Table1)) return data.Table1;
  if (Array.isArray(data.data))   return data.data;
  if (Array.isArray(data.Data))   return data.Data;
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
  }
  return [];
}

// Build headers — include cookie only if we have a real one
function buildApiHeaders(extra = {}) {
  const cookieHeader = bseCookie && bseCookie !== "cookieless"
    ? { "Cookie": bseCookie }
    : {};
  return { ...API_HEADERS, ...cookieHeader, ...extra };
}

async function processItem(item) {
  const id = String(item.SCRIP_CD || "") + (item.HEADLINE || "");
  if (!id || seen.has(id)) return;
  seen.add(id);

  const signal = await analyzeAnnouncement({
    company:  item.SLONGNAME || item.companyname || "Unknown",
    code:     String(item.SCRIP_CD || ""),
    title:    item.HEADLINE || "",
    time:     item.DT_TM || item.NEWS_DT || getIndianTime(),
    ago:      getTimeAgo(new Date()),
    exchange: "BSE",
    pdfUrl:   item.ATTACHMENTNAME
      ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`
      : null
  });

  if (!signal) return;

  // PDF enrichment for ORDER_ALERT with no crore value
  if (signal.type === "ORDER_ALERT" && !signal._orderInfo?.crores && signal.pdfUrl) {
    try {
      const { extractOrderValueFromPDF } = require("../data/pdfReader");
      const { getLiveMcap }              = require("../data/liveMcap");
      const { scoreFromMcapRatio, scoreFromAbsoluteSize } = require("../analyzers/announcementAnalyzer");

      const pdfCrores = await extractOrderValueFromPDF(signal.pdfUrl);
      if (pdfCrores && pdfCrores > 0) {
        console.log(`📄 PDF enriched: ${signal.company} ₹${pdfCrores}Cr`);
        const mcap     = (await getLiveMcap(signal.code)) || null;
        const newScore = mcap ? scoreFromMcapRatio(pdfCrores, mcap) : scoreFromAbsoluteSize(pdfCrores);
        signal._orderInfo = {
          crores: pdfCrores, years: null, periodLabel: null,
          annualCrores: null, mcap: mcap || null, fromPDF: true
        };
        signal.value = newScore;
      }
    } catch(e) {
      console.log(`📄 PDF enrichment failed: ${e.message}`);
    }
  }

  // Result filing — OB extraction
  if ((signal.type === "RESULT" || signal.type === "BANK_RESULT") && signal.pdfUrl) {
    enrichResultWithPDF(signal).catch(() => {});
  }

  // Investor presentation — extract 3-year guidance
  if (isPresentationFiling(signal.title) && signal.pdfUrl) {
    handleLivePresentationFiling({ ...signal }, ioRef)
      .then(doc => {
        if (doc) {
          persistGuidance(doc);
          if (ioRef) ioRef.emit("guidance_update", doc);
        }
      })
      .catch(() => {});
  }

  const exchangeTs   = parseExchangeTs(signal.time);
  const signalWithTs = {
    ...signal,
    savedAt:    (exchangeTs && !isNaN(exchangeTs)) ? exchangeTs : Date.now(),
    receivedAt: Date.now()
  };

  saveResult(signalWithTs);
  updateRadar(signalWithTs.company, signalWithTs);
  const radar = getRadar();
  persistRadar(radar);

  if (ioRef) ioRef.emit("bse_events",    [signalWithTs]);
  if (ioRef) ioRef.emit("radar_update",  radar);

  if (signalWithTs.type === "ORDER_ALERT") {
    const enrichedSignal = { ...signalWithTs, _orderInfo: signal._orderInfo };
    const orderData      = orderBookEngine(enrichedSignal);
    const _crores        = signal._orderInfo?.crores || 0;

    if (_crores > 0 && signalWithTs.code) {
      try {
        await orderBookDB.addOrderToBook(
          String(signalWithTs.code),
          signalWithTs.company,
          _crores,
          signalWithTs.title,
          signalWithTs.pdfUrl
        );
      } catch(e) {
        console.log("⚠️ OrderBook addOrder failed:", e.message);
      }

      try {
        const { addNewOrder } = require("../data/marketCap");
        addNewOrder(String(signalWithTs.code), _crores, id);
      } catch(e) {}

      console.log(`📦 OB+ ${signalWithTs.company} ₹${_crores}Cr`);
    }

    if (orderData) {
      persistOrderBook(orderData);
      if (ioRef) ioRef.emit("order_book_update", orderData);

      if (orderData.isMegaOrder || orderData.isMcapAlert || orderData.isFrequencyAlert) {
        const megaPayload = {
          company:        orderData.company,
          crores:         orderData.orderValue,
          years:          orderData.years,
          periodLabel:    orderData.periodLabel,
          annualCrores:   orderData.annualCrores,
          mcapRatio:      orderData.mcapRatio,
          mcap:           orderData.mcap,
          quarterBook:    orderData.quarterBook,
          quarterOrders:  orderData.quarterOrders,
          totalOrderBook: orderData.totalOrderBook,
          alertLevel:     orderData.alertLevel,
          title:          signalWithTs.title,
          pdfUrl:         signalWithTs.pdfUrl,
          time:           signalWithTs.time,
          receivedAt:     signalWithTs.savedAt || Date.now()
        };
        persistMegaOrder(megaPayload);
        if (ioRef) ioRef.emit("mega_order_alert", megaPayload);
      }
    }

    // ── Sector engine (replaces sectorQueue + sectorRadar + sectorBoomEngine) ──
    const sectorResult = sectorEngine.ingestFilingSignal(enrichedSignal);
    if (sectorResult) {
      persistSector(sectorResult);
      if (ioRef) {
        ioRef.emit("sector_alerts", [sectorResult]);
        if (sectorResult.isBoom) {
          ioRef.emit("sector_boom", sectorResult);
        }
      }
    }
  }
}

async function scan() {
  try {
    if (!bseCookie) await warmup();

    const res = await axios.get(BSE_API, {
      headers: buildApiHeaders(),
      timeout: 20000,
    });

    const list = extractList(res.data);
    if (!list.length) {
      console.log("⚠️ BSE returned empty list");
      // Cookie may have expired — reset and re-warmup next cycle
      bseCookie = "";
      if (ioRef) ioRef.emit("bse_status", "disconnected");
      return;
    }

    console.log(`✅ BSE announcements: ${list.length}`);
    if (ioRef) ioRef.emit("bse_status", "connected");

    list.forEach(item => processItem(item).catch(e =>
      console.log("⚠️ processItem error:", e.message)
    ));

  } catch (err) {
    console.log("❌ BSE fetch failed:", err.message);

    // On 403/401 reset cookie so next cycle re-warms up
    if (err.response?.status === 403 || err.response?.status === 401) {
      console.log("🔄 BSE session expired — will re-warmup next cycle");
      bseCookie    = "";
      lastWarmupAt = 0;
    }

    if (ioRef) ioRef.emit("bse_status", "disconnected");
  }
}

async function backfill() {
  console.log("🔄 Starting BSE historical backfill...");
  try {
    if (!bseCookie) await warmup();

    const now      = new Date();
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - 4);

    const url = buildHistoricalUrl(fromDate, now);
    console.log(`📅 Backfill: ${fromDate.toDateString()} → ${now.toDateString()}`);

    const res = await axios.get(url, {
      headers: buildApiHeaders(),
      timeout: 30000
    });

    const list = extractList(res.data);
    if (!list.length) {
      console.log("⚠️ Backfill empty — falling back to normal scan");
      await scan();
      return;
    }

    console.log(`✅ Backfill: ${list.length} announcements`);
    list.forEach(item => processItem(item).catch(e =>
      console.log("⚠️ backfill processItem error:", e.message)
    ));
    console.log("✅ Backfill complete");

  } catch (err) {
    console.log("⚠️ Backfill failed:", err.message, "— falling back");
    await scan();
  }
}

function startBSEListener(io) {
  ioRef = io;

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.emit("bse_status", bseCookie && bseCookie !== "cookieless" ? "connected" : "connecting");

    const { getEvents } = require("../../database");
    const storedBse = getEvents("bse") || [];
    const storedNse = getEvents("nse") || [];

    if (storedBse.length) {
      socket.emit("bse_events", storedBse);
      console.log(`📤 Sent ${storedBse.length} stored BSE events`);
    }
    if (storedNse.length) {
      socket.emit("nse_events", storedNse);
      console.log(`📤 Sent ${storedNse.length} stored NSE events`);
    }

    socket.emit("radar_update", getRadar());
    socket.emit("window_info", {
      hours: getRetentionHours(),
      label: getWindowLabel()
    });

    sendStoredToClient(socket);
  });

  // Re-warmup every 20 minutes to keep session alive
  setInterval(() => {
    if (bseCookie && bseCookie !== "cookieless") {
      console.log("🔄 BSE session refresh (scheduled)");
      bseCookie    = "";
      lastWarmupAt = 0;
      warmup().catch(() => {});
    }
  }, 20 * 60 * 1000);

  warmup().then(async () => {
    await backfill();
    await scan();
    setInterval(scan, 8000 + Math.random() * 2000);
  });
}

module.exports = startBSEListener;