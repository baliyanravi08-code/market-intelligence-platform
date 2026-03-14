const axios = require("axios");

const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const orderBookEngine = require("../intelligence/orderBookEngine");
const opportunityEngine = require("../intelligence/opportunityEngine");
const sectorQueue = require("../intelligence/sectorQueue");
const sectorRadar = require("../intelligence/sectorRadar");
const sectorBoomEngine = require("../intelligence/sectorBoomEngine");
const { saveResult } = require("../../database");
const { persistRadar, persistOrderBook, persistSector, persistOpportunity } = require("../../coordinator");

let ioRef = null;
let bseCookie = "";
const seen = new Set();

const BSE_HOME = "https://www.bseindia.com/corporates/ann.html";
const BSE_API = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=&strType=C&subcategory=-1";

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
  if (seconds < 60) return `${seconds}s ago`;
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

async function warmup() {
  try {
    const res = await axios.get(BSE_HOME, {
      headers: BROWSER_HEADERS,
      timeout: 20000,
      maxRedirects: 5
    });
    const cookies = res.headers["set-cookie"];
    if (cookies && cookies.length) {
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
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.Table)) return data.Table;
  if (Array.isArray(data.Table1)) return data.Table1;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.Data)) return data.Data;
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key]) && data[key].length > 0) return data[key];
  }
  return [];
}

function processItem(item) {
  const id = String(item.SCRIP_CD || "") + (item.HEADLINE || "");
  if (!id || seen.has(id)) return;
  seen.add(id);

  const signal = analyzeAnnouncement({
    company: item.SLONGNAME || item.companyname || "Unknown",
    code: String(item.SCRIP_CD || ""),
    title: item.HEADLINE || "",
    time: item.DT_TM || item.NEWS_DT || getIndianTime(),
    ago: getTimeAgo(new Date()),
    exchange: "BSE",
    pdfUrl: item.ATTACHMENTNAME
      ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`
      : null
  });

  if (!signal) return;

  const exchangeTs = parseExchangeTs(signal.time);
  const signalWithTs = { ...signal, savedAt: (exchangeTs && !isNaN(exchangeTs)) ? exchangeTs : Date.now() };

  saveResult(signalWithTs);

  updateRadar(signalWithTs.company, signalWithTs);
  const radar = getRadar();
  persistRadar(radar);

  if (ioRef) ioRef.emit("bse_events", [signalWithTs]);
  if (ioRef) ioRef.emit("radar_update", radar);

  if (signalWithTs.type === "ORDER_ALERT") {
    const enrichedSignal = { ...signalWithTs, _orderInfo: signal._orderInfo };

    // Order book tracking
    const orderData = orderBookEngine(enrichedSignal);
    if (orderData) {
      persistOrderBook(orderData);
      if (ioRef) ioRef.emit("order_book_update", orderData);

      // 🚨 MEGA ORDER — ₹1000Cr+ or 5%+ of MCap or frequency alert
      if (orderData.isMegaOrder || orderData.isMcapAlert || orderData.isFrequencyAlert) {
        if (ioRef) ioRef.emit("mega_order_alert", {
          company: orderData.company,
          crores: orderData.orderValue,
          years: orderData.years,
          periodLabel: orderData.periodLabel,
          annualCrores: orderData.annualCrores,
          mcapRatio: orderData.mcapRatio,
          quarterBook: orderData.quarterBook,
          quarterOrders: orderData.quarterOrders,
          totalOrderBook: orderData.totalOrderBook,
          alertLevel: orderData.alertLevel,
          title: signalWithTs.title,
          pdfUrl: signalWithTs.pdfUrl,
          time: signalWithTs.time,
          receivedAt: Date.now()
        });
      }
    }

    // Opportunity engine
    const opportunity = opportunityEngine(enrichedSignal);
    if (opportunity) {
      persistOpportunity(opportunity);
      if (ioRef) ioRef.emit("opportunity_alert", opportunity);
    }

    // Sector tracking
    const queue = sectorQueue(enrichedSignal);
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
    list.forEach(processItem);

  } catch (err) {
    console.log("❌ BSE fetch failed:", err.message);
    bseCookie = "";
    if (ioRef) ioRef.emit("bse_status", "disconnected");
  }
}

function startBSEListener(io) {
  ioRef = io;

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);
    socket.emit("bse_status", "connecting");
    socket.emit("radar_update", getRadar());
  });

  warmup().then(() => scan());
  setInterval(scan, 8000 + Math.random() * 2000);
}

module.exports = startBSEListener;