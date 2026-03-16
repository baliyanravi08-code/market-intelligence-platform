/**
 * orderDetector.js
 * Returns { crores, years, periodLabel, annualCrores } from announcement text.
 */

function extractCrores(t) {

  const cleaned = t
    .replace(/regulation\s+\d+/gi, "")
    .replace(/reg\.\s*\d+/gi, "")
    .replace(/section\s+\d+/gi, "")
    .replace(/\d+\s*months?\b/gi, "")
    .replace(/\d+\s*years?\b/gi, "");

  const croreMatch = cleaned.match(/(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(?:crore|crores|cr)\b/i);
  if (croreMatch) return parseFloat(croreMatch[1].replace(/,/g, ""));

  const billionMatch = cleaned.match(/([\d,]+(?:\.\d+)?)\s*billion/i);
  if (billionMatch) return parseFloat(billionMatch[1].replace(/,/g, "")) * 100;

  const millionMatch = cleaned.match(/([\d,]+(?:\.\d+)?)\s*million/i);
  if (millionMatch) return parseFloat(millionMatch[1].replace(/,/g, "")) * 0.1;

  return null;
}

function extractPeriod(t) {

  const yearMatch = t.match(/(\d+(?:\.\d+)?)\s*year/i);
  if (yearMatch) {
    const y = parseFloat(yearMatch[1]);
    return { years: y, label: `${y}yr` };
  }

  const monthMatch = t.match(/(\d+)\s*months?/i);
  if (monthMatch) {
    const m = parseFloat(monthMatch[1]);
    const y = Math.round((m / 12) * 10) / 10;
    return { years: y, label: `${m}mo` };
  }

  return null;
}

function orderDetector(text) {

  if (!text) return null;

  const t = text.toLowerCase();

  const crores = extractCrores(t);

  if (crores) {

    const period = extractPeriod(t);

    return {
      crores,
      years: period?.years || null,
      periodLabel: period?.label || null,
      annualCrores: period ? Math.round(crores / period.years) : null
    };
  }

  return null;
}

module.exports = orderDetector;