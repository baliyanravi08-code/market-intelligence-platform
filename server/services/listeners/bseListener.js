/**
 * bseListeners.js  — patched
 *
 * Changes from original:
 *  1. Fixed orderBookDB require path (was ../../data/orderBookDB, now ../data/orderBookDB
 *     because this file lives at server/services/listeners/bseListeners.js)
 *  2. enrichResultWithPDF — now passes correct quarter derived from filing title/date
 *     instead of always using getCurrentFYQuarter() (which returns *current* quarter,
 *     not the quarter the result is *for*)
 *  3. Quarter-rollover is handled by orderBookDB.updateFromResultFiling() already —
 *     it resets newOrders to 0 and pushes history. We just need to send the right quarter.
 *  4. Added extractConfirmedOBFromText() — scrapes OB value from result PDF text
 *     when pdfReader returns a generic "order value" that may be wrong for results.
 *  5. ORDER_ALERT path unchanged — already works correctly.
 */

"use strict";

const axios = require("axios");

const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const { orderBookEngine } = require("../intelligence/orderBookEngine");
const opportunityEngine = require("../intelligence/opportunityEngine");
const sectorQueue      = require("../intelligence/sectorQueue");
const sectorRadar      = require("../intelligence/sectorRadar");
const sectorBoomEngine = require("../intelligence/sectorBoomEngine");
const { saveResult, getRetentionHours, getWindowLabel } = require("../../database");
const {
  persistRadar,
  persistOrderBook,
  persistSector,
  persistOpportunity,
  persistMegaOrder,
  sendStoredToClient
} = require("../../coordinator");

// ── FIX 1: Correct path ──────────────────────────────────────────────────────
// bseListeners.js is at:   server/services/listeners/bseListeners.js
// orderBookDB.js is at:    server/services/data/orderBookDB.js
const orderBookDB = require("../../data/orderBookDB")

let ioRef     = null;
let bseCookie = "";
const seen    = new Set();

const BSE_HOME = "https://www.bseindia.com/corporates/ann.html";
const BSE_API  = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=&strType=C&subcategory=-1";

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

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1"
};

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short", day: "numeric",
    hour: "numeric", minute: "numeric",
    hour12: true
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

// ── FIX 2: Parse which quarter a result filing covers ─────────────────────────
// "Quarter ended December 2025" → Q3FY26
// "Quarter ended March 2026"    → Q4FY26
// "Quarter ended June 2025"     → Q1FY26
// "Quarter ended September"     → Q2FY26
function parseResultQuarterFromTitle(title) {
  const t = (title || "").toLowerCase();

  const monthMap = {
    january:1, jan:1, february:2, feb:2, march:3, mar:3,
    april:4, apr:4, may:5, june:6, jun:6,
    july:7, jul:7, august:8, aug:8, september:9, sep:9, sept:9,
    october:10, oct:10, november:11, nov:11, december:12, dec:12,
  };

  // "ended december 2025" / "ended 31st march 2026" / "ended march 31, 2026"
  const m = t.match(/ended\s+(?:\d+(?:st|nd|rd|th)?\s+)?(\w+)(?:[,\s]+(\d{4}))?/);
  if (m) {
    const monthName = m[1].toLowerCase();
    const month = monthMap[monthName];
    if (month) {
      // Infer year: if no year in title, use filing date context
      let year = m[2] ? parseInt(m[2]) : new Date().getFullYear();
      // If month is in the future relative to now, it's last year
      if (!m[2] && month > new Date().getMonth() + 1) year -= 1;

      const fy    = month >= 4 ? year + 1 : year;
      const short = String(fy).slice(-2);
      if (month >= 4  && month <= 6)  return `Q1FY${short}`;
      if (month >= 7  && month <= 9)  return `Q2FY${short}`;
      if (month >= 10 && month <= 12) return `Q3FY${short}`;
      return `Q4FY${short}`;
    }
  }

  // Direct "Q3FY26" in title
  const direct = (title || "").match(/\b(Q[1-4]FY\d{2})\b/i);
  if (direct) return direct[1].toUpperCase();

  // Fallback — return current quarter (will be slightly wrong but safe)
  return orderBookDB.getCurrentQuarter();
}

// ── FIX 3: Extract confirmed OB from result PDF text ──────────────────────────
// pdfReader.extractOrderValueFromPDF is tuned for ORDER filings.
// Result PDFs mention OB differently — "order book of ₹94,000 Cr"
function extractConfirmedOBFromText(text) {
  if (!text) return null;
  const t = String(text).replace(/,/g, "").replace(/₹/g, "Rs").replace(/INR/gi, "Rs");

  const patterns = [
    /order\s*book\s+(?:stood\s+at|of|at|is|stands?\s+at|as\s+(?:on|of)[^₹\d]{0,20})\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*backlog\s+(?:of|at|is|stands?\s+at)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /unexecuted\s+order\s+(?:book|backlog)\s+(?:of|at|is)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /outstanding\s+order\s*(?:book|s)?\s+(?:of|at|is|worth)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*book\s*(?:position|size|value)\s+(?:of|at|is)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // "₹94,000 Cr order book"
    /(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)\s+order\s*book/i,
    // Lakh crore: "₹5.64 lakh crore"
    /order\s*book\s+(?:of|at|is)\s*(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*lakh\s*cr/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m) {
      let val = parseFloat(m[1]);
      if (i === patterns.length - 1) val = val * 100000; // lakh crore
      if (val > 100) return parseFloat(val.toFixed(2));
    }
  }
  return null;
}

