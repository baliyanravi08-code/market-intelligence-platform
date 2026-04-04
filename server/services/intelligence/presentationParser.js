/**
 * presentationParser.js
 * server/services/intelligence/presentationParser.js
 *
 * Batch-downloads investor presentation PDFs from BSE and extracts:
 *   - Revenue guidance (3-year targets)
 *   - EBITDA / margin targets
 *   - Capex plans
 *   - Order pipeline / inflow guidance
 *   - Capacity targets
 *
 * Plugs into existing pipeline:
 *   - Uses pdfReader.js buffer extraction (no new deps)
 *   - Saves via database.js mongoose pattern
 *   - Emits "guidance_update" socket event (same as other engines)
 *   - Called from bseListener.js when HEADLINE contains presentation keywords
 *   - Also has standalone batchScan() for manual/scheduled runs
 */

"use strict";

const axios    = require("axios");
const mongoose = require("mongoose");
const path     = require("path");

// ── Reuse existing pdfReader buffer extraction ────────────────────────────────
const { extractOrderValueFromPDF } = require("../data/pdfReader");

// ── BSE fetch headers (same as bseListener.js) ───────────────────────────────
const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Referer":    "https://www.bseindia.com",
  "Accept":     "application/pdf,*/*"
};

// ── Mongoose schema — mirrors database.js strict:false pattern ────────────────
const GuidanceSchema = new mongoose.Schema({
  scrip:          { type: String, index: true },   // BSE scrip code
  company:        { type: String, index: true },
  filingDate:     { type: Date,   index: true },
  pdfUrl:         String,
  extractedAt:    { type: Number, index: true },    // epoch ms

  // Raw extracted guidance
  guidance: {
    revenue:  [{ year: String, targetCr: Number, label: String }],
    ebitda:   [{ year: String, targetPct: Number, label: String }],
    capex:    [{ year: String, targetCr: Number, label: String }],
    orders:   [{ year: String, targetCr: Number, label: String }],
    capacity: [{ year: String, target: Number, unit: String, label: String }],
    rawText:  String   // first 2000 chars for debugging
  },

  // Credibility tracking — filled by credibilityEngine.js
  credibility: {
    revenueHitRate:  { type: Number, default: null },
    ebitdaHitRate:   { type: Number, default: null },
    orderHitRate:    { type: Number, default: null },
    overallScore:    { type: Number, default: null },   // 0-100
    checkedAt:       { type: Number, default: null }
  },

  // Source metadata
  source:   { type: String, default: "BSE_PRESENTATION" },
  quarter:  String,   // "Q4FY26" etc — which quarter filing came in
  hasData:  { type: Boolean, default: false }

}, { timestamps: true, strict: false });

GuidanceSchema.index({ scrip: 1, filingDate: -1 });

let GuidanceModel = null;

function getModel() {
  if (GuidanceModel) return GuidanceModel;
  try {
    GuidanceModel = mongoose.model("Guidance");
  } catch {
    GuidanceModel = mongoose.model("Guidance", GuidanceSchema);
  }
  return GuidanceModel;
}

// ── In-memory cache — same pattern as database.js memoryStore ────────────────
const guidanceCache = new Map();   // scrip → latest guidance doc

// ── Presentation keyword detection (used by bseListener.js) ──────────────────
const PRESENTATION_KEYWORDS = [
  "investor presentation",
  "investor day",
  "analyst day",
  "analyst presentation",
  "investor meet",
  "corporate presentation",
  "company presentation",
  "earnings presentation",
  "strategy presentation",
  "annual investor",
  "capital markets day",
  "cmd presentation",
  "con call presentation",
  "concall presentation",
  "q4 presentation",
  "q3 presentation",
  "q2 presentation",
  "q1 presentation",
  "fy presentation",
  "annual report presentation"
];

function isPresentationFiling(headline) {
  if (!headline) return false;
  const h = headline.toLowerCase();
  return PRESENTATION_KEYWORDS.some(k => h.includes(k));
}

