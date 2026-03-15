/**
 * orderDetector.js
 * Returns { crores, years, periodLabel, annualCrores } from announcement text.
 * Also handles MW-based power orders where crore value is not in headline.
 */

function extractCrores(t) {
  // Remove time/unit references that could be mistaken for crore values
  const cleaned = t
    .replace(/regulation\s+\d+/gi, "")
    .replace(/reg\.\s*\d+/gi, "")
    .replace(/section\s+\d+/gi, "")
    .replace(/\d+\s*months?\b/gi, "")
    .replace(/\d+\s*years?\b/gi, "")
    .replace(/\d+\s*mld\b/gi, "")
    .replace(/\d+\s*mw\b/gi, "")
    .replace(/\d+\s*gw\b/gi, "")
    .replace(/\d+\s*km\b/gi, "")
    .replace(/\d+\s*kwh\b/gi, "");

  const croreMatch = cleaned.match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i);
  if (croreMatch) return parseFloat(croreMatch[1].replace(/,/g, ""));

  const croreOnly = cleaned.match(/([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i);
  if (croreOnly) return parseFloat(croreOnly[1].replace(/,/g, ""));

  const billionMatch = cleaned.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*billion/i);
  if (billionMatch) return parseFloat(billionMatch[1].replace(/,/g, "")) * 100;

  const millionMatch = cleaned.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*million/i);
  if (millionMatch) return parseFloat(millionMatch[1].replace(/,/g, "")) * 0.1;

  const lakhMatch = cleaned.match(/([\d,]+(?:\.\d+)?)\s*lakh/i);
  if (lakhMatch) return parseFloat(lakhMatch[1].replace(/,/g, "")) * 0.01;

  return null;
}

function extractPeriod(t) {
  const yearMatch = t.match(/(?:over|for|period of|tenure of|duration of|of)?\s*(\d+(?:\.\d+)?)\s*-?\s*year/i);
  if (yearMatch) {
    const y = parseFloat(yearMatch[1]);
    if (y >= 1 && y <= 50) return { years: y, label: `${y}yr` };
  }

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

// ── MW-based power orders ──
// Adani Power style: "1600 MW Thermal Power for 25 years at Rs 5.30/kWh"
// No crore value in headline — estimate from MW × tariff × years
function extractMWOrder(t) {
  const mwMatch = t.match(/([\d,]+(?:\.\d+)?)\s*(?:,\s*)?\s*mw\b/i);
  if (!mwMatch) return null;

  const mw = parseFloat(mwMatch[1].replace(/,/g, ""));
  if (mw < 10 || mw > 100000) return null; // sanity check

  // Extract tariff: "Rs 5.30/kWh", "₹4.50 per unit"
  const tariffMatch = t.match(/(?:rs\.?|₹)\s*(\d+\.?\d*)\s*(?:\/kwh|per\s*unit|\/unit|per\s*kwh)/i);
  const tariff = tariffMatch ? parseFloat(tariffMatch[1]) : 4.5; // default ₹4.5/kWh thermal

  // Extract years
  const period = extractPeriod(t);
  const years  = period?.years || 25; // default 25yr for power PSA

  // Annual revenue estimate: MW × PLF(0.7) × 8760hrs × tariff(₹/kWh) ÷ 1Cr(10M)
  const annualCrores = Math.round(mw * 0.7 * 8760 * tariff / 10000000);
  const totalCrores  = Math.round(annualCrores * years);

  console.log(`⚡ MW Order detected: ${mw}MW × ₹${tariff}/kWh × ${years}yr = ₹${totalCrores}Cr total, ₹${annualCrores}Cr/yr`);

  return {
    crores:       totalCrores,
    annualCrores,
    years,
    periodLabel:  `${years}yr`,
    mw,
    isMWBased:    true
  };
}

function orderDetector(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  // Try crore extraction first
  const crores = extractCrores(t);
  if (crores) {
    const period = extractPeriod(t);
    return {
      crores,
      years:        period?.years || null,
      periodLabel:  period?.label || null,
      annualCrores: period ? Math.round(crores / period.years) : null
    };
  }

  // Fallback: MW-based power sector orders
  const mwOrder = extractMWOrder(t);
  if (mwOrder) return mwOrder;

  return null;
}

module.exports = orderDetector;