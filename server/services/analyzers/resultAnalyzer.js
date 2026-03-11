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
  "results for the half"
];

const POSITIVE_DIRECTION = ["up", "rise", "rises", "risen", "jump", "jumps", "surge", "surges", "growth", "grew", "increase", "increased", "higher", "improves", "improved"];
const NEGATIVE_DIRECTION = ["down", "fall", "falls", "fell", "drop", "drops", "decline", "declines", "declined", "lower", "dip", "dips", "slump", "loss", "negative"];

function isPositive(word) {
  return POSITIVE_DIRECTION.some(w => word?.toLowerCase().includes(w));
}
function isNegative(word) {
  return NEGATIVE_DIRECTION.some(w => word?.toLowerCase().includes(w));
}

function analyzeResult(data) {
  if (!data || !data.title) return null;

  const text = data.title.toLowerCase();
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

  // ── Revenue / Sales ──
  const revMatch = text.match(/(?:revenue|sales|total\s*income|net\s*sales)\s*(up|down|rises?|falls?|grew|declined?|jumps?)\s*(\d+\.?\d*)\s*%/i);
  if (revMatch) {
    const direction = revMatch[1];
    const pct = parseFloat(revMatch[2]);
    if (isPositive(direction)) {
      signals.push(`Rev +${pct}%`);
      score += pct >= 30 ? 20 : pct >= 15 ? 12 : 6;
    } else {
      signals.push(`Rev -${pct}%`);
      score = Math.max(5, score - 8);
    }
  }

  // ── EBITDA / Operating Profit ──
  const ebitdaMatch = text.match(/(?:ebitda|operating\s*profit|ebidta)\s*(up|down|rises?|falls?|grew|declined?)\s*(\d+\.?\d*)\s*%/i);
  if (ebitdaMatch) {
    const direction = ebitdaMatch[1];
    const pct = parseFloat(ebitdaMatch[2]);
    if (isPositive(direction)) {
      signals.push(`EBITDA +${pct}%`);
      score += pct >= 40 ? 20 : 10;
    } else {
      signals.push(`EBITDA -${pct}%`);
    }
  }

  // ── BANK SPECIFIC ──
  if (isBank) {
    // NII
    const niiMatch = text.match(/nii\s*(up|down|rises?|falls?|grew|declined?)\s*(\d+\.?\d*)\s*%/i);
    if (niiMatch) {
      const direction = niiMatch[1];
      const pct = parseFloat(niiMatch[2]);
      if (isPositive(direction)) {
        signals.push(`NII +${pct}%`);
        score += pct >= 20 ? 20 : 12;
      } else {
        signals.push(`NII -${pct}%`);
        score = Math.max(5, score - 10);
      }
    }

    // NIM
    const nimMatch = text.match(/nim\s*(up|down|rises?|falls?|improved?|expanded?|contracted?)\s*(\d+\.?\d*)/i);
    if (nimMatch) {
      const direction = nimMatch[1];
      if (isPositive(direction) || direction.toLowerCase().includes("improv") || direction.toLowerCase().includes("expand")) {
        signals.push("NIM↑");
        score += 15;
      } else {
        signals.push("NIM↓");
        score = Math.max(5, score - 10);
      }
    }

    // NPA — lower is better
    const npaMatch = text.match(/(?:gross\s*npa|gnpa|net\s*npa|nnpa)\s*(up|down|rises?|falls?|improved?|declined?|reduced?)\s*(\d+\.?\d*)\s*%?/i);
    if (npaMatch) {
      const direction = npaMatch[1];
      if (isNegative(direction) || direction.toLowerCase().includes("improv") || direction.toLowerCase().includes("reduc")) {
        signals.push("NPA↓ GOOD");
        score += 20;
      } else {
        signals.push("NPA↑ BAD");
        score = Math.max(5, score - 20);
      }
    }

    // CASA
    const casaMatch = text.match(/casa\s*(up|down|rises?|falls?|improved?|declined?)\s*(\d+\.?\d*)\s*%?/i);
    if (casaMatch && isPositive(casaMatch[1])) {
      signals.push("CASA↑");
      score += 10;
    }

    // PCR
    const pcrMatch = text.match(/(?:pcr|provision\s*coverage)\s*(up|down|improved?|declined?)\s*(\d+\.?\d*)\s*%?/i);
    if (pcrMatch && isPositive(pcrMatch[1])) {
      signals.push("PCR↑");
      score += 10;
    }
  }

  // ── SPECIAL KEYWORDS ──
  if (text.includes("record profit") || text.includes("highest ever") || text.includes("all time high profit")) {
    signals.push("RECORD HIGH");
    score += 25;
  }
  if (text.includes("turnaround") || text.includes("back to profit") || text.includes("returns to profit")) {
    signals.push("TURNAROUND");
    score += 30;
  }
  if (text.includes("beat") || text.includes("above estimate") || text.includes("above expectation")) {
    signals.push("BEAT");
    score += 15;
  }
  if (text.includes("miss") || text.includes("below estimate") || text.includes("below expectation")) {
    signals.push("MISS");
    score = Math.max(5, score - 15);
  }
  if ((text.includes("net loss") || text.includes("posts loss") || text.includes("reports loss")) && !text.includes("no loss")) {
    signals.push("NET LOSS");
    score = 5;
  }

  // if no signals extracted at all, it's a plain result filing — low score
  if (signals.length === 0) {
    score = 8;
    signals.push("RESULT FILED");
  }

  return {
    ...data,
    type: isBank ? "BANK_RESULT" : "RESULT",
    value: Math.min(Math.max(score, 5), 100),
    resultSignals: signals,
    isBank,
    ago: data.ago || "just now"
  };
}

module.exports = analyzeResult;