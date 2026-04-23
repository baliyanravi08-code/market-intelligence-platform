/**
 * presentationParser.js
 * server/services/intelligence/presentationParser.js
 *
 * Extracts guidance from BSE investor presentation PDFs:
 *   - Revenue / turnover targets
 *   - EBITDA / margin targets
 *   - Capex plans
 *   - Order pipeline / inflow guidance
 *   - Capacity targets
 *
 * Uses pdf-parse (primary) + raw binary fallback for text extraction.
 * Plugs into bseListener.js → coordinator.js → socket pipeline.
 */

"use strict";

const axios    = require("axios");
const mongoose = require("mongoose");

// ── pdf-parse (primary extractor) ────────────────────────────────────────────
let pdfParse = null;
try {
  pdfParse = require("pdf-parse");
  console.log("✅ pdf-parse loaded");
} catch (e) {
  console.log("⚠️ pdf-parse not found — run: npm install pdf-parse");
}

// ── BSE fetch headers ─────────────────────────────────────────────────────────
const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Referer":    "https://www.bseindia.com",
  "Accept":     "application/pdf,*/*"
};

// ── Mongoose schema ───────────────────────────────────────────────────────────
const GuidanceSchema = new mongoose.Schema({
  scrip:          { type: String, index: true },
  company:        { type: String, index: true },
  filingDate:     { type: Date,   index: true },
  pdfUrl:         String,
  extractedAt:    { type: Number, index: true },

  guidance: {
    revenue:  [{ year: String, targetCr: Number, label: String }],
    ebitda:   [{ year: String, targetPct: Number, label: String }],
    capex:    [{ year: String, targetCr: Number, label: String }],
    orders:   [{ year: String, targetCr: Number, label: String }],
    capacity: [{ year: String, target: Number, unit: String, label: String }],
    rawText:  String
  },

  credibility: {
    revenueHitRate:  { type: Number, default: null },
    ebitdaHitRate:   { type: Number, default: null },
    orderHitRate:    { type: Number, default: null },
    overallScore:    { type: Number, default: null },
    checkedAt:       { type: Number, default: null }
  },

  source:  { type: String, default: "BSE_PRESENTATION" },
  quarter: String,
  hasData: { type: Boolean, default: false }

}, { timestamps: true, strict: false });

GuidanceSchema.index({ scrip: 1, filingDate: -1 });

let GuidanceModel = null;

function getModel() {
  if (GuidanceModel) return GuidanceModel;
  try   { GuidanceModel = mongoose.model("Guidance"); }
  catch { GuidanceModel = mongoose.model("Guidance", GuidanceSchema); }
  return GuidanceModel;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
const guidanceCache = new Map();

// ── Presentation keyword detection ───────────────────────────────────────────
const PRESENTATION_KEYWORDS = [
  "investor presentation",
  "investor day",
  "analyst day",
  "analyst presentation",
  "analyst meet",
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
  "annual report presentation",
  "business presentation",
  "management presentation",
  "roadshow presentation"
];

// These headlines mention a MEETING DATE but have no PDF content yet — skip them
const MEETING_NOTICE_KEYWORDS = [
  "scheduled on",
  "to be held on",
  "will be held",
  "intimation of",
  "notice of",
  "inform.*meeting",
  "meeting.*inform"
];

function isPresentationFiling(headline) {
  if (!headline) return false;
  const h = headline.toLowerCase();
  return PRESENTATION_KEYWORDS.some(k => h.includes(k));
}

function isMeetingNotice(headline) {
  if (!headline) return false;
  const h = headline.toLowerCase();
  return MEETING_NOTICE_KEYWORDS.some(k => new RegExp(k).test(h));
}

// ── PDF text extraction ───────────────────────────────────────────────────────

async function fetchPDFText(pdfUrl) {
  if (!pdfUrl) return null;
  try {
    console.log(`📄 Presentation PDF: ${pdfUrl.substring(0, 80)}...`);

    const res = await axios.get(pdfUrl, {
      headers:      BSE_HEADERS,
      responseType: "arraybuffer",
      timeout:      30000
    });

    const buf = Buffer.from(res.data);

    if (buf.length < 500) {
      console.log(`📄 PDF too small (${buf.length} bytes) — likely meeting notice, skipping`);
      return null;
    }

    // ── Method 1: pdf-parse (works for text-layer PDFs) ──────────────────
    if (pdfParse) {
      try {
        const data = await pdfParse(buf, {
          max: 20,           // parse first 20 pages
          version: "v1.10.100"
        });
        if (data && data.text && data.text.trim().length > 300) {
          console.log(`📄 pdf-parse: ${data.text.length} chars, ${data.numpages} pages`);
          return data.text;
        } else {
          console.log(`📄 pdf-parse returned thin text (${data?.text?.length || 0} chars) — trying binary fallback`);
        }
      } catch (e) {
        console.log(`📄 pdf-parse failed: ${e.message} — trying binary fallback`);
      }
    }

    // ── Method 2: raw binary extraction (for encoded/older PDFs) ─────────
    const rawText = extractRawTextFromBuffer(buf);
    if (rawText && rawText.length > 200) {
      console.log(`📄 binary fallback: ${rawText.length} chars`);
      return rawText;
    }

    console.log(`📄 No usable text extracted from PDF`);
    return null;

  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`📄 PDF not found (404): ${pdfUrl.substring(0, 60)}`);
    } else {
      console.log(`📄 Presentation PDF fetch failed: ${err.message}`);
    }
    return null;
  }
}