// ── PDF text extraction — extends pdfReader.js with raw text return ───────────
// pdfReader only returns crores number; we need full text for guidance
// So we replicate the buffer → text step and then run our own patterns on it

async function fetchPDFText(pdfUrl) {
  if (!pdfUrl) return null;
  try {
    console.log(`📄 Presentation PDF: ${pdfUrl.substring(0, 70)}...`);
    const res = await axios.get(pdfUrl, {
      headers:      BSE_HEADERS,
      responseType: "arraybuffer",
      timeout:      20000
    });

    const buf = Buffer.from(res.data);
    return extractRawTextFromBuffer(buf);

  } catch (err) {
    console.log(`📄 Presentation PDF fetch failed: ${err.message}`);
    return null;
  }
}

function extractRawTextFromBuffer(buf) {
  const str  = buf.toString("latin1");
  let   text = "";

  // Method 1: PDF string literals (same as pdfReader.js extractTextFromPDFBuffer)
  const parenRegex = /\(([^)]{1,300})\)\s*(?:Tj|TJ|'|")/g;
  let m;
  while ((m = parenRegex.exec(str)) !== null) {
    const chunk = m[1]
      .replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ")
      .replace(/\\\d{3}/g, " ").replace(/\\(.)/g, "$1");
    const clean = chunk.replace(/[^\x20-\x7E\u20B9]/g, " ").trim();
    if (clean.length > 2) text += clean + " ";
  }

  // Method 2: BT/ET blocks (text object blocks in PDF stream)
  const btRegex = /BT\s([\s\S]{1,500}?)ET/g;
  while ((m = btRegex.exec(str)) !== null) {
    const inner = m[1].replace(/[^\x20-\x7E]/g, " ").trim();
    if (inner.length > 3) text += inner + " ";
  }

  // Method 3: Raw rupee/number patterns (same as pdfReader.js)
  const rsPattern = /Rs\.?\s*[\d,]+/gi;
  const rawMatches = str.match(rsPattern) || [];
  text += " " + rawMatches.join(" ");

  // Normalise whitespace
  return text.replace(/\s+/g, " ").trim();
}

// ── Guidance extraction patterns ──────────────────────────────────────────────

// Year/FY normalisation helpers
function normalizeFY(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // "FY26", "FY2026", "2025-26", "2026"
  const fy2  = s.match(/^FY(\d{2})$/i);
  if (fy2) return `FY${fy2[1]}`;

  const fy4  = s.match(/^FY(\d{4})$/i);
  if (fy4) return `FY${String(fy4[1]).slice(-2)}`;

  const dash = s.match(/^(\d{4})-(\d{2,4})$/);
  if (dash) return `FY${String(dash[2]).slice(-2)}`;

  const year = s.match(/^(\d{4})$/);
  if (year) {
    // Assume "2026" means FY26
    return `FY${String(year[1]).slice(-2)}`;
  }

  return s;
}

// Extract current FY from context
function getCurrentFY() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;
  const fy    = month >= 4 ? year + 1 : year;
  return `FY${String(fy).slice(-2)}`;
}

// ── Revenue guidance patterns ─────────────────────────────────────────────────
// "Revenue of ₹5,000 Cr by FY26"
// "Target revenue of Rs.8,000 crores in FY27"
// "Revenue guidance of ₹10,000 Cr for FY26E"

