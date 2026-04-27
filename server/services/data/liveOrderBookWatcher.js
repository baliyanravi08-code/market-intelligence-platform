"use strict";

/**
 * liveOrderBookWatcher.js
 *
 * MEMORY FIXES vs original:
 *  1. mcapDB — cached at module level, refreshed every 2h (was re-parsed from disk every poll)
 *  2. seenFilings — singleton Set loaded once at startup, never reconstructed (was new Set() every poll)
 *  3. seenFilings save — debounced 60s (was written inside every processFiling call via saveSeen)
 *  4. poll guard — unchanged (already present)
 *  5. Scanner untouched — no changes to marketScanner
 */

const axios       = require("axios");
const fs          = require("fs");
const path        = require("path");
const orderBookDB = require("./orderBookDB");

const MCAP_FILE  = path.join(__dirname, "../../data/marketCapDB.json");
const SEEN_FILE  = path.join(__dirname, "../../data/seenFilings.json");

const POLL_MS     = 5 * 60 * 1000;  // 5 minutes
const LOOKBACK_MS = 6 * 60 * 1000;  // fetch filings from last 6 minutes

// ── FIX 1: mcapDB — cached at module level, refreshed every 2h ───────────────
let _mcapDB    = null;
let _mcapDBTS  = 0;
const MCAP_TTL = 2 * 60 * 60 * 1000; // 2 hours

function getMcapDB() {
  if (_mcapDB && Date.now() - _mcapDBTS < MCAP_TTL) return _mcapDB;
  try {
    const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
    _mcapDB   = raw ? JSON.parse(raw) : {};
  } catch {
    _mcapDB = _mcapDB || {}; // keep stale copy on error
  }
  _mcapDBTS = Date.now();
  return _mcapDB;
}

// Initialise cache at module load (not inside poll)
getMcapDB();

// ── FIX 2: seenFilings — singleton Set, loaded once ──────────────────────────
function _loadSeenFromDisk() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, "utf8").trim();
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

let seenCache = _loadSeenFromDisk(); // load once at module init
let seenDirty = false;

// ── FIX 3: debounced save — write disk at most every 60s ─────────────────────
setInterval(() => {
  if (!seenDirty) return;
  try {
    // Keep only last 2000 entries to prevent unbounded growth
    const arr = [...seenCache].slice(-2000);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr), "utf8");
    seenDirty = false;
  } catch { /* ok */ }
}, 60_000);

function hasSeen(key)  { return seenCache.has(key); }
function markSeen(key) {
  seenCache.add(key);
  seenDirty = true;
  // Trim in-memory set if it grows past 2500 entries
  if (seenCache.size > 2500) {
    seenCache = new Set([...seenCache].slice(-2000));
  }
}

// ── Quarter helper ─────────────────────────────────────────────────────────────
function getQuarterForDate(date) {
  const month = date.getMonth() + 1;
  const year  = date.getFullYear();
  const fy    = month >= 4 ? year + 1 : year;
  const short = String(fy).slice(-2);
  if (month >= 4  && month <= 6)  return `Q1FY${short}`;
  if (month >= 7  && month <= 9)  return `Q2FY${short}`;
  if (month >= 10 && month <= 12) return `Q3FY${short}`;
  return `Q4FY${short}`;
}