function extractRawTextFromBuffer(buf) {
  const str  = buf.toString("latin1");
  let   text = "";

  // Method 1: PDF string literals
  const parenRegex = /\(([^)]{1,400})\)\s*(?:Tj|TJ|'|")/g;
  let m;
  while ((m = parenRegex.exec(str)) !== null) {
    const chunk = m[1]
      .replace(/\\n/g, " ").replace(/\\r/g, " ").replace(/\\t/g, " ")
      .replace(/\\\d{3}/g, " ").replace(/\\(.)/g, "$1");
    const clean = chunk.replace(/[^\x20-\x7E\u20B9]/g, " ").trim();
    if (clean.length > 2) text += clean + " ";
  }

  // Method 2: BT/ET text blocks
  const btRegex = /BT\s([\s\S]{1,800}?)ET/g;
  while ((m = btRegex.exec(str)) !== null) {
    const inner = m[1].replace(/[^\x20-\x7E]/g, " ").trim();
    if (inner.length > 3) text += inner + " ";
  }

  // Method 3: stream sections — look for readable text blocks
  const streamRegex = /stream\r?\n([\s\S]{1,5000}?)\r?\nendstream/g;
  while ((m = streamRegex.exec(str)) !== null) {
    const readable = m[1].replace(/[^\x20-\x7E\n]/g, " ").trim();
    // Only keep if it looks like real text (many words, not just hex/numbers)
    const wordCount = (readable.match(/[a-zA-Z]{3,}/g) || []).length;
    if (wordCount > 10) text += readable + " ";
  }

  // Method 4: rupee / number patterns
  const rsPattern = /(?:Rs\.?|₹|INR)\s*[\d,]+/gi;
  const rawMatches = str.match(rsPattern) || [];
  text += " " + rawMatches.join(" ");

  return text.replace(/\s+/g, " ").trim();
}

// ── FY normalisation ──────────────────────────────────────────────────────────

function normalizeFY(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const fy2  = s.match(/^FY(\d{2})$/i);
  if (fy2) return `FY${fy2[1]}`;

  const fy4  = s.match(/^FY(\d{4})$/i);
  if (fy4) return `FY${String(fy4[1]).slice(-2)}`;

  const dash = s.match(/^(\d{4})-(\d{2,4})$/);
  if (dash) return `FY${String(dash[2]).slice(-2)}`;

  const year = s.match(/^(\d{4})$/);
  if (year) return `FY${String(year[1]).slice(-2)}`;

  // "FY 26", "F.Y. 2026"
  const spaced = s.match(/F\.?Y\.?\s*(\d{2,4})/i);
  if (spaced) {
    const n = parseInt(spaced[1]);
    return `FY${n < 100 ? String(n).padStart(2,"0") : String(n).slice(-2)}`;
  }

  return s;
}