const REVENUE_PATTERNS = [
  /(?:revenue|turnover|sales)\s+(?:guidance|target|aim|goal|projection|forecast|expected|of|to\s+reach|to\s+achieve)\s+(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s*(?:by|in|for)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,
  /(?:by|in|for)\s+(fy\d{2,4}|\d{4}(?:-\d{2,4})?)[,\s]+(?:revenue|turnover|sales)\s+(?:of|target|guidance)?\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)/gi,
  /(?:revenue|turnover)\s+(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:by|in)\s+(fy\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,
  // "₹5,000 Cr revenue by FY26"
  /(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:revenue|turnover|sales)\s+(?:by|in|for)\s+(fy\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,
  // Lakh crore variant
  /(?:revenue|turnover|sales)\s+(?:target|guidance|of)\s+(?:rs\.?|₹)?\s*([\d.]+)\s*lakh\s*crore\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
];

// ── EBITDA/margin patterns ────────────────────────────────────────────────────
const EBITDA_PATTERNS = [
  /ebitda\s+(?:margin\s+)?(?:guidance|target|aim|of|expected|forecast)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%\s*(?:by|in|for)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,
  /(?:margin|ebitda)\s+(?:of|at|around|approximately)\s+(\d+(?:\.\d+)?)\s*%\s+(?:by|in|for)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,
  /target\s+(?:ebitda|margin)\s+of\s+(\d+(?:\.\d+)?)\s*%/gi,
  /(?:expand|improve|achieve)\s+(?:ebitda\s+)?margin\s+to\s+(\d+(?:\.\d+)?)\s*%\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
  /(?:ebitda|operating)\s+margin\s+(?:target|guidance|expected|of)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)/gi,
];

// ── Capex patterns ────────────────────────────────────────────────────────────
const CAPEX_PATTERNS = [
  /capex\s+(?:of|plan|guidance|budget|target|outlay)\s+(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:for|in|over|during)?\s*(?:the\s+)?(?:next\s+)?(fy\d{2,4}|\d{1,2}\s*year|\d{4}(?:-\d{2,4})?)?/gi,
  /(?:plan\s+to\s+)?invest\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:in\s+capex|as\s+capex|for\s+capex|towards\s+capex)/gi,
  /capital\s+expenditure\s+(?:of|plan\s+of|budget\s+of)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)/gi,
  /(?:rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:capex|capital\s+expenditure)\s+(?:for|in|over|planned|planned\s+for)\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,
];

// ── Order inflow/pipeline patterns ───────────────────────────────────────────
const ORDER_INFLOW_PATTERNS = [
  /order\s+(?:inflow|intake|addition)\s+(?:guidance|target|of|expected|projected)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s*(?:for|in|by)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,
  /(?:target|expect|plan)\s+(?:order\s+)?inflow\s+of\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:in|for|by)\s+(fy\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,
  /pipeline\s+of\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)/gi,
  /bid\s+pipeline\s+(?:of|worth|at)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)/gi,
  /order\s+book\s+(?:target|guidance|of)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
];

// ── Capacity patterns ─────────────────────────────────────────────────────────
const CAPACITY_PATTERNS = [
  /capacity\s+(?:expansion|addition|target|of)\s+(?:to\s+)?([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa|units|mmt|mmscmd|beds|km)/gi,
  /(?:expand|increase|grow)\s+capacity\s+(?:to|by)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa|units|mmt|beds|km)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
  /(?:target|plan|aim)\s+(?:to\s+)?(?:achieve|reach|build)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt|tpa|units)\s+(?:capacity|of\s+capacity)/gi,
  /installed\s+capacity\s+(?:to\s+reach|of|target)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt|tpa)/gi,
];

// ── Core extraction function ──────────────────────────────────────────────────

