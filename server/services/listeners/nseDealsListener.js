"use strict";

const axios = require("axios");
const analyzeAnnouncement = require("../analyzers/announcementAnalyzer");
const { updateRadar, getRadar } = require("../intelligence/radarEngine");
const { saveEvent } = require("../../database");
const { persistRadar } = require("../../coordinator");

let ioRef = null;
const seen = new Set();

const NSE_HOME     = "https://www.nseindia.com";
const NSE_EQUITY   = "https://www.nseindia.com/market-data/live-equity-market";
const NSE_FILINGS  = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const NSE_API      = "https://www.nseindia.com/api/corporate-announcements?index=equities";

// ── Cookie jar ────────────────────────────────────────────────────────────────
let cookieJar        = {};   // name → value map
let cookieString     = "";   // flat "k=v; k=v" string for headers
let lastWarmupAt     = 0;
let warmupInProgress = false;
let consecutiveFails = 0;
const MAX_FAILS      = 3;    // after this many fails, back off 5 min

// ── Axios client with shared defaults ─────────────────────────────────────────
const client = axios.create({ timeout: 25000 });

// Modern Chrome 123 on Windows — same UA across all requests
const BASE_HEADERS = {
  "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Language":    "en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding":    "gzip, deflate, br",
  "Connection":         "keep-alive",
  "Sec-Ch-Ua":          '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
  "Sec-Ch-Ua-Mobile":   "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
};

const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Cache-Control":             "max-age=0",
  "Sec-Fetch-Dest":            "document",
  "Sec-Fetch-Mode":            "navigate",
  "Sec-Fetch-Site":            "none",
  "Sec-Fetch-User":            "?1",
  "Upgrade-Insecure-Requests": "1",
};

const API_HEADERS = {
  ...BASE_HEADERS,
  "Accept":          "application/json, text/plain, */*",
  "Referer":         "https://www.nseindia.com/companies-listing/corporate-filings-announcements",
  "Origin":          "https://www.nseindia.com",
  "Sec-Fetch-Dest":  "empty",
  "Sec-Fetch-Mode":  "cors",
  "Sec-Fetch-Site":  "same-origin",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getIndianTime() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "short", day: "numeric",
    hour: "numeric", minute: "numeric",
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

// Parse Set-Cookie headers from a response and merge into jar
function absorbCookies(res) {
  const headers = res?.headers?.["set-cookie"] || [];
  let absorbed  = 0;
  for (const raw of headers) {
    const pair = raw.split(";")[0].trim();
    const eq   = pair.indexOf("=");
    if (eq < 1) continue;
    const name  = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) {
      cookieJar[name] = value;
      absorbed++;
    }
  }
  // Rebuild flat string
  cookieString = Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return absorbed;
}

function hasCookies() {
  return Object.keys(cookieJar).length > 0;
}

// ── Warmup — simulate real browser navigation ─────────────────────────────────
async function warmup() {
  if (warmupInProgress) return;

  // Back off after repeated failures
  if (consecutiveFails >= MAX_FAILS) {
    const backoffMs = 5 * 60 * 1000;
    if (Date.now() - lastWarmupAt < backoffMs) return;
    console.log("🔄 NSE back-off elapsed — retrying warmup");
  }

  // Don't re-warmup if session is fresh (< 20 min old) and working
  if (hasCookies() && Date.now() - lastWarmupAt < 20 * 60 * 1000) return;

  warmupInProgress = true;
  cookieJar        = {};   // reset jar for fresh session
  cookieString     = "";

  try {
    // Step 1: Homepage — gets initial session + nseappid cookie
    console.log("🔌 NSE session: hitting homepage...");
    const home = await client.get(NSE_HOME, {
      headers: PAGE_HEADERS,
      validateStatus: () => true,
      maxRedirects: 5,
    });
    absorbCookies(home);
    await sleep(2000 + Math.random() * 1000);

    // Step 2: Live equity market page — triggers nsit cookie
    const equity = await client.get(NSE_EQUITY, {
      headers: { ...PAGE_HEADERS, "Referer": NSE_HOME, "Sec-Fetch-Site": "same-origin" },
      validateStatus: () => true,
    });
    absorbCookies(equity);
    await sleep(1500 + Math.random() * 800);

    // Step 3: Corporate filings page — required before API call works
    const filings = await client.get(NSE_FILINGS, {
      headers: { ...PAGE_HEADERS, "Referer": NSE_EQUITY, "Sec-Fetch-Site": "same-origin" },
      validateStatus: () => true,
    });
    absorbCookies(filings);
    await sleep(1000 + Math.random() * 500);

    if (hasCookies()) {
      lastWarmupAt     = Date.now();
      consecutiveFails = 0;
      console.log(`✅ NSE session established (${Object.keys(cookieJar).length} cookies)`);
    } else {
      consecutiveFails++;
      console.log(`⚠️ NSE warmup: no cookies received (attempt ${consecutiveFails}/${MAX_FAILS})`);
    }

  } catch (err) {
    consecutiveFails++;
    lastWarmupAt = Date.now(); // prevent hammering
    console.log(`⚠️ NSE warmup error: ${err.message} (fail ${consecutiveFails}/${MAX_FAILS})`);
  } finally {
    warmupInProgress = false;
  }
}