function getCurrentFY() {
  const now   = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const fy    = month >= 4 ? year + 1 : year;
  return `FY${String(fy).slice(-2)}`;
}

// ── Revenue patterns ──────────────────────────────────────────────────────────
// Covers: "revenue of Rs 5000 Cr by FY26", "₹5000 Cr revenue by FY26",
// "aspire to be a Rs 10,000 Cr company", "3x revenue by FY28",
// "revenue target of Rs 8,000 crores in FY27", lakh crore, etc.

const REVENUE_PATTERNS = [
  // "revenue/turnover of Rs X Cr by FY26"
  /(?:revenue|turnover|sales|net\s+sales)\s+(?:guidance|target|aim|goal|projection|forecast|expected|vision|aspiration)?\s*(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s*(?:by|in|for|of)?\s*(fy\d{2,4}|f\.?y\.?\s*\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,

  // "by/in FY26, revenue of Rs X Cr"
  /(?:by|in|for)\s+(fy\d{2,4}|f\.?y\.?\s*\d{2,4}|\d{4}(?:-\d{2,4})?)[,\s]+(?:revenue|turnover|sales)\s+(?:of|target|guidance)?\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)/gi,

  // "Rs X Cr revenue by FY26"
  /(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:revenue|turnover|sales|company)\s+(?:by|in|for)\s+(fy\d{2,4}|f\.?y\.?\s*\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,

  // "aspire/vision/target to achieve Rs X Cr by FY26"
  /(?:aspir(?:e|ing|ation)|vision|target|goal|aim|plan)\s+(?:to\s+)?(?:achieve|reach|grow\s+to|become|be)\s+(?:a\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:company|revenue|turnover|sales)?\s+(?:by|in)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,

  // "Rs X Cr company by FY26" (common: "a Rs 5000 Cr company by FY27")
  /(?:a\s+)?(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+company\s+by\s+(fy\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,

  // lakh crore: "revenue of Rs 1.5 lakh crore by FY28"
  /(?:revenue|turnover|sales)\s+(?:target|of|guidance)?\s+(?:rs\.?|₹)?\s*([\d.]+)\s*lakh\s*crore\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,

  // "targeting Rs X Cr / Rs X bn revenue"
  /target(?:ing)?\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:revenue|turnover|sales)\b/gi,

  // "revenue of Rs X Cr" without year (use current FY)
  /(?:revenue|turnover)\s+(?:target|guidance|vision)\s+(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/gi,

  // "3x / 2x revenue by FY28"
  /(\d+(?:\.\d+)?)\s*[x×]\s+(?:revenue|turnover|sales|growth)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
];

// ── EBITDA / margin patterns ──────────────────────────────────────────────────
const EBITDA_PATTERNS = [
  /ebitda\s+margin\s+(?:guidance|target|aim|of|expected|forecast|vision)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent|per\s+cent)\s*(?:by|in|for)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,
  /(?:target|expect|aim|aspire)\s+(?:ebitda\s+)?margin\s+(?:of|at|to)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
  /margin\s+(?:improvement|expansion|target|guidance)\s+(?:of|to|at)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)/gi,
  /ebitda\s+(?:of|at|around|approximately)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)\s+(?:by|in|for)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,
  /operating\s+(?:profit\s+)?margin\s+(?:target|guidance|of|at)\s+(\d+(?:\.\d+)?)\s*(?:%|percent)/gi,
  /(?:expand|improve|achieve|maintain)\s+(?:ebitda\s+)?margin\s+to\s+(\d+(?:\.\d+)?)\s*(?:%|percent)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
  /(\d+(?:\.\d+)?)\s*(?:%|percent)\s+ebitda\s+(?:margin\s+)?(?:target|by|in|for|guidance)/gi,
];

// ── Capex patterns ────────────────────────────────────────────────────────────
const CAPEX_PATTERNS = [
  /capex\s+(?:of|plan|guidance|budget|target|outlay|spend|investment)\s+(?:of\s+)?(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:for|in|over|during|per\s+year)?\s*(?:the\s+)?(?:next\s+)?(fy\d{2,4}|\d{1,2}\s*year[s]?|\d{4}(?:-\d{2,4})?)?/gi,
  /(?:plan\s+to\s+)?invest\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:in\s+capex|as\s+capex|for\s+capex|towards\s+capex|in\s+capital)/gi,
  /capital\s+expenditure\s+(?:of|plan\s+of|budget\s+of|target)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)/gi,
  /(?:rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:capex|capital\s+expenditure)\s+(?:for|in|over|planned\s+for|over\s+next)\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?|\d+\s*year[s]?)?/gi,
  /capex\s+guidance\s+of\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)/gi,
  /(?:total|annual|planned)\s+capex\s+of\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)/gi,
];