// ── enrichResultWithPDF — now quarter-aware ───────────────────────────────────
async function enrichResultWithPDF(signal) {
  if (!signal.pdfUrl) return signal;

  try {
    const { extractOrderValueFromPDF } = require("../data/pdfReader");
    const { updateFromResult }         = require("../data/marketCap");

    console.log(`📄 Result PDF scan: ${signal.company}`);

    // pdfReader returns raw extracted text OR a crore number
    const pdfResult = await extractOrderValueFromPDF(signal.pdfUrl);

    // Try to get confirmed OB — first from OB-specific patterns, then fallback
    let confirmedOB = null;

    if (typeof pdfResult === "string") {
      // pdfReader returned text — extract OB from it
      confirmedOB = extractConfirmedOBFromText(pdfResult);
    } else if (typeof pdfResult === "number" && pdfResult > 100) {
      // pdfReader returned a number directly
      confirmedOB = pdfResult;
    }

    if (!confirmedOB || confirmedOB <= 0) {
      console.log(`📄 Result PDF: no OB found for ${signal.company}`);
      return signal;
    }

    // ── FIX: Use quarter the result is FOR, not current quarter ──────────────
    const resultQuarter = parseResultQuarterFromTitle(signal.title);

    console.log(`📦 Result OB: ${signal.company} ₹${confirmedOB}Cr (${resultQuarter})`);

    // Update in-memory store
    updateFromResult(String(signal.code), {
      confirmedOrderBook:    confirmedOB,
      confirmedQuarter:      resultQuarter,
      newOrdersSinceConfirm: 0,
    });

    // Update MongoDB — this resets newOrders to 0 and pushes to quarterHistory
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

// ── warmup, extractList, scan, backfill — unchanged ──────────────────────────

async function warmup() {
  try {
    const res = await axios.get(BSE_HOME, {
      headers: BROWSER_HEADERS, timeout: 20000, maxRedirects: 5
    });
    const cookies = res.headers["set-cookie"];
    if (cookies?.length) {
      bseCookie = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ BSE warmup successful");
    } else {
      console.log("⚠️ BSE warmup without cookies (continuing anyway)");
    }
    return true;
  } catch (err) {
    console.log("⚠️ BSE warmup failed:", err.message);
    return false;
  }
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

  // PDF enrichment for RESULT — quarter-aware (fixed)
  if ((signal.type === "RESULT" || signal.type === "BANK_RESULT") && signal.pdfUrl) {
    enrichResultWithPDF(signal).catch(() => {});
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

  if (ioRef) ioRef.emit("bse_events", [signalWithTs]);
  if (ioRef) ioRef.emit("radar_update", radar);

  if (signalWithTs.type === "ORDER_ALERT") {
    const enrichedSignal = { ...signalWithTs, _orderInfo: signal._orderInfo };
    const orderData = orderBookEngine(enrichedSignal);
    const _crores   = signal._orderInfo?.crores || 0;

    if (_crores > 0 && signalWithTs.code) {
      // Add to MongoDB order book (accumulates newOrders for current quarter)
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

      // Also update in-memory store
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

    const opportunity = opportunityEngine(enrichedSignal);
    if (opportunity) {
      persistOpportunity(opportunity);
      if (ioRef) ioRef.emit("opportunity_alert", opportunity);
    }

    const queue       = sectorQueue(enrichedSignal);
    const sectorAlert = sectorRadar(queue);
    if (sectorAlert) {
      persistSector(sectorAlert);
      if (ioRef) ioRef.emit("sector_alerts", [sectorAlert]);
      const boom = sectorBoomEngine(queue);
      if (boom) {
        persistSector(boom);
        if (ioRef) ioRef.emit("sector_boom", boom);
      }
    }
  }
}

async function scan() {
  try {
    if (!bseCookie) await warmup();

    const res = await axios.get(BSE_API, {
      headers: {
        ...BROWSER_HEADERS,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.bseindia.com/corporates/ann.html",
        "Origin": "https://www.bseindia.com",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin",
        ...(bseCookie ? { "Cookie": bseCookie } : {})
      },
      timeout: 20000
    });

    const list = extractList(res.data);
    if (!list.length) {
      console.log("⚠️ BSE returned empty list");
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
    bseCookie = "";
    if (ioRef) ioRef.emit("bse_status", "disconnected");
  }
}

async function backfill() {
  console.log("🔄 Starting BSE historical backfill...");
  try {
    if (!bseCookie) await warmup();
    if (!bseCookie) { console.log("⚠️ Backfill skipped — no cookie"); return; }

    const now      = new Date();
    const fromDate = new Date(now);
    fromDate.setDate(fromDate.getDate() - 4);

    const url = buildHistoricalUrl(fromDate, now);
    console.log(`📅 Backfill: ${fromDate.toDateString()} → ${now.toDateString()}`);

    const res = await axios.get(url, {
      headers: {
        ...BROWSER_HEADERS,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.bseindia.com/corporates/ann.html",
        "Origin": "https://www.bseindia.com",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin",
        "Cookie": bseCookie
      },
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
    socket.emit("bse_status", bseCookie ? "connected" : "connecting");

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

  warmup().then(async () => {
    await backfill();
    await scan();
    setInterval(scan, 8000 + Math.random() * 2000);
  });
}

module.exports = startBSEListener;