function extractGuidanceFromText(rawText) {
  if (!rawText || rawText.length < 50) return null;

  const text = rawText.toLowerCase();
  const guidance = {
    revenue:  [],
    ebitda:   [],
    capex:    [],
    orders:   [],
    capacity: [],
    rawText:  rawText.substring(0, 2000)
  };

  // ── Revenue ──────────────────────────────────────────────────────────────
  for (const pattern of REVENUE_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      // Groups vary by pattern — amount is always first numeric group
      let amount = null, fyRaw = null;

      // Try both group orderings
      const g1 = m[1], g2 = m[2];
      if (g1 && /[\d,]+/.test(g1)) {
        amount = parseFloat(g1.replace(/,/g, ""));
        fyRaw  = g2;
      } else if (g2 && /[\d,]+/.test(g2)) {
        amount = parseFloat(g2.replace(/,/g, ""));
        fyRaw  = g1;
      }

      // Lakh crore conversion
      if (m[0].includes("lakh crore") && amount) amount = amount * 100000;

      if (amount && amount > 0 && amount < 10000000) {
        const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
        // Dedup — don't add same FY twice
        if (!guidance.revenue.find(r => r.year === fy)) {
          guidance.revenue.push({
            year:     fy,
            targetCr: Math.round(amount),
            label:    `Revenue target ₹${amount >= 1000 ? (amount/1000).toFixed(1)+"K" : amount}Cr by ${fy}`
          });
        }
      }
    }
  }

  // ── EBITDA / margin ───────────────────────────────────────────────────────
  for (const pattern of EBITDA_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const pct   = parseFloat(m[1]);
      const fyRaw = m[2] || null;
      if (pct > 0 && pct < 100) {
        const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
        if (!guidance.ebitda.find(e => e.year === fy)) {
          guidance.ebitda.push({
            year:      fy,
            targetPct: Math.round(pct * 10) / 10,
            label:     `EBITDA margin target ${pct}% by ${fy}`
          });
        }
      }
    }
  }

  // ── Capex ─────────────────────────────────────────────────────────────────
  for (const pattern of CAPEX_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const amount = parseFloat((m[1] || "0").replace(/,/g, ""));
      const fyRaw  = m[2] || null;
      if (amount > 0 && amount < 1000000) {
        const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
        if (!guidance.capex.find(c => c.year === fy)) {
          guidance.capex.push({
            year:     fy,
            targetCr: Math.round(amount),
            label:    `Capex plan ₹${amount >= 1000 ? (amount/1000).toFixed(1)+"K" : amount}Cr for ${fy}`
          });
        }
      }
    }
  }

  // ── Order inflow ──────────────────────────────────────────────────────────
  for (const pattern of ORDER_INFLOW_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const amount = parseFloat((m[1] || "0").replace(/,/g, ""));
      const fyRaw  = m[2] || null;
      if (amount > 0 && amount < 10000000) {
        const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
        if (!guidance.orders.find(o => o.year === fy)) {
          guidance.orders.push({
            year:     fy,
            targetCr: Math.round(amount),
            label:    `Order inflow target ₹${amount >= 1000 ? (amount/1000).toFixed(1)+"K" : amount}Cr in ${fy}`
          });
        }
      }
    }
  }

  // ── Capacity ──────────────────────────────────────────────────────────────
  for (const pattern of CAPACITY_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const target = parseFloat((m[1] || "0").replace(/,/g, ""));
      const unit   = (m[2] || "units").toUpperCase();
      const fyRaw  = m[3] || null;
      if (target > 0) {
        const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
        if (!guidance.capacity.find(c => c.year === fy && c.unit === unit)) {
          guidance.capacity.push({
            year:   fy,
            target: Math.round(target * 10) / 10,
            unit,
            label:  `Capacity target ${target} ${unit} by ${fy}`
          });
        }
      }
    }
  }

  const hasData = (
    guidance.revenue.length  > 0 ||
    guidance.ebitda.length   > 0 ||
    guidance.capex.length    > 0 ||
    guidance.orders.length   > 0 ||
    guidance.capacity.length > 0
  );

  return { ...guidance, hasData };
}

// ── BSE API — fetch investor presentations for a scrip ────────────────────────
// BSE category 8 = Investor Presentation
const BSE_PRESENTATION_API =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w" +
  "?strCat=8&strPrevDate=&strScrip={SCRIP}&strSearch=P&strToDate=&strType=C&subcategory=-1";