// ── Order inflow / pipeline patterns ─────────────────────────────────────────
const ORDER_INFLOW_PATTERNS = [
  // Standard order inflow
  /order\s+(?:inflow|intake|addition|win[s]?)\s+(?:guidance|target|of|expected|projected|vision)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s*(?:for|in|by|per\s+year)?\s*(fy\d{2,4}|\d{4}(?:-\d{2,4})?)?/gi,

  // Target order inflow
  /(?:target|expect|plan|aspire)\s+(?:(?:order\s+)?inflow|order\s+intake)\s+of\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:in|for|by)\s+(fy\d{2,4}|\d{4}(?:-\d{2,4})?)/gi,

  // Pipeline / bid pipeline
  /(?:bid\s+)?pipeline\s+of\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/gi,

  // Order book target
  /order\s+book\s+(?:target|guidance|of|vision|aspiration)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,

  // L1 position / tender pipeline (Indian-specific)
  /L1\s+position[s]?\s+(?:of|worth|aggregating)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/gi,
  /tender\s+pipeline\s+(?:of|at|worth)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/gi,

  // Business development pipeline
  /business\s+(?:development\s+)?pipeline\s+(?:of|worth|at)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/gi,

  // "opportunities worth Rs X Cr"
  /opportunities\s+(?:of|worth|valued\s+at|aggregating)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/gi,

  // Annual order inflow target without explicit year
  /annual\s+order\s+(?:inflow|intake|win)\s+(?:target|of|guidance)\s+(?:rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/gi,
];

// ── Capacity patterns ─────────────────────────────────────────────────────────
const CAPACITY_PATTERNS = [
  /capacity\s+(?:expansion|addition|target|of|vision)\s+(?:to\s+)?([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa|units|mmt|mmscmd|beds|km|klpd|kl\b)/gi,
  /(?:expand|increase|grow|scale)\s+capacity\s+(?:to|by)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa|units|mmt|beds|km|klpd)\s+(?:by|in)\s+(fy\d{2,4}|\d{4})/gi,
  /(?:target|plan|aim|aspire)\s+(?:to\s+)?(?:achieve|reach|build|install|commission)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa|units|klpd)\s+(?:capacity)?/gi,
  /installed\s+capacity\s+(?:to\s+reach|of|target)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa)/gi,
  /total\s+capacity\s+(?:of|to\s+reach|target)\s+([\d,]+(?:\.\d+)?)\s*(mw|gw|mtpa|mt\b|tpa|beds)/gi,
  /([\d,]+(?:\.\d+)?)\s*(mw|gw)\s+(?:capacity\s+)?(?:by|in|target|vision)\s+(fy\d{2,4}|\d{4})/gi,
];

// ── Core extraction function ──────────────────────────────────────────────────