// ── ORDER VALUE EXTRACTOR ──────────────────────────────────────────────────────
function extractOrderCrores(text) {
  if (!text) return null;
  const t = text.replace(/,/g, "").replace(/₹/g, "Rs").replace(/INR/gi, "Rs");

  const patterns = [
    /(?:Rs\.?\s*|INR\s*)(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /(?:Rs\.?\s*)(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /valued\s+at\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /worth\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /inflow\s+of\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*billion/i,
    /(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*lakh\s*cr/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m) {
      let val = parseFloat(m[1]);
      if (i === patterns.length - 1) val = val * 100000;
      else if (t.toLowerCase().includes("billion")) val = val * 100;
      if (val > 0.5) return parseFloat(val.toFixed(2));
    }
  }
  return null;
}

// ── ORDER BOOK RESULT EXTRACTOR ───────────────────────────────────────────────
function extractConfirmedOB(text) {
  if (!text) return null;
  const t = text.replace(/,/g, "").replace(/₹/g, "Rs").replace(/INR/gi, "Rs");

  const patterns = [
    /order\s*book\s+(?:stood\s+at|of|at|is|stands\s+at)\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*backlog\s+(?:of|at|is)\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /unexecuted\s+order\s+(?:book|backlog)\s+(?:of|at|is)\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /outstanding\s+orders?\s+(?:of|at|is|worth)\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*book\s+(?:as\s+(?:on|of)\s+\w+\s+\d+,?\s*\d+\s+)?(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    /order\s*book\s+(?:of|at|is)\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*lakh\s*cr/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m) {
      let val = parseFloat(m[1]);
      if (t.toLowerCase().match(/lakh\s*cr/)) val = val * 100000;
      if (val > 100) return parseFloat(val.toFixed(2));
    }
  }
  return null;
}

// ── FILING TYPE CLASSIFIER ─────────────────────────────────────────────────────
const ORDER_SIGNALS = [
  /\border\b.*\b(?:receiv|secur|win|won|award|bag|bag{1,2}ed|ink|sign|announc)/i,
  /\b(?:new\s+)?order\s+(?:worth|of|valued|from|inflow)/i,
  /\bwork\s+order\b/i,
  /\bcontract\s+(?:award|secur|receiv|sign)/i,
  /\bletter\s+of\s+(?:award|intent|acceptance)\b/i,
  /\bLOA\b/,
  /\border\s+inflow\b/i,
  /\bcommission\s+(?:order|contract)\b/i,
  /\bsupply\s+order\b/i,
];

const RESULT_SIGNALS = [
  /\bfinancial\s+results?\b/i,
  /\bquarterly\s+results?\b/i,
  /\bunaudited\s+(?:financial|standalone|consolidated)\b/i,
  /\baudited\s+(?:financial|standalone|consolidated)\b/i,
  /\bq[1-4]fy\d{2}\b/i,
  /\bquarter\s+ended\b/i,
  /\bhalf\s+year\s+(?:ended|results?)\b/i,
  /\bannual\s+results?\b/i,
];

const ORDER_NOISE = [
  /\bregulatory\s+order\b/i,
  /\bcourt\s+order\b/i,
  /\bnclat\b/i,
  /\bsebi\s+order\b/i,
  /\bnclt\b/i,
  /\binsider\b/i,
  /\bboard\s+meeting\b/i,
];

function classifyFiling(title, subcategory) {
  const sub = String(subcategory || "").trim();
  if (sub === "9")  return "result";
  if (sub === "41") return "order";
  const t = (title || "").toLowerCase();
  if (ORDER_NOISE.some(r => r.test(t)))   return null;
  if (RESULT_SIGNALS.some(r => r.test(t))) return "result";
  if (ORDER_SIGNALS.some(r => r.test(t)))  return "order";
  return null;
}

// ── OB-sector filter ──────────────────────────────────────────────────────────
const OB_KEYWORDS = [
  "infra","epc","engineer","construct","railway","defense","defence",
  "solar","renewable","wind","power","energy","water","ship","aerospace",
  "rites","rvnl","hal","bel","ntpc","larsen","kec","kalpataru",
  "thermax","cummins","bhel","suzlon","titagarh","texmaco","jupiter wagon",
  "wabag","garden reach","cochin ship","mazagon","data pattern",
  "paras defence","mtar","astra micro","centum","va tech","ncc ",
  "hg infra","pnc infra","dilip","j kumar","knr","ashoka","irb",
  "bharat forge","voltamp","techno elec","power mech","sjvn",
  "power grid","torrent power","isgec","anup eng","capacite",
  "gr infra","ahluwalia","enviro infra","waaree","insolation",
  "kpi green","ge vernova","genus power","concor","adani green",
  "adani power","jsw energy","tata power","nhpc","abb india","siemens",
  "hitachi","transformer","ircon","bharat dynamics","cgpower","cg power",
];

function isOBSector(name) {
  const n = (name || "").toLowerCase();
  return OB_KEYWORDS.some(k => n.includes(k.trim()));
}

// ── BSE API helpers ───────────────────────────────────────────────────────────
let bseCookie = "";
let cookieTS  = 0;

async function refreshCookieIfNeeded() {
  if (Date.now() - cookieTS < 55 * 60 * 1000) return;
  try {
    const r = await axios.get("https://www.bseindia.com", {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" },
      timeout: 15000, maxRedirects: 5,
    });
    const c = r.headers["set-cookie"];
    if (c?.length) {
      bseCookie = c.map(x => x.split(";")[0]).join("; ");
      cookieTS  = Date.now();
    }
  } catch { /* ok */ }
}

function bseHeaders() {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":     "application/json, text/plain, */*",
    "Referer":    "https://www.bseindia.com/corporates/ann.html",
    "Origin":     "https://www.bseindia.com",
    ...(bseCookie ? { Cookie: bseCookie } : {}),
  };
}

function fmtBSEDate(d) {
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

async function fetchRecentFilings() {
  const to   = new Date();
  const from = new Date(Date.now() - LOOKBACK_MS);
  const params = new URLSearchParams({
    strCat: "-1", strPrevDate: fmtBSEDate(from), strScrip: "",
    strSearch: "P", strToDate: fmtBSEDate(to), strType: "C", subcategory: "-1",
  });
  try {
    const res = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?${params}`,
      { headers: bseHeaders(), timeout: 15000 }
    );
    const d = res.data;
    if (!d || typeof d === "string") return [];
    return d?.Table || d?.Table1 || d?.data || (Array.isArray(d) ? d : []);
  } catch (e) {
    console.log(`⚠️  BSE fetch failed: ${e.message}`);
    return [];
  }
}

// ── Optional PDF extractor ────────────────────────────────────────────────────
let pdfExtractor = null;
try {
  const pr = require("./pdfReader");
  pdfExtractor = pr.extractOrderValueFromPDF || pr.extractCroresFromText || null;
} catch { /* title-only mode */ }

async function tryExtractFromPDF(pdfUrl) {
  if (!pdfExtractor || !pdfUrl) return null;
  try { return await pdfExtractor(pdfUrl); } catch { return null; }
}

// ── Parse which quarter a result filing covers ────────────────────────────────
function parseResultQuarter(title) {
  const t = title.toLowerCase();
  const monthMap = {
    january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,
    june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,
    october:10,oct:10,november:11,nov:11,december:12,dec:12,
  };
  const m = t.match(/ended\s+(\w+)(?:\s+(\d{4}))?/);
  if (m) {
    const month = monthMap[m[1].toLowerCase()];
    if (!month) return null;
    const year  = m[2] ? parseInt(m[2]) : new Date().getFullYear();
    const fy    = month >= 4 ? year + 1 : year;
    const short = String(fy).slice(-2);
    if (month >= 4  && month <= 6)  return `Q1FY${short}`;
    if (month >= 7  && month <= 9)  return `Q2FY${short}`;
    if (month >= 10 && month <= 12) return `Q3FY${short}`;
    return `Q4FY${short}`;
  }
  const direct = title.match(/\b(Q[1-4]FY\d{2})\b/i);
  if (direct) return direct[1].toUpperCase();
  return null;
}

// ── CORE PROCESSOR ────────────────────────────────────────────────────────────
async function processFiling(row) {
  const filingId = row.NEWSID || row.NewsID || row.DT_TM || "";
  const code     = String(row.SCRIP_CD || row.ScripCode || "").trim();
  const title    = (row.NEWSSUB || row.NewsSub || row.headline || "").trim();
  const subcat   = String(row.SUBCATID || row.SubCatId || "").trim();
  const pdfFile  = row.ATTACHMENTNAME || row.AttachmentName || "";
  const pdfUrl   = pdfFile
    ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${pdfFile}`
    : null;

  if (!code || !title) return;

  const key = `${code}:${filingId || title.slice(0, 40)}`;
  if (hasSeen(key)) return;
  markSeen(key); // FIX: uses singleton, no disk write here

  // FIX: getMcapDB() returns cached object — no file read unless TTL expired
  const mcapDB  = getMcapDB();
  const company = mcapDB[code]?.name || (row.SLONGNAME || row.companyname || "").trim() || code;

  if (!isOBSector(company) && !isOBSector(row.SLONGNAME || "")) return;

  const type = classifyFiling(title, subcat);
  if (!type) return;

  const quarter = getQuarterForDate(new Date());

  if (type === "order") {
    let crores = extractOrderCrores(title);
    if (!crores && pdfUrl) crores = await tryExtractFromPDF(pdfUrl);
    if (!crores || crores <= 0) {
      console.log(`📋 ORDER (no value) [${code}] ${company} — "${title.slice(0,60)}"`);
      return;
    }
    console.log(`📦 ORDER  [${code}] ${company} +₹${crores}Cr (${quarter}) — "${title.slice(0,50)}"`);
    await orderBookDB.addOrderToBook(code, company, crores, title, pdfUrl);
  }

  if (type === "result") {
    let confirmedOB = null;
    if (pdfUrl) confirmedOB = await tryExtractFromPDF(pdfUrl);
    if (!confirmedOB) confirmedOB = extractConfirmedOB(title);
    if (!confirmedOB || confirmedOB <= 0) {
      console.log(`📋 RESULT (no OB found) [${code}] ${company} — "${title.slice(0,60)}"`);
      return;
    }
    const resultQuarter = parseResultQuarter(title) || quarter;
    console.log(`✅ RESULT [${code}] ${company} OB=₹${confirmedOB}Cr (${resultQuarter}) — "${title.slice(0,50)}"`);
    await orderBookDB.updateFromResultFiling(code, company, confirmedOB, resultQuarter, null);
  }
}

// ── MAIN POLL LOOP ─────────────────────────────────────────────────────────────
let polling = false;
let timer   = null;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await refreshCookieIfNeeded();
    const rows = await fetchRecentFilings(); // FIX: no mcapDB load here anymore
    if (rows.length > 0) {
      for (const row of rows) {
        await processFiling(row); // mcapDB fetched from cache inside
      }
      console.log(`🔍 Watcher: checked ${rows.length} filings @ ${new Date().toLocaleTimeString("en-IN")}`);
    }
  } catch (e) {
    console.log(`⚠️  Watcher poll error: ${e.message}`);
  } finally {
    polling = false;
  }
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────
function start() {
  if (timer) return;
  console.log("🚀 OrderBook watcher started — polling BSE every 5 min");
  poll();
  timer = setInterval(poll, POLL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  console.log("🛑 OrderBook watcher stopped");
}

async function processOne(filingRow) {
  await processFiling(filingRow);
}

module.exports = { start, stop, processOne, extractOrderCrores, extractConfirmedOB, classifyFiling };