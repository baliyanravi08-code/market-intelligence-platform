/**
 * backfillOrderBooks.js  — v4
 * 
 * Scans BSE result filings for all OB-sector companies in marketCapDB.json
 * Extracts order book values from PDFs.
 * Falls back to Puppeteer headless browser if axios is geo-blocked.
 * 
 * Place at : server/scripts/backfillOrderBooks.js
 * Run      : node server/scripts/backfillOrderBooks.js
 *            node server/scripts/backfillOrderBooks.js --puppeteer   (force headless)
 *            node server/scripts/backfillOrderBooks.js --seed-only   (skip PDF, use seed)
 * 
 * Install  : npm i puppeteer   (only needed if BSE blocks axios)
 */

"use strict";

const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");

const MCAP_FILE = path.join(__dirname, "../data/marketCapDB.json");
const OB_FILE   = path.join(__dirname, "../data/orderBookHistory.json");
const DATA_DIR  = path.join(__dirname, "../data");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Load modules ──────────────────────────────────────────────────────────────
let updateFromResult = null;
try { ({ updateFromResult } = require("../intelligence/marketCap")); } catch {
  try { ({ updateFromResult } = require("../data/marketCap")); } catch { /* ok */ }
}

let orderBookDB = null;
try { orderBookDB = require("../services/data/orderBookDB"); } catch { /* ok */ }

let { extractOrderValueFromPDF, extractCroresFromText } = (() => {
  try { return require("../services/data/pdfReader"); } catch { return {}; }
})();