function extractGuidanceFromText(rawText) {
  if (!rawText || rawText.length < 100) return null;

  // Normalise: lowercase, remove commas from numbers, standardise currency
  const text = rawText
    .toLowerCase()
    .replace(/rs\.\s+/gi, "rs.")
    .replace(/inr\s+/gi, "inr ")
    .replace(/₹\s+/g, "₹")
    .replace(/crores\b/gi, "crore")
    .replace(/\bkr\b/gi, "crore")   // "Kr" sometimes used
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ");

  const guidance = {
    revenue:  [],
    ebitda:   [],
    capex:    [],
    orders:   [],
    capacity: [],
    rawText:  rawText.substring(0, 3000)
  };

  // ── Revenue ───────────────────────────────────────────────────────────────
  for (const pattern of REVENUE_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      let amount = null, fyRaw = null;

      // Groups: some patterns have (amount, fy), some (fy, amount), some just (amount)
      const g1 = m[1] ? m[1].replace(/,/g, "") : null;
      const g2 = m[2] ? m[2].replace(/,/g, "") : null;

      if (g1 && /^[\d.]+$/.test(g1) && parseFloat(g1) > 10) {
        amount = parseFloat(g1);
        fyRaw  = g2;
      } else if (g2 && /^[\d.]+$/.test(g2) && parseFloat(g2) > 10) {
        amount = parseFloat(g2);
        fyRaw  = g1;
      }

      // lakh crore conversion
      if (m[0].includes("lakh crore") && amount) amount = amount * 100000;

      // Sanity: revenue between Rs 10 Cr and Rs 50 lakh Cr
      if (!amount || amount < 10 || amount > 5000000) continue;

      const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
      if (!fy) continue;

      if (!guidance.revenue.find(r => r.year === fy)) {
        const displayAmt = amount >= 1000
          ? `${(amount / 1000).toFixed(1)}K`
          : amount.toFixed(0);
        guidance.revenue.push({
          year:     fy,
          targetCr: Math.round(amount),
          label:    `Revenue target ₹${displayAmt}Cr by ${fy}`
        });
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
      if (!pct || pct <= 0 || pct > 80) continue;  // EBITDA margin 0-80% is sane
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

  // ── Capex ─────────────────────────────────────────────────────────────────
  for (const pattern of CAPEX_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const amount = parseFloat((m[1] || "0").replace(/,/g, ""));
      const fyRaw  = m[2] || null;
      if (!amount || amount <= 0 || amount > 500000) continue;
      const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
      if (!guidance.capex.find(c => c.year === fy)) {
        const displayAmt = amount >= 1000
          ? `${(amount / 1000).toFixed(1)}K`
          : amount.toFixed(0);
        guidance.capex.push({
          year:     fy,
          targetCr: Math.round(amount),
          label:    `Capex plan ₹${displayAmt}Cr for ${fy}`
        });
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
      if (!amount || amount <= 0 || amount > 10000000) continue;
      const fy = fyRaw ? normalizeFY(fyRaw) : getCurrentFY();
      if (!guidance.orders.find(o => o.year === fy)) {
        const displayAmt = amount >= 1000
          ? `${(amount / 1000).toFixed(1)}K`
          : amount.toFixed(0);
        guidance.orders.push({
          year:     fy,
          targetCr: Math.round(amount),
          label:    `Order inflow target ₹${displayAmt}Cr in ${fy}`
        });
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
      if (!target || target <= 0) continue;
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

  const hasData = (
    guidance.revenue.length  > 0 ||
    guidance.ebitda.length   > 0 ||
    guidance.capex.length    > 0 ||
    guidance.orders.length   > 0 ||
    guidance.capacity.length > 0
  );

  // Debug log what was found
  if (hasData) {
    console.log(`📊 Guidance found: rev=${guidance.revenue.length} ebitda=${guidance.ebitda.length} capex=${guidance.capex.length} orders=${guidance.orders.length} capacity=${guidance.capacity.length}`);
  } else {
    // Log a sample of the text to help debug pattern misses
    const sample = rawText.substring(0, 500).replace(/\s+/g, " ");
    console.log(`📊 No guidance in text sample: "${sample}"`);
  }

  return { ...guidance, hasData };
}

// ── BSE API — fetch investor presentations for a scrip ────────────────────────
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
    if (Array.isArray(data))             list = data;
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
        scrip:      String(scrip),
        company:    item.SLONGNAME || item.companyname || "Unknown",
        headline:   item.HEADLINE  || "",
        filingDate: item.DT_TM    || item.NEWS_DT || null,
        pdfUrl:     `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${item.ATTACHMENTNAME}`
      }));

  } catch (err) {
    console.log(`⚠️ Presentation fetch failed for ${scrip}: ${err.message}`);
    return [];
  }
}

