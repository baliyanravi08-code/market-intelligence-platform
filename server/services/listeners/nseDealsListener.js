const axios = require("axios");
const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const { saveEvent } = require("../../database");
const { persistRadar } = require("../../coordinator");

let ioRef = null;
const seen = new Set();

/* ───────────────────────────── */
/* NSE URLS */
/* ───────────────────────────── */

const NSE_HOME = "https://www.nseindia.com";
const NSE_API =
  "https://www.nseindia.com/api/corporate-announcements?index=equities";

/* ───────────────────────────── */
/* Axios client (important) */
/* ───────────────────────────── */

const client = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: "https://www.nseindia.com/",
    Origin: "https://www.nseindia.com",
    Connection: "keep-alive"
  }
});

let cookie = "";

/* ───────────────────────────── */
/* Helpers */
/* ───────────────────────────── */

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: true
  });
}

function parseExchangeTs(timeStr) {
  try {
    const d = new Date(timeStr);
    if (!isNaN(d)) return d.getTime();
  } catch {}
  return Date.now();
}

function buildPdfUrl(attchmntFile) {
  if (!attchmntFile) return null;

  if (attchmntFile.startsWith("http")) return attchmntFile;

  if (attchmntFile.includes("nsearchives"))
    return `https://${attchmntFile}`;

  return `https://www.nseindia.com${attchmntFile}`;
}

/* ───────────────────────────── */
/* Warmup (get cookies) */
/* ───────────────────────────── */

async function warmup() {
  try {

    const home = await client.get(
      "https://www.nseindia.com",
      { validateStatus: () => true }
    );

    const page = await client.get(
      "https://www.nseindia.com/market-data/live-equity-market",
      { validateStatus: () => true }
    );

    const cookies = [
      ...(home.headers["set-cookie"] || []),
      ...(page.headers["set-cookie"] || [])
    ];

    if (cookies.length) {

      cookie = cookies
        .map(c => c.split(";")[0])
        .join("; ");

      client.defaults.headers.Cookie = cookie;

      console.log("✅ NSE session established");

    } else {

      console.log("⚠️ NSE still blocked (no cookies)");

    }

  } catch (err) {

    console.log("⚠️ NSE warmup failed:", err.message);

  }
}

/* ───────────────────────────── */
/* Scan announcements */
/* ───────────────────────────── */

async function scan() {
  try {
    if (!cookie) await warmup();

    const res = await client.get(NSE_API);

    const list = Array.isArray(res.data)
      ? res.data
      : res.data?.data || [];

    if (!list.length) {
      console.log("⚠️ NSE empty response");
      return;
    }

    console.log(`✅ NSE announcements: ${list.length}`);

    if (ioRef) ioRef.emit("nse_status", "connected");

    for (const item of list) {
      const id =
        (item.symbol || "") +
        (item.an_dt || "") +
        (item.subject || "");

      if (!id || seen.has(id)) continue;
      seen.add(id);

      const timeStr = item.an_dt || getIndianTime();

      try {
        const analyzed = await analyzeAnnouncement({
          company: item.sm_name || item.symbol || "Unknown",
          code: item.symbol || "",
          title: item.subject || item.desc || "",
          value: 0,
          time: timeStr,
          ago: "just now",
          exchange: "NSE",
          pdfUrl: buildPdfUrl(item.attchmntFile)
        });

        const signal = {
          ...(analyzed || {
            company: item.sm_name || item.symbol,
            type: "NEWS",
            title: item.subject || "",
            value: 0,
            exchange: "NSE"
          }),
          savedAt: parseExchangeTs(timeStr)
        };

        saveEvent("nse", signal);

        updateRadar(signal.company, signal);

        const radar = getRadar();

        persistRadar(radar);

        if (ioRef) {
          ioRef.emit("nse_events", [signal]);
          ioRef.emit("radar_update", radar);
        }
      } catch (e) {
        console.log("⚠️ NSE item error:", e.message);
      }
    }
  } catch (err) {
    console.log("❌ NSE scan failed:", err.message);

    if (err.response?.status === 403) {
      console.log("⚠️ NSE session expired → refreshing cookie");
      cookie = "";
      await warmup();
    }

    if (ioRef) ioRef.emit("nse_status", "disconnected");
  }
}

/* ───────────────────────────── */
/* Start listener */
/* ───────────────────────────── */

function startNSEDealsListener(io) {
  ioRef = io;

  warmup().then(() => scan());

  setInterval(scan, 15000);
}

module.exports = startNSEDealsListener;