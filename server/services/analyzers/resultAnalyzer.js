/**
 * resultAnalyzer.js
 * Detects quarterly result filings and extracts:
 * - PAT / Revenue / EBITDA growth signals
 * - ORDER BOOK value (for EPC/infra companies)
 * Updates marketCap.js store with confirmed order book per quarter.
 */

const { updateFromResult, getCurrentFYQuarter } = require("../data/marketCap");

const BANK_KEYWORDS = [
  "bank", "nbfc", "financial services", "finance ltd",
  "housing finance", "microfinance", "insurance",
  "asset management", "capital ltd", "capital limited",
  "lending", "credit ltd", "credit limited"
];

function isBankOrNBFC(company) {
  const c = company.toLowerCase();
  return BANK_KEYWORDS.some(k => c.includes(k));
}

const RESULT_KEYWORDS = [
  "financial results", "quarterly results",
  "q1 result", "q2 result", "q3 result", "q4 result",
  "h1 result", "h2 result", "fy result",
  "half yearly result", "annual result",
  "unaudited result", "audited result",
  "results for the quarter", "results for the year",
  "results for the half", "q1fy", "q2fy", "q3fy", "q4fy"
];

const POSITIVE_DIRECTION = ["up","rise","rises","risen","jump","jumps","surge","surges","growth","grew","increase","increased","higher","improves","improved","expand","expands"];
const NEGATIVE_DIRECTION = ["down","fall","falls","fell","drop","drops","decline","declines","declined","lower","dip","dips","slump","loss","negative","contract","contracts"];

function isPositive(word) { return POSITIVE_DIRECTION.some(w => word?.toLowerCase().includes(w)); }
function isNegative(word) { return NEGATIVE_DIRECTION.some(w => word?.toLowerCase().includes(w)); }

// ── ORDER BOOK PATTERNS — matches various headline formats ──
const ORDER_BOOK_PATTERNS = [
  /order\s*book\s*(?:stands?\s*at|of|at|:)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /order\s*book\s*(?:of|at)\s*(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /order\s*backlog\s*(?:of|at|:)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /outstanding\s*orders?\s*(?:of|at|worth)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /order\s*inflow\s*(?:of|at)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /unexecuted\s*order\s*book\s*(?:of|at)?\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /total\s*order\s*book\s*(?:of|at|:)?\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
];

const REVENUE_PATTERNS = [
  /revenue\s*(?:of|at|:)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /total\s*income\s*(?:of|at|:)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /net\s*sales\s*(?:of|at|:)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
  /turnover\s*(?:of|at)\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i,
];

// ── Extract quarter from text ──
function extractQuarter(text) {
  // "Q3FY26", "Q3 FY26", "Q3FY2026"
  const qMatch = text.match(/q([1-4])\s*fy?\s*(\d{2,4})/i);
  if (qMatch) {
    const fy = String(qMatch[2]).slice(-2);
    return `Q${qMatch[1]}FY${fy}`;
  }
  // "H1FY26"
  const h1 = text.match(/h1\s*fy?\s*(\d{2,4})/i);
  if (h1) return `H1FY${String(h1[1]).slice(-2)}`;
  const h2 = text.match(/h2\s*fy?\s*(\d{2,4})/i);
  if (h2) return `H2FY${String(h2[1]).slice(-2)}`;

  // Fall back to current quarter
  return getCurrentFYQuarter();
}

function extractValue(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return parseFloat(match[1].replace(/,/g, ""));
  }
  return null;
}