// ── Parse a single presentation ───────────────────────────────────────────────

async function parsePresentation({ scrip, company, pdfUrl, filingDate, headline }) {
  // Skip meeting notices (they have no PDF content worth parsing)
  if (isMeetingNotice(headline)) {
    console.log(`📊 Meeting notice — skipping PDF parse: ${company} — ${headline.substring(0, 60)}`);
    return null;
  }

  console.log(`📊 Parsing presentation: ${company} — ${headline.substring(0, 60)}`);

  const rawText = await fetchPDFText(pdfUrl);
  if (!rawText || rawText.trim().length < 200) {
    console.log(`📊 Skipped — insufficient text: ${company}`);
    return null;
  }

  const guidance = extractGuidanceFromText(rawText);
  if (!guidance || !guidance.hasData) {
    console.log(`📊 Skipped — no guidance found: ${company}`);
    return null;
  }

  // Quarter from filing date
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
    credibility: {
      revenueHitRate: null, ebitdaHitRate: null,
      orderHitRate:   null, overallScore:  null, checkedAt: null
    }
  };

  // Persist to MongoDB
  try {
    const Model = getModel();
    await Model.findOneAndUpdate(
      { scrip, pdfUrl },
      { $set: doc },
      { upsert: true, returnDocument: 'after' }
    );
    console.log(`✅ Guidance saved: ${company} — rev:${guidance.revenue.length} ebitda:${guidance.ebitda.length} capex:${guidance.capex.length} orders:${guidance.orders.length}`);
  } catch (err) {
    console.log(`⚠️ Guidance save failed: ${err.message}`);
  }

  guidanceCache.set(String(scrip), doc);
  return doc;
}

// ── Called from bseListener.js for live filings ───────────────────────────────

async function handleLivePresentationFiling(signal, ioRef) {
  if (!isPresentationFiling(signal.title) || !signal.pdfUrl) return null;

  const doc = await parsePresentation({
    scrip:      signal.code,
    company:    signal.company,
    pdfUrl:     signal.pdfUrl,
    filingDate: signal.time,
    headline:   signal.title
  });

  if (doc && ioRef) {
    ioRef.emit("guidance_update", formatForClient(doc));
    console.log(`📡 guidance_update emitted: ${signal.company}`);
  }

  return doc;
}

// ── Batch scan ────────────────────────────────────────────────────────────────

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
      const cached = guidanceCache.get(scrip);
      if (cached && (Date.now() - cached.extractedAt) < 7 * 24 * 60 * 60 * 1000) {
        skipped++;
        continue;
      }

      const presentations = await fetchPresentationsForScrip(scrip, cookie);
      if (!presentations.length) { skipped++; continue; }

      const latest = presentations[0];
      const doc    = await parsePresentation(latest);

      if (doc) {
        results.push(doc);
        parsed++;
        if (ioRef) ioRef.emit("guidance_update", formatForClient(doc));
      } else {
        skipped++;
      }

      await new Promise(r => setTimeout(r, 1500 + Math.random() * 500));

    } catch (err) {
      console.log(`⚠️ Batch parse error for ${scrip}: ${err.message}`);
      skipped++;
    }

    if ((i + 1) % 10 === 0) {
      console.log(`📊 Batch progress: ${i+1}/${scripList.length} — parsed:${parsed} skipped:${skipped}`);
    }
  }

  console.log(`✅ Batch scan complete: parsed=${parsed} skipped=${skipped}`);
  return results;
}

// ── Queries ───────────────────────────────────────────────────────────────────

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

// ── Format for client ─────────────────────────────────────────────────────────
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
  isPresentationFiling,
  isMeetingNotice,
  handleLivePresentationFiling,
  batchScan,
  fetchPresentationsForScrip,
  parsePresentation,
  getGuidanceForScrip,
  getAllGuidance,
  formatForClient,
  loadCacheFromMongo,
  extractGuidanceFromText,
  extractRawTextFromBuffer,
  getModel,          // exported for credibilityEngine.js
};