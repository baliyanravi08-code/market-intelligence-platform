const axios = require("axios");
const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const { saveEvent } = require("../../database");
const { persistRadar } = require("../../coordinator");

let ioRef = null;
const seen = new Set();

/* ───────────────────────────── */
/* NSE URLS                      */
/* ───────────────────────────── */

const NSE_API =
  "https://www.nseindia.com/api/corporate-announcements?index=equities";

/* ───────────────────────────── */
/* Axios client                  */
/* ───────────────────────────── */

const client = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.nseindia.com/",
    "Origin":          "https://www.nseindia.com",
    "Connection":      "keep-alive",
    "sec-ch-ua":       '"Chromium";v="122", "Not(A:Brand";v="24"',
    "sec-ch-ua-mobile":"?0",
    "sec-fetch-dest":  "empty",
    "sec-fetch-mode":  "cors",
    "sec-fetch-site":  "same-origin"
  }
});

let cookie = "";
let warmupInProgress = false;

/* ───────────────────────────── */
/* Helpers                       */
/* ───────────────────────────── */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

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
  if (attchmntFile.includes("nsearchives")) return `https://${attchmntFile}`;
  return `https://www.nseindia.com${attchmntFile}`;
}

function extractCookies(responses) {
  const all = [];
  for (const res of responses) {
    const h = res?.headers?.["set-cookie"] || [];
    all.push(...h);
  }
  if (!all.length) return "";
  return all.map(c => c.split(";")[0]).join("; ");
}

/* ───────────────────────────── */
/* Warmup — hit pages in order   */
/* with delays between requests  */
/* ───────────────────────────── */

async function warmup() {
  if (warmupInProgress) return;
  warmupInProgress = true;

  try {
    // Step 1: Hit homepage — establishes initial session
    const home = await client.get("https://www.nseindia.com", {
      validateStatus: () => true
    });
    await sleep(2500);

    // Step 2: Hit live equity market page — triggers session cookie
    const equityPage = await client.get(
      "https://www.nseindia.com/market-data/live-equity-market",
      { validateStatus: () => true }
    );
    await sleep(2000);

    // Step 3: Hit corporate filings page — required before API call
    const filingsPage = await client.get(
      "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
      { validateStatus: () => true }
    );
    await sleep(1500);

    // Collect cookies from all 3 responses
    const extracted = extractCookies([home, equityPage, filingsPage]);

    if (extracted) {
      cookie = extracted;
      client.defaults.headers["Cookie"] = cookie;
      console.log("✅ NSE session established");
    } else {
      console.log("⚠️ NSE still blocked (no cookies)");
    }

  } catch (err) {
    console.log("⚠️ NSE warmup failed:", err.message);
  } finally {
    warmupInProgress = false;
  }
}

/* ───────────────────────────── */
/* Scan announcements            */
/* ───────────────────────────── */

async function scan() {
  try {
    if (!cookie) {
      await warmup();
      // If still no cookie after warmup, skip this cycle
      if (!cookie) return;
    }

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
        (item.an_dt  || "") +
        (item.subject || "");

      if (!id || seen.has(id)) continue;
      seen.add(id);

      const timeStr = item.an_dt || getIndianTime();

      try {
        const analyzed = await analyzeAnnouncement({
          company: item.sm_name || item.symbol || "Unknown",
          code:    item.symbol  || "",
          title:   item.subject || item.desc || "",
          value:   0,
          time:    timeStr,
          ago:     "just now",
          exchange:"NSE",
          pdfUrl:  buildPdfUrl(item.attchmntFile)
        });

        const signal = {
          ...(analyzed || {
            company:  item.sm_name || item.symbol,
            type:     "NEWS",
            title:    item.subject || "",
            value:    0,
            exchange: "NSE"
          }),
          savedAt:    Date.now(),
          receivedAt: Date.now()
        };

        // ── FIXED: saveEvent now exists in database.js (was undefined before) ──
        saveEvent("nse", signal);

        updateRadar(signal.company, signal);

        const { persistMegaOrder } = require("../../coordinator");
        persistMegaOrder(signal);

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
      client.defaults.headers["Cookie"] = "";
      // Wait 5s before retrying to avoid hammering NSE
      await sleep(5000);
      await warmup();
    }

    if (ioRef) ioRef.emit("nse_status", "disconnected");
  }
}

/* ───────────────────────────── */
/* Start listener                */
/* ───────────────────────────── */

function startNSEDealsListener(io) {
  ioRef = io;

  // Initial warmup then scan
  warmup().then(() => {
    // Wait a bit after warmup before first scan
    setTimeout(() => scan(), 3000);
  });

  // Scan every 15s
  setInterval(scan, 15000);

  // Re-warmup every 25 minutes to keep session alive
  setInterval(() => {
    console.log("🔄 NSE session refresh (scheduled)");
    cookie = "";
    client.defaults.headers["Cookie"] = "";
    warmup();
  }, 25 * 60 * 1000);
}

module.exports = startNSEDealsListener;