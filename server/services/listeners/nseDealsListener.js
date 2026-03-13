const axios = require("axios");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const { saveEvent } = require("../../database");
const { persistRadar } = require("../../coordinator");

let ioRef = null;
const seen = new Set();
let nseCookie = "";

const NSE_HOME = "https://www.nseindia.com";
const NSE_API = "https://www.nseindia.com/api/corporate-announcements?index=equities";

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

function parseExchangeTs(timeStr) {
  if (!timeStr) return null;
  try {
    const d = new Date(timeStr);
    if (!isNaN(d)) return d.getTime();
  } catch {}
  return null;
}

function buildPdfUrl(attchmntFile) {
  if (!attchmntFile) return null;

  // remove any accidental nseindia.com prefix first
  attchmntFile = attchmntFile.replace(/^https?:\/\/www\.nseindia\.com/, "");

  // already a proper full URL
  if (attchmntFile.startsWith("https://") || attchmntFile.startsWith("http://")) return attchmntFile;

  // fix broken "https//..." without colon
  if (attchmntFile.startsWith("https//")) return attchmntFile.replace("https//", "https://");
  if (attchmntFile.startsWith("http//"))  return attchmntFile.replace("http//",  "http://");

  // relative path — prepend NSE base
  return `https://www.nseindia.com${attchmntFile}`;
}

async function warmup() {
  try {
    const res = await axios.get(NSE_HOME, {
      headers: BROWSER_HEADERS,
      timeout: 20000,
      maxRedirects: 5
    });
    const cookies = res.headers["set-cookie"];
    if (cookies && cookies.length) {
      nseCookie = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ NSE warmup successful");
    } else {
      console.log("⚠️ NSE warmup without cookies (continuing anyway)");
    }
    return true;
  } catch (err) {
    console.log("⚠️ NSE warmup failed:", err.message);
    return false;
  }
}

async function scan() {
  try {
    if (!nseCookie) await warmup();

    const res = await axios.get(NSE_API, {
      headers: {
        ...BROWSER_HEADERS,
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
        "Origin": "https://www.nseindia.com",
        "X-Requested-With": "XMLHttpRequest",
        ...(nseCookie ? { "Cookie": nseCookie } : {})
      },
      timeout: 20000
    });

    const list = Array.isArray(res.data) ? res.data : (res.data?.data || []);

    if (!list.length) {
      console.log("⚠️ NSE empty response");
      nseCookie = "";
      if (ioRef) ioRef.emit("nse_status", "disconnected");
      return;
    }

    console.log(`✅ NSE announcements: ${list.length}`);
    if (ioRef) ioRef.emit("nse_status", "connected");

    list.forEach(item => {
      const id = (item.symbol || "") + (item.an_dt || "") + (item.subject || "");
      if (!id || seen.has(id)) return;
      seen.add(id);

      const timeStr = item.an_dt || item.bcast_date || getIndianTime();
      const exchangeTs = parseExchangeTs(timeStr);

      const signal = {
        company: item.sm_name || item.symbol || "Unknown",
        code: item.symbol || "",
        type: "NEWS",
        title: item.subject || item.desc || "",
        value: 0,
        time: timeStr,
        ago: "just now",
        exchange: "NSE",
        savedAt: (exchangeTs && !isNaN(exchangeTs)) ? exchangeTs : Date.now(),
        pdfUrl: buildPdfUrl(item.attchmntFile)
      };

      saveEvent("nse", signal);

      updateRadar(signal.company, signal);
      const radar = getRadar();
      persistRadar(radar);

      if (ioRef) {
        ioRef.emit("nse_events", [signal]);
        ioRef.emit("radar_update", radar);
      }
    });

  } catch (err) {
    console.log("❌ NSE scan failed:", err.message);
    nseCookie = "";
    if (ioRef) ioRef.emit("nse_status", "disconnected");
  }
}

function startNSEDealsListener(io) {
  ioRef = io;
  warmup().then(() => scan());
  setInterval(scan, 8000 + Math.random() * 2000);
}

module.exports = startNSEDealsListener;