async function fetchPresentationsForScrip(scrip, cookie = "") {
  try {
    const url = BSE_PRESENTATION_API.replace("{SCRIP}", scrip);
    const res = await axios.get(url, {
      headers: {
        "User-Agent": BSE_HEADERS["User-Agent"],
        "Accept":     "application/json, text/plain, */*",
        "Referer":    "https://www.bseindia.com/corporates/ann.html",
        "Origin":     "https://www.bseindia.com",
        ...(cookie ? { "Cookie": cookie } : {})
      },
      timeout: 15000
    });

    const data = res.data;
    let list = [];

    if (Array.isArray(data))        list = data;
    else if (Array.isArray(data.Table))  list = data.Table;
    else if (Array.isArray(data.Table1)) list = data.Table1;
    else {
      for (const k of Object.keys(data || {})) {
        if (Array.isArray(data[k]) && data[k].length) { list = data[k]; break; }
      }
    }

    return list
      .filter(item => item.ATTACHMENTNAME)
      .map(item => ({
        scrip:       String(scrip),
        company:     item.SLONGNAME || item.companyname || "Unknown",
        headline:    item.HEADLINE  || "",
        filingDate:  item.DT_TM    || item.NEWS_DT || null,
        pdfUrl:      `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`
      }));

  } catch (err) {
    console.log(`⚠️ Presentation fetch failed for ${scrip}: ${err.message}`);
    return [];
  }
}

// ── Parse a single presentation ───────────────────────────────────────────────
async function parsePresentation({ scrip, company, pdfUrl, filingDate, headline }) {
  console.log(`📊 Parsing presentation: ${company} — ${headline.substring(0, 60)}`);

  const rawText = await fetchPDFText(pdfUrl);
  if (!rawText || rawText.length < 100) {
    console.log(`📊 Skipped — no text extracted: ${company}`);
    return null;
  }

  const guidance = extractGuidanceFromText(rawText);
  if (!guidance || !guidance.hasData) {
    console.log(`📊 Skipped — no guidance found: ${company}`);
    return null;
  }

  // Determine quarter from filing date
  const d       = filingDate ? new Date(filingDate) : new Date();
  const month   = d.getMonth() + 1;
  const fy      = month >= 4 ? d.getFullYear() + 1 : d.getFullYear();
  const fyShort = String(fy).slice(-2);
  const qMap    = { 1:4, 2:4, 3:4, 4:1, 5:1, 6:1, 7:2, 8:2, 9:2, 10:3, 11:3, 12:3 };
  const quarter = `Q${qMap[month]}FY${fyShort}`;

  const doc = {
    scrip:       String(scrip),
    company,
    filingDate:  filingDate ? new Date(filingDate) : new Date(),
    pdfUrl,
    extractedAt: Date.now(),
    guidance,
    quarter,
    hasData:     true,
    source:      "BSE_PRESENTATION",
    credibility: { revenueHitRate: null, ebitdaHitRate: null, orderHitRate: null, overallScore: null, checkedAt: null }
  };

  // ── Persist to MongoDB ────────────────────────────────────────────────────
  try {
    const Model = getModel();
    await Model.findOneAndUpdate(
      { scrip, pdfUrl },
      { $set: doc },
      { upsert: true, new: true }
    );
    console.log(`✅ Guidance saved: ${company} — rev:${guidance.revenue.length} ebitda:${guidance.ebitda.length} capex:${guidance.capex.length} orders:${guidance.orders.length}`);
  } catch (err) {
    console.log(`⚠️ Guidance save failed: ${err.message}`);
  }

  // ── Update in-memory cache ────────────────────────────────────────────────
  guidanceCache.set(String(scrip), doc);

  return doc;
}

// ── Called from bseListener.js for live filings ───────────────────────────────
// Drop this into bseListener.processItem() after the RESULT block:
//
//   if (isPresentationFiling(signal.title) && signal.pdfUrl) {
//     parsePresentation({ scrip: signal.code, company: signal.company,
//       pdfUrl: signal.pdfUrl, filingDate: signal.time, headline: signal.title
//     }).then(doc => {
//       if (doc && ioRef) ioRef.emit("guidance_update", doc);
//     }).catch(() => {});
//   }

async function handleLivePresentationFiling(signal, ioRef) {
  if (!isPresentationFiling(signal.title) || !signal.pdfUrl) return null;

  const doc = await parsePresentation({
    scrip:       signal.code,
    company:     signal.company,
    pdfUrl:      signal.pdfUrl,
    filingDate:  signal.time,
    headline:    signal.title
  });

  if (doc && ioRef) {
    ioRef.emit("guidance_update", formatForClient(doc));
    console.log(`📡 guidance_update emitted: ${signal.company}`);
  }

  return doc;
}

