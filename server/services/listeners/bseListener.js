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

let ioRef     = null;
let bseCookie = "";
const seen    = new Set();

const BSE_HOME = "https://www.bseindia.com/corporates/ann.html";
const BSE_API  = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?strCat=-1&strPrevDate=&strScrip=&strSearch=P&strToDate=&strType=C&subcategory=-1";

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

  // ── PDF enrichment for ORDER_ALERT with no crore value ──
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

  const exchangeTs   = parseExchangeTs(signal.time);
  const signalWithTs = {
    ...signal,
    savedAt: (exchangeTs && !isNaN(exchangeTs)) ? exchangeTs : Date.now()
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
          quarterBook:    orderData.quarterBook,
          quarterOrders:  orderData.quarterOrders,
          totalOrderBook: orderData.totalOrderBook,
          alertLevel:     orderData.alertLevel,
          title:          signalWithTs.title,
          pdfUrl:         signalWithTs.pdfUrl,
          time:           signalWithTs.time,
          receivedAt:     Date.now()
        };
        // ── Persist mega order so it survives refresh ──
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

    // ── Send stored orderBook, sectors, mega orders, opportunities ──
    sendStoredToClient(socket);
  });

  warmup().then(async () => {
    await backfill();
    await scan();
    setInterval(scan, 8000 + Math.random() * 2000);
  });
}

module.exports = startBSEListener;