// ── Scan announcements ────────────────────────────────────────────────────────
async function scan() {
  // Ensure we have a session before hitting the API
  if (!hasCookies()) {
    await warmup();
    if (!hasCookies()) {
      // Still no cookies — skip this cycle silently (no spam)
      return;
    }
  }

  try {
    const res = await client.get(NSE_API, {
      headers: {
        ...API_HEADERS,
        "Cookie": cookieString,
      },
      validateStatus: () => true,
    });

    // Absorb any refreshed cookies
    absorbCookies(res);

    if (res.status === 403 || res.status === 401) {
      console.log(`⚠️ NSE API blocked (${res.status}) — refreshing session`);
      cookieJar        = {};
      cookieString     = "";
      lastWarmupAt     = 0;
      consecutiveFails++;
      if (ioRef) ioRef.emit("nse_status", "disconnected");
      return;
    }

    if (res.status !== 200) {
      console.log(`⚠️ NSE API unexpected status: ${res.status}`);
      return;
    }

    const list = Array.isArray(res.data)
      ? res.data
      : res.data?.data || [];

    if (!list.length) {
      console.log("⚠️ NSE empty response");
      return;
    }

    consecutiveFails = 0;
    console.log(`✅ NSE announcements: ${list.length}`);
    if (ioRef) ioRef.emit("nse_status", "connected");

    for (const item of list) {
      const id =
        (item.symbol  || "") +
        (item.an_dt   || "") +
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

        saveEvent("nse", signal);
        updateRadar(signal.company, signal);

        const { persistMegaOrder } = require("../../coordinator");
        persistMegaOrder(signal);

        const radar = getRadar();
        persistRadar(radar);

        if (ioRef) {
          ioRef.emit("nse_events",   [signal]);
          ioRef.emit("radar_update", radar);
        }
      } catch (e) {
        console.log("⚠️ NSE item error:", e.message);
      }
    }

  } catch (err) {
    console.log("❌ NSE scan failed:", err.message);
    consecutiveFails++;

    if (err.response?.status === 403 || err.response?.status === 401) {
      console.log("🔄 NSE session expired — will re-warmup next cycle");
      cookieJar        = {};
      cookieString     = "";
      lastWarmupAt     = 0;
    }

    if (ioRef) ioRef.emit("nse_status", "disconnected");
  }
}

// ── Start listener ────────────────────────────────────────────────────────────
function startNSEDealsListener(io) {
  ioRef = io;

  // Warmup → wait → first scan
  warmup().then(async () => {
    await sleep(3000);
    await scan();
  });

  // Scan every 15s
  setInterval(scan, 15000);

  // Proactive session refresh every 18 minutes
  setInterval(() => {
    console.log("🔄 NSE proactive session refresh");
    cookieJar        = {};
    cookieString     = "";
    lastWarmupAt     = 0;
    warmup().catch(() => {});
  }, 18 * 60 * 1000);
}

module.exports = startNSEDealsListener;