// ── Batch scan — runs on startup + cron ──────────────────────────────────────
// Pass an array of scrip codes (your existing radar companies or a seed list)
// Rate-limited to 1 req/2s to avoid BSE rate limit

async function batchScan(scripList = [], cookie = "", ioRef = null) {
  if (!scripList.length) {
    console.log("📊 Batch scan: no scrips provided");
    return [];
  }

  console.log(`📊 Batch scan started: ${scripList.length} companies`);
  const results = [];
  let parsed = 0, skipped = 0;

  for (let i = 0; i < scripList.length; i++) {
    const scrip = String(scripList[i]);

    try {
      // Already have fresh data? Skip
      const cached = guidanceCache.get(scrip);
      if (cached && (Date.now() - cached.extractedAt) < 7 * 24 * 60 * 60 * 1000) {
        skipped++;
        continue;
      }

      const presentations = await fetchPresentationsForScrip(scrip, cookie);
      if (!presentations.length) { skipped++; continue; }

      // Parse only the most recent presentation
      const latest = presentations[0];
      const doc    = await parsePresentation(latest);

      if (doc) {
        results.push(doc);
        parsed++;
        if (ioRef) ioRef.emit("guidance_update", formatForClient(doc));
      } else {
        skipped++;
      }

      // Rate limit — 1 req / 1.5s
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));

    } catch (err) {
      console.log(`⚠️ Batch parse error for ${scrip}: ${err.message}`);
      skipped++;
    }

    // Progress log every 10
    if ((i + 1) % 10 === 0) {
      console.log(`📊 Batch progress: ${i+1}/${scripList.length} — parsed:${parsed} skipped:${skipped}`);
    }
  }

  console.log(`✅ Batch scan complete: parsed=${parsed} skipped=${skipped}`);
  return results;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function getGuidanceForScrip(scrip) {
  return guidanceCache.get(String(scrip)) || null;
}

function getAllGuidance() {
  return Array.from(guidanceCache.values())
    .filter(g => g.hasData)
    .sort((a, b) => (b.extractedAt || 0) - (a.extractedAt || 0));
}

async function loadCacheFromMongo() {
  try {
    const Model = getModel();
    const docs  = await Model.find({ hasData: true })
      .sort({ extractedAt: -1 })
      .limit(500)
      .lean();

    docs.forEach(d => guidanceCache.set(String(d.scrip), d));
    console.log(`📊 Guidance cache loaded: ${docs.length} companies`);
  } catch (err) {
    console.log(`⚠️ Guidance cache load failed: ${err.message}`);
  }
}

// ── Format for client emission ────────────────────────────────────────────────
function formatForClient(doc) {
  if (!doc) return null;
  return {
    scrip:       doc.scrip,
    company:     doc.company,
    quarter:     doc.quarter,
    filingDate:  doc.filingDate,
    pdfUrl:      doc.pdfUrl,
    extractedAt: doc.extractedAt,
    guidance: {
      revenue:  doc.guidance?.revenue  || [],
      ebitda:   doc.guidance?.ebitda   || [],
      capex:    doc.guidance?.capex    || [],
      orders:   doc.guidance?.orders   || [],
      capacity: doc.guidance?.capacity || [],
    },
    credibility: doc.credibility || {},
    hasData:     doc.hasData
  };
}

module.exports = {
  // Live filing hook — call from bseListener.processItem()
  isPresentationFiling,
  handleLivePresentationFiling,

  // Batch operations
  batchScan,
  fetchPresentationsForScrip,
  parsePresentation,

  // Queries
  getGuidanceForScrip,
  getAllGuidance,
  formatForClient,
  loadCacheFromMongo,

  // Exposed for testing
  extractGuidanceFromText,
  extractRawTextFromBuffer,
};