function analyzeResult(data) {
  if (!data || !data.title) return null;

  const text    = data.title.toLowerCase();
  const company = (data.company || "").toLowerCase();

  const isResult = RESULT_KEYWORDS.some(k => text.includes(k));
  if (!isResult) return null;

  const isBank = isBankOrNBFC(company);
  let score = 10;
  let signals = [];

  // ── PAT / Net Profit ──
  const patMatch =
    text.match(/(?:pat|net\s*profit|profit\s*after\s*tax)\s*(up|down|rises?|risen|falls?|fell|jumps?|drops?|surges?|declines?|grows?|grew)\s*(\d+\.?\d*)\s*%/i) ||
    text.match(/(\d+\.?\d*)\s*%\s*(?:rise|jump|surge|growth|increase|fall|drop|decline)\s*in\s*(?:pat|net\s*profit)/i);

  if (patMatch) {
    const direction = patMatch[1];
    const pct = parseFloat(patMatch[2] || patMatch[1]);
    if (!isNaN(pct)) {
      if (isPositive(direction)) {
        signals.push(`PAT +${pct}%`);
        score += pct >= 100 ? 50 : pct >= 50 ? 40 : pct >= 25 ? 30 : pct >= 10 ? 20 : 10;
      } else if (isNegative(direction)) {
        signals.push(`PAT -${pct}%`);
        score = Math.max(5, score - 15);
      }
    }
  }

  // ── Revenue ──
  const revMatch = text.match(/(?:revenue|sales|total\s*income|net\s*sales)\s*(up|down|rises?|falls?|grew|declined?|jumps?)\s*(\d+\.?\d*)\s*%/i);
  if (revMatch) {
    const pct = parseFloat(revMatch[2]);
    if (isPositive(revMatch[1])) { signals.push(`Rev +${pct}%`); score += pct >= 30 ? 20 : pct >= 15 ? 12 : 6; }
    else { signals.push(`Rev -${pct}%`); score = Math.max(5, score - 8); }
  }

  // ── EBITDA ──
  const ebitdaMatch = text.match(/(?:ebitda|operating\s*profit|ebidta)\s*(up|down|rises?|falls?|grew|declined?)\s*(\d+\.?\d*)\s*%/i);
  if (ebitdaMatch) {
    const pct = parseFloat(ebitdaMatch[2]);
    if (isPositive(ebitdaMatch[1])) { signals.push(`EBITDA +${pct}%`); score += pct >= 40 ? 20 : 10; }
    else { signals.push(`EBITDA -${pct}%`); }
  }

  // ── BANK SPECIFIC ──
  if (isBank) {
    const niiMatch = text.match(/nii\s*(up|down|rises?|falls?|grew|declined?)\s*(\d+\.?\d*)\s*%/i);
    if (niiMatch) {
      const pct = parseFloat(niiMatch[2]);
      if (isPositive(niiMatch[1])) { signals.push(`NII +${pct}%`); score += pct >= 20 ? 20 : 12; }
      else { signals.push(`NII -${pct}%`); score = Math.max(5, score - 10); }
    }
    const npaMatch = text.match(/(?:gross\s*npa|gnpa|net\s*npa|nnpa)\s*(up|down|improved?|declined?|reduced?)\s*(\d+\.?\d*)\s*%?/i);
    if (npaMatch) {
      if (isNegative(npaMatch[1]) || npaMatch[1].toLowerCase().includes("reduc") || npaMatch[1].toLowerCase().includes("improv")) {
        signals.push("NPA↓"); score += 20;
      } else { signals.push("NPA↑"); score = Math.max(5, score - 20); }
    }
  }

  // ── SPECIAL KEYWORDS ──
  if (text.includes("record profit") || text.includes("highest ever") || text.includes("all time high")) { signals.push("RECORD"); score += 25; }
  if (text.includes("turnaround") || text.includes("back to profit") || text.includes("returns to profit")) { signals.push("TURNAROUND"); score += 30; }
  if (text.includes("beat") || text.includes("above estimate")) { signals.push("BEAT"); score += 15; }
  if (text.includes("miss") || text.includes("below estimate")) { signals.push("MISS"); score = Math.max(5, score - 15); }
  if ((text.includes("net loss") || text.includes("posts loss")) && !text.includes("no loss")) { signals.push("NET LOSS"); score = 5; }

  if (signals.length === 0) { score = 8; signals.push("RESULT FILED"); }

  // ── EXTRACT ORDER BOOK + REVENUE → update persistent store ──
  if (data.code) {
    const orderBook = extractValue(data.title, ORDER_BOOK_PATTERNS);
    const revenue   = extractValue(data.title, REVENUE_PATTERNS);
    const quarter   = extractQuarter(data.title);

    const update = {};

    if (orderBook && orderBook > 0) {
      update.confirmedOrderBook    = orderBook;
      update.confirmedQuarter      = quarter;
      update.newOrdersSinceConfirm = 0; // reset counter — new baseline set
      signals.push(`OB ₹${orderBook >= 1000 ? (orderBook/1000).toFixed(1)+"K" : orderBook}Cr`);
      score += 5;
      console.log(`📦 Order book confirmed: ${data.company} ₹${orderBook}Cr (${quarter})`);
    }

    if (revenue && revenue > 0) {
      update.ttmRevenue = revenue * 4; // quarterly → annualize TTM estimate
    }

    if (Object.keys(update).length > 0) {
      updateFromResult(String(data.code), update);
    }
  }

  return {
    ...data,
    type:          isBank ? "BANK_RESULT" : "RESULT",
    value:         Math.min(Math.max(score, 5), 100),
    resultSignals: signals,
    isBank,
    ago:           data.ago || "just now"
  };
}

module.exports = analyzeResult;