/**
 * orderDetector.js
 * Returns { crores, years, periodLabel } from announcement text.
 * Score is based on crores ONLY — time period is context, not penalty.
 */

function extractCrores(t) {
  const croreMatch = t.match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i);
  if (croreMatch) return parseFloat(croreMatch[1].replace(/,/g, ""));

  const croreOnly = t.match(/([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i);
  if (croreOnly) return parseFloat(croreOnly[1].replace(/,/g, ""));

  const billionMatch = t.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*billion/i);
  if (billionMatch) return parseFloat(billionMatch[1].replace(/,/g, "")) * 100;

  const millionMatch = t.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*million/i);
  if (millionMatch) return parseFloat(millionMatch[1].replace(/,/g, "")) * 0.1;

  const lakhMatch = t.match(/([\d,]+(?:\.\d+)?)\s*lakh/i);
  if (lakhMatch) return parseFloat(lakhMatch[1].replace(/,/g, "")) * 0.01;

  return null;
}

function extractPeriod(t) {
  // "over 18 years", "for 5 years", "period of 3 years", "18-year"
  const yearMatch = t.match(/(?:over|for|period of|tenure of|duration of|of)?\s*(\d+(?:\.\d+)?)\s*-?\s*year/i);
  if (yearMatch) {
    const y = parseFloat(yearMatch[1]);
    if (y >= 1 && y <= 50) return { years: y, label: `${y}yr` };
  }

  // "for 36 months", "over 24 months", "12 months"
  const monthMatch = t.match(/(?:over|for|period of|of)?\s*(\d+)\s*months?\b/i);
  if (monthMatch) {
    const m = parseFloat(monthMatch[1]);
    if (m >= 3 && m <= 600) {
      const y = Math.round((m / 12) * 10) / 10;
      return { years: y, label: m < 24 ? `${m}mo` : `${y}yr` };
    }
  }

  return null;
}

function orderDetector(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  const crores = extractCrores(t);
  if (!crores) return null;

  const period = extractPeriod(t);

  return {
    crores,
    years: period ? period.years : null,
    periodLabel: period ? period.label : null,
    annualCrores: period ? Math.round(crores / period.years) : null
  };
}

module.exports = orderDetector;