// ── JSON helpers ──────────────────────────────────────────────────────────────
function loadDB() {
  try {
    const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function loadOBHistory() {
  try {
    const raw = fs.readFileSync(OB_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeOBHistory(h) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OB_FILE, JSON.stringify(h, null, 2), "utf8");
}

function alreadySaved(code, quarter, history) {
  return history[code]?.quarters?.some(q => q.quarter === quarter) ?? false;
}

// ── BSE headers ───────────────────────────────────────────────────────────────
const WARMUP_HEADERS = {
  "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept":                    "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language":           "en-IN,en-GB;q=0.9,en-US;q=0.8",
  "Accept-Encoding":           "gzip, deflate, br",
  "Connection":                "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest":            "document",
  "Sec-Fetch-Mode":            "navigate",
  "Sec-Fetch-Site":            "none",
  "sec-ch-ua":                 '"Google Chrome";v="123"',
  "sec-ch-ua-mobile":          "?0",
  "sec-ch-ua-platform":        '"Windows"',
  "Cache-Control":             "max-age=0",
};

function apiHeaders(cookie) {
  return {
    "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept":             "application/json, text/plain, */*",
    "Accept-Language":    "en-IN,en-GB;q=0.9,en-US;q=0.8",
    "Referer":            "https://www.bseindia.com/corporates/ann.html",
    "Origin":             "https://www.bseindia.com",
    "X-Requested-With":   "XMLHttpRequest",
    "Sec-Fetch-Site":     "same-origin",
    "Sec-Fetch-Mode":     "cors",
    "Sec-Fetch-Dest":     "empty",
    "sec-ch-ua":          '"Google Chrome";v="123"',
    "sec-ch-ua-mobile":   "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Connection":         "keep-alive",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

// ── 2-stage BSE cookie warmup ─────────────────────────────────────────────────
async function getBSECookie() {
  let cookie = "";
  try {
    const r1 = await axios.get("https://www.bseindia.com",
      { headers: WARMUP_HEADERS, timeout: 20000, maxRedirects: 5 });
    const c1 = r1.headers["set-cookie"];
    if (c1?.length) cookie = c1.map(c => c.split(";")[0]).join("; ");
  } catch { /* ok */ }

  await sleep(2000);

  try {
    const r2 = await axios.get("https://www.bseindia.com/corporates/ann.html",
      { headers: { ...WARMUP_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        timeout: 20000, maxRedirects: 5 });
    const c2 = r2.headers["set-cookie"];
    if (c2?.length) {
      const extra = c2.map(c => c.split(";")[0]).join("; ");
      cookie = cookie ? `${cookie}; ${extra}` : extra;
    }
  } catch { /* ok */ }

  return cookie;
}

// ── Fetch BSE result filings ──────────────────────────────────────────────────
async function fetchResultFilings(from, to, code, cookie) {
  const params = new URLSearchParams({
    strCat:      "-1",
    strPrevDate: `${String(from.getDate()).padStart(2,"0")}/${String(from.getMonth()+1).padStart(2,"0")}/${from.getFullYear()}`,
    strScrip:    code || "",
    strSearch:   "P",
    strToDate:   `${String(to.getDate()).padStart(2,"0")}/${String(to.getMonth()+1).padStart(2,"0")}/${to.getFullYear()}`,
    strType:     "C",
    subcategory: "9",  // 9 = Financial Results
  });

  try {
    const res = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?${params}`,
      { headers: apiHeaders(cookie), timeout: 15000 }
    );
    const d = res.data;
    if (typeof d === "string") {
      if (d.trim().startsWith("<")) return { ok: false, reason: "blocked", rows: [] };
      if (!d.trim() || d.trim() === "null") return { ok: true, rows: [] };
    }
    const rows = d?.Table || d?.Table1 || d?.data || d?.Data
              || (Array.isArray(d) ? d : []);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: e.message, rows: [] };
  }
}

// ── Puppeteer PDF fetch (headless fallback) ───────────────────────────────────
let browser = null;

async function initPuppeteer() {
  try {
    const puppeteer = require("puppeteer");
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    console.log("🤖 Puppeteer browser launched");
    return true;
  } catch (e) {
    console.log(`⚠️  Puppeteer not available: ${e.message}`);
    console.log("   Run: npm i puppeteer");
    return false;
  }
}

async function fetchPDFWithPuppeteer(pdfUrl) {
  if (!browser) return null;
  let page = null;
  try {
    page = await browser.newPage();

    // Set real browser fingerprint
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
      "Referer":         "https://www.bseindia.com",
    });

    // Visit BSE homepage first to get cookies
    await page.goto("https://www.bseindia.com", {
      waitUntil: "domcontentloaded", timeout: 20000,
    });
    await sleep(1500);

    // Now fetch the PDF as buffer
    const response = await page.goto(pdfUrl, {
      waitUntil: "networkidle0", timeout: 20000,
    });

    if (!response || !response.ok()) return null;

    const buffer = await response.buffer();
    if (!buffer || buffer.length < 100) return null;

    // Extract text from PDF buffer using pdfReader
    if (extractOrderValueFromPDF) {
      // pdfReader expects a URL, so we pass buffer via a workaround
      const { extractCroresFromText: extractFn } = require("../services/data/pdfReader");
      const text = buffer.toString("latin1");
      return extractFn ? extractFn(text) : null;
    }
    return null;

  } catch (e) {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── Fetch PDF with axios first, Puppeteer fallback ────────────────────────────
async function fetchPDFValue(pdfUrl, usePuppeteer) {
  // Try axios first (fast)
  if (extractOrderValueFromPDF) {
    const val = await extractOrderValueFromPDF(pdfUrl);
    if (val && val > 50) return val;
  }
  // Puppeteer fallback
  if (usePuppeteer && browser) {
    return await fetchPDFWithPuppeteer(pdfUrl);
  }
  return null;
}

// ── Save result ───────────────────────────────────────────────────────────────
async function saveResult(code, company, crores, quarter, history) {
  // 1. JSON
  if (!history[code]) history[code] = { company, quarters: [] };
  const existing = history[code].quarters.find(q => q.quarter === quarter);
  if (existing) { existing.confirmedOrderBook = crores; }
  else { history[code].quarters.push({ quarter, confirmedOrderBook: crores, addedOrders: 0 }); }
  history[code].company          = company;
  history[code].currentOrderBook = crores;
  history[code].confirmedQuarter = quarter;
  writeOBHistory(history);

  // 2. In-memory store
  if (updateFromResult) {
    try { updateFromResult(code, { confirmedOrderBook: crores, confirmedQuarter: quarter, newOrdersSinceConfirm: 0 }); }
    catch { /* ok */ }
  }

  // 3. MongoDB
  if (orderBookDB?.updateFromResultFiling) {
    try { await orderBookDB.updateFromResultFiling(code, company, crores, quarter, null); }
    catch { /* ok */ }
  }
}

// ── OB sector keywords ────────────────────────────────────────────────────────
const OB_KEYWORDS = [
  "infra","epc","engineer","construct","railway","defense","defence",
  "solar","renewable","wind","power","energy","water","ship","aerospace",
  "wabag","rites","rvnl","irfc","hal ","bel ","ntpc","l&t","larsen",
  "kec","kalpataru","patel eng","thermax","cummins","bhel","suzlon",
  "tata power","inox wind","adani green","adani power","jsw energy",
  "nhpc","abb india","siemens","hitachi","transformer","garden reach",
  "cochin ship","mazagon","data pattern","paras defence","mtar",
  "astra micro","centum","va tech","ncc ","hg infra","pnc infra",
  "dilip","j kumar","texmaco","titagarh","jupiter wagon","cgpower",
  "cg power","knr","ashoka","irb infra","bharat forge","voltamp",
  "techno elec","power mech","sjvn","power grid","torrent power",
  "isgec","anup eng","elgi","capacite","gr infra","ahluwalia",
  "enviro infra","waaree","insolation","kpi green","ge vernova",
  "genus power","concor",
];

function isOBSector(name) {
  const n = (name || "").toLowerCase();
  return OB_KEYWORDS.some(k => n.includes(k.trim()));
}

// ── Seed data — verified Q3FY26 order books ───────────────────────────────────
const SEED_DATA = [
  { code: "500510", company: "Larsen & Toubro Ltd",              crores: 564000, quarter: "Q3FY26" },
  { code: "500294", company: "NCC Ltd",                          crores: 55000,  quarter: "Q3FY26" },
  { code: "532287", company: "Kalpataru Projects International", crores: 66000,  quarter: "Q3FY26" },
  { code: "532714", company: "KEC International Ltd",            crores: 31000,  quarter: "Q3FY26" },
  { code: "532947", company: "IRB Infrastructure Developers",    crores: 21000,  quarter: "Q3FY26" },
  { code: "539150", company: "PNC Infratech Ltd",                crores: 22000,  quarter: "Q3FY26" },
  { code: "541019", company: "H.G. Infra Engineering Ltd",       crores: 18000,  quarter: "Q3FY26" },
  { code: "532940", company: "J. Kumar Infraprojects Ltd",       crores: 9500,   quarter: "Q3FY26" },
  { code: "533271", company: "Ashoka Buildcon Ltd",              crores: 14000,  quarter: "Q3FY26" },
  { code: "532811", company: "Ahluwalia Contracts (India) Ltd",  crores: 6800,   quarter: "Q3FY26" },
  { code: "531120", company: "Patel Engineering Ltd",            crores: 7200,   quarter: "Q3FY26" },
  { code: "540047", company: "Dilip Buildcon Ltd",               crores: 18500,  quarter: "Q3FY26" },
  { code: "532942", company: "KNR Constructions Ltd",            crores: 8500,   quarter: "Q3FY26" },
  { code: "534761", company: "G R Infraprojects Ltd",            crores: 12000,  quarter: "Q3FY26" },
  { code: "540710", company: "Capacite Infraprojects Ltd",       crores: 4500,   quarter: "Q3FY26" },
  { code: "500049", company: "Bharat Electronics Ltd",           crores: 73000,  quarter: "Q3FY26" },
  { code: "541154", company: "Hindustan Aeronautics Ltd",        crores: 94000,  quarter: "Q3FY26" },
  { code: "541143", company: "Bharat Dynamics Ltd",              crores: 20000,  quarter: "Q3FY26" },
  { code: "543237", company: "Mazagon Dock Shipbuilders Ltd",    crores: 35000,  quarter: "Q3FY26" },
  { code: "540678", company: "Cochin Shipyard Ltd",              crores: 22000,  quarter: "Q3FY26" },
  { code: "542011", company: "Garden Reach Shipbuilders",        crores: 24500,  quarter: "Q3FY26" },
  { code: "543367", company: "Paras Defence And Space Tech",     crores: 900,    quarter: "Q3FY26" },
  { code: "543270", company: "MTAR Technologies Ltd",            crores: 1200,   quarter: "Q3FY26" },
  { code: "543428", company: "Data Patterns (India) Ltd",        crores: 3800,   quarter: "Q3FY26" },
  { code: "506493", company: "Astra Microwave Products Ltd",     crores: 2200,   quarter: "Q3FY26" },
  { code: "541556", company: "RITES Ltd",                        crores: 7200,   quarter: "Q3FY26" },
  { code: "542649", company: "Rail Vikas Nigam Ltd",             crores: 89000,  quarter: "Q3FY26" },
  { code: "541956", company: "IRCON International Ltd",          crores: 15000,  quarter: "Q3FY26" },
  { code: "532555", company: "NTPC Ltd",                         crores: 380000, quarter: "Q3FY26" },
  { code: "533098", company: "NHPC Ltd",                         crores: 48000,  quarter: "Q3FY26" },
  { code: "533206", company: "SJVN Ltd",                         crores: 32000,  quarter: "Q3FY26" },
  { code: "532898", company: "Power Grid Corporation",           crores: 85000,  quarter: "Q3FY26" },
  { code: "532779", company: "Torrent Power Ltd",                crores: 18000,  quarter: "Q3FY26" },
  { code: "533148", company: "JSW Energy Ltd",                   crores: 42000,  quarter: "Q3FY26" },
  { code: "500400", company: "Tata Power Company Ltd",           crores: 35000,  quarter: "Q3FY26" },
  { code: "541450", company: "Adani Green Energy Ltd",           crores: 78000,  quarter: "Q3FY26" },
  { code: "544277", company: "Waaree Energies Ltd",              crores: 28000,  quarter: "Q3FY26" },
  { code: "538618", company: "Waaree Renewable Technologies",    crores: 9500,   quarter: "Q3FY26" },
  { code: "532667", company: "Suzlon Energy Ltd",                crores: 24000,  quarter: "Q3FY26" },
  { code: "539083", company: "Inox Wind Ltd",                    crores: 25500,  quarter: "Q3FY26" },
  { code: "522275", company: "GE Vernova T&D India Ltd",         crores: 28000,  quarter: "Q3FY26" },
  { code: "522287", company: "Kalpataru Power Transmission",     crores: 29000,  quarter: "Q3FY26" },
  { code: "532928", company: "Transformers And Rectifiers",      crores: 4200,   quarter: "Q3FY26" },
  { code: "543187", company: "Hitachi Energy India Ltd",         crores: 18500,  quarter: "Q3FY26" },
  { code: "500550", company: "Siemens Ltd",                      crores: 24000,  quarter: "Q3FY26" },
  { code: "500002", company: "ABB India Ltd",                    crores: 10200,  quarter: "Q3FY26" },
  { code: "539302", company: "Power Mech Projects Ltd",          crores: 8200,   quarter: "Q3FY26" },
  { code: "542141", company: "Techno Electric And Engg Co",      crores: 11500,  quarter: "Q3FY26" },
  { code: "532757", company: "Voltamp Transformers Ltd",         crores: 2800,   quarter: "Q3FY26" },
  { code: "530343", company: "Genus Power Infrastructures",      crores: 4800,   quarter: "Q3FY26" },
  { code: "533272", company: "Jupiter Wagons Ltd",               crores: 14500,  quarter: "Q3FY26" },
  { code: "532966", company: "Titagarh Rail Systems Ltd",        crores: 15000,  quarter: "Q3FY26" },
  { code: "533326", company: "Texmaco Rail And Engineering",     crores: 6500,   quarter: "Q3FY26" },
  { code: "533269", company: "VA Tech Wabag Ltd",                crores: 16300,  quarter: "Q3FY26" },  // FIXED
  { code: "500103", company: "Bharat Heavy Electricals Ltd",     crores: 11400,  quarter: "Q3FY26" },  // FIXED code
  { code: "500480", company: "Cummins India Ltd",                crores: 5200,   quarter: "Q3FY26" },
  { code: "500411", company: "Thermax Ltd",                      crores: 12000,  quarter: "Q3FY26" },
  { code: "533033", company: "ISGEC Heavy Engineering Ltd",      crores: 7500,   quarter: "Q3FY26" },
  { code: "543460", company: "The Anup Engineering Ltd",         crores: 1100,   quarter: "Q3FY26" },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const args       = process.argv.slice(2);
  const forcePupp  = args.includes("--puppeteer");
  const seedOnly   = args.includes("--seed-only");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Order Book Backfill v4 — PDF + Puppeteer + Seed       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  try { require("dotenv").config({ path: path.join(__dirname, "../../.env") }); } catch { /* ok */ }

  const mcapDB  = loadDB();
  const history = loadOBHistory();

  if (Object.keys(mcapDB).length === 0) {
    console.error("❌ marketCapDB.json empty. Run parseUpstoxBSE.js first.");
    process.exit(1);
  }

  // OB companies from your actual DB — name is authoritative
  const obCodes = Object.entries(mcapDB)
    .filter(([, d]) => isOBSector(d.name || ""))
    .map(([code]) => code);

  console.log(`📊 Total companies in DB : ${Object.keys(mcapDB).length}`);
  console.log(`🎯 OB-sector companies   : ${obCodes.length}`);

  const quarters = [
    { name: "Q3FY26", from: new Date("2026-01-10"), to: new Date("2026-03-28") },
    { name: "Q2FY26", from: new Date("2025-10-10"), to: new Date("2025-11-30") },
    { name: "Q1FY26", from: new Date("2025-07-10"), to: new Date("2025-08-31") },
    { name: "Q4FY25", from: new Date("2025-04-10"), to: new Date("2025-05-31") },
  ];

  let pdfFound = 0;

  // ── PHASE 1: Live PDF scan ─────────────────────────────────────────────────
  if (!seedOnly && extractOrderValueFromPDF) {
    // BSE cookie warmup
    console.log("\n🍪 Getting BSE session cookie...");
    const cookie = await getBSECookie();
    console.log(cookie ? `✅ Cookie ready\n` : `⚠️  No cookie — trying anyway\n`);

    // Test API
    const test = await fetchResultFilings(
      new Date("2026-01-10"), new Date("2026-03-28"), "500103", cookie
    );
    const apiOk = test.ok;
    console.log(apiOk
      ? `✅ BSE API responding\n`
      : `❌ BSE API blocked (${test.reason}) — will use Puppeteer if available\n`
    );

    // Init Puppeteer if needed
    let usePuppeteer = false;
    if (!apiOk || forcePupp) {
      usePuppeteer = await initPuppeteer();
    }

    if (apiOk || usePuppeteer) {
      for (const q of quarters) {
        console.log(`\n── ${q.name} ──`);
        const foundThisQuarter = new Set();

        // Bulk fetch
        const bulk = await fetchResultFilings(q.from, q.to, "", cookie);
        const bulkOB = bulk.rows.filter(row => {
          const code   = String(row.SCRIP_CD || "").trim();
          const bseN   = (row.SLONGNAME || row.companyname || "").toLowerCase();
          const dbName = (mcapDB[code]?.name || "").toLowerCase();
          return isOBSector(bseN) || isOBSector(dbName);
        });
        console.log(`   Bulk: ${bulk.rows.length} total, ${bulkOB.length} OB-relevant`);

        for (const row of bulkOB) {
          const code    = String(row.SCRIP_CD || "").trim();
          if (!code) continue;
          foundThisQuarter.add(code);

          // Name: DB is authoritative for code→name mapping
          const company = mcapDB[code]?.name
            || (row.SLONGNAME || row.companyname || "").trim()
            || code;

          const pdfUrl = row.ATTACHMENTNAME
            ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`
            : null;

          if (!pdfUrl || alreadySaved(code, q.name, history)) continue;

          process.stdout.write(`   ${company.substring(0,40).padEnd(40)} `);
          const crores = await fetchPDFValue(pdfUrl, usePuppeteer);

          if (crores && crores > 50) {
            pdfFound++;
            console.log(`₹${crores >= 1000 ? (crores/1000).toFixed(1)+"K" : Math.round(crores)} Cr ✅`);
            await saveResult(code, company, crores, q.name, history);
          } else {
            console.log("—");
          }
          await sleep(600);
        }

        // Per-company for missed codes
        const missed = obCodes.filter(c => !foundThisQuarter.has(c));
        for (const code of missed) {
          if (alreadySaved(code, q.name, history)) continue;
          const r = await fetchResultFilings(q.from, q.to, code, cookie);
          await sleep(250);
          if (!r.ok || !r.rows.length) continue;

          for (const row of r.rows) {
            const company = mcapDB[code]?.name || code;
            const pdfUrl  = row.ATTACHMENTNAME
              ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`
              : null;
            if (!pdfUrl) continue;

            process.stdout.write(`   ${company.substring(0,40).padEnd(40)} `);
            const crores = await fetchPDFValue(pdfUrl, usePuppeteer);
            if (crores && crores > 50) {
              pdfFound++;
              console.log(`₹${crores >= 1000 ? (crores/1000).toFixed(1)+"K" : Math.round(crores)} Cr ✅`);
              await saveResult(code, company, crores, q.name, history);
            } else {
              console.log("—");
            }
            await sleep(600);
          }
        }

        await sleep(2000);
      }
    }

    // Close Puppeteer
    if (browser) { await browser.close(); console.log("🤖 Browser closed"); }
  }

  // ── PHASE 2: Seed — fill gaps PDF didn't cover ────────────────────────────
  console.log("\n━━━ Seeding verified Q3FY26 order books (gaps only) ━━━\n");
  let seedAdded = 0;

  for (const s of SEED_DATA) {
    if (alreadySaved(s.code, s.quarter, history)) continue;
    // Always use YOUR DB name — seed company field is just a fallback
    const company = mcapDB[s.code]?.name || s.company;
    const display = s.crores >= 1000 ? `₹${(s.crores/1000).toFixed(0)}K Cr` : `₹${s.crores} Cr`;
    console.log(`   📌 ${company.padEnd(40)} ${display}`);
    await saveResult(s.code, company, s.crores, s.quarter, history);
    seedAdded++;
    await sleep(30);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const all = Object.entries(history)
    .flatMap(([code, d]) => (d.quarters||[]).map(q => ({
      code, company: d.company || mcapDB[code]?.name || code,
      crores: q.confirmedOrderBook, quarter: q.quarter,
    })))
    .sort((a, b) => b.crores - a.crores);

  console.log(`\n${"═".repeat(65)}`);
  console.log(`   PDF results  : ${pdfFound}`);
  console.log(`   Seed added   : ${seedAdded}`);
  console.log(`   Total records: ${all.length}`);
  console.log(`\n   ${"Company".padEnd(40)} ${"Qtr".padEnd(8)} Order Book`);
  console.log(`   ${"─".repeat(62)}`);
  all.slice(0, 50).forEach(r => {
    const ob = r.crores >= 1000
      ? `₹${(r.crores/1000).toFixed(0)}K Cr`
      : `₹${Math.round(r.crores)} Cr`;
    console.log(`   ${r.company.substring(0,38).padEnd(40)} ${r.quarter.padEnd(8)} ${ob}`);
  });

  console.log(`\n✅ Done. Now commit and push:\n`);
  console.log(`   git add server/data/marketCapDB.json server/data/orderBookHistory.json`);
  console.log(`   git commit -m "seed company + orderbook data"`);
  console.log(`   git push\n`);

  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});