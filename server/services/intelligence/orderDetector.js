/**
 * orderDetector.js
 * Extracts order value in crores from announcement headline text.
 * Handles: ₹500 Cr, Rs 120 crore, ₹3.2 billion, $50 million, etc.
 */

function orderDetector(text) {
  if (!text) return null;

  const t = text.toLowerCase();

  // Match patterns like: ₹500 crore, Rs 120 cr, INR 3,500 crore
  const croreMatch = t.match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crore|cr)/i);
  if (croreMatch) {
    return parseFloat(croreMatch[1].replace(/,/g, ""));
  }

  // Match: 500 crore / 120 cr (without currency symbol)
  const croreOnly = t.match(/([\d,]+(?:\.\d+)?)\s*(?:crore|cr)\b/i);
  if (croreOnly) {
    return parseFloat(croreOnly[1].replace(/,/g, ""));
  }

  // Match billion → convert to crore (1 billion = 100 crore)
  const billionMatch = t.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*billion/i);
  if (billionMatch) {
    return parseFloat(billionMatch[1].replace(/,/g, "")) * 100;
  }

  // Match million → convert to crore (1 million = 0.1 crore)
  const millionMatch = t.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*million/i);
  if (millionMatch) {
    return parseFloat(millionMatch[1].replace(/,/g, "")) * 0.1;
  }

  // Match lakh → convert to crore (1 lakh = 0.01 crore)
  const lakhMatch = t.match(/([\d,]+(?:\.\d+)?)\s*lakh/i);
  if (lakhMatch) {
    return parseFloat(lakhMatch[1].replace(/,/g, "")) * 0.01;
  }

  return null;
}

module.exports = orderDetector;