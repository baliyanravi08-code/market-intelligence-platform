/**
 * pdfReader.js
 * Fetches a BSE PDF and extracts order value from text.
 * Only called for ORDER_ALERT signals with no crore value in headline.
 */

const axios    = require("axios");
const pdfParse = require("pdf-parse");

const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":    "https://www.bseindia.com",
  "Accept":     "application/pdf,*/*"
};

// Cache to avoid re-fetching same PDF
const pdfCache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function extractOrderValueFromPDF(pdfUrl) {
  if (!pdfUrl) return null;

  // Return cached result
  if (pdfCache[pdfUrl] && (Date.now() - pdfCache[pdfUrl].fetchedAt) < CACHE_TTL) {
    return pdfCache[pdfUrl].crores;
  }

  try {
    console.log(`📄 PDF fetch: ${pdfUrl.substring(0, 60)}...`);

    const res = await axios.get(pdfUrl, {
      headers:      BSE_HEADERS,
      responseType: "arraybuffer",
      timeout:      10000
    });

    const data = await pdfParse(Buffer.from(res.data));
    const text = data.text || "";

    const crores = extractCroresFromText(text);

    console.log(`📄 PDF result: ${crores ? `₹${crores}Cr` : "no value found"}`);

    pdfCache[pdfUrl] = { crores, fetchedAt: Date.now() };
    return crores;

  } catch (err) {
    console.log(`📄 PDF failed: ${err.message}`);
    pdfCache[pdfUrl] = { crores: null, fetchedAt: Date.now() };
    return null;
  }
}

function extractCroresFromText(text) {
  if (!text) return null;

  const t = text
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ");

  // ── Pattern 1: Rs.7,51,10,062 or Rs. 62,36,000 (Indian format raw numbers) ──
  const rawRupee = t.match(/(?:rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\s*(?:only|\/\-)?/gi);
  if (rawRupee) {
    // Find the largest amount — likely the total contract value
    let maxCrores = null;
    for (const match of rawRupee) {
      const numMatch = match.match(/([\d,]+(?:\.\d+)?)/);
      if (!numMatch) continue;
      const raw = parseFloat(numMatch[1].replace(/,/g, ""));
      if (raw >= 100000) { // at least 1 lakh
        const crores = parseFloat((raw / 10000000).toFixed(2));
        if (!maxCrores || crores > maxCrores) maxCrores = crores;
      }
    }
    if (maxCrores) return maxCrores;
  }

  // ── Pattern 2: 7.51 Crore / 62.36 Crores ──
  const croreMatch = t.match(/([\d,]+(?:\.\d+)?)\s*(?:crores?|cr\.?\b)/i);
  if (croreMatch) {
    const val = parseFloat(croreMatch[1].replace(/,/g, ""));
    if (val > 0) return val;
  }

  // ── Pattern 3: Words like "Seven Crore Fifty One Lakh" ──
  const wordMatch = t.match(/(?:total\s+)?(?:order|contract|project|work)?\s*(?:value|amount|worth)[^\n]{0,50}(?:rupees?\s+)?([a-z\s]+crore[a-z\s]*)/i);
  if (wordMatch) {
    const crores = wordsToNumber(wordMatch[1]);
    if (crores) return crores;
  }

  // ── Pattern 4: INR / USD amounts ──
  const inrMatch = t.match(/(?:inr|usd)\s*([\d,]+(?:\.\d+)?)\s*(?:crores?|cr|million|lakh)?/i);
  if (inrMatch) {
    const val   = parseFloat(inrMatch[1].replace(/,/g, ""));
    const unit  = inrMatch[0].toLowerCase();
    if (unit.includes("million")) return val * 0.1;
    if (unit.includes("lakh"))    return val / 100;
    if (unit.includes("crore") || unit.includes("cr")) return val;
    if (val >= 10000000) return parseFloat((val / 10000000).toFixed(2));
  }

  return null;
}

// Convert "Seven Crore Fifty One Lakh" → 7.51
function wordsToNumber(text) {
  const t = text.toLowerCase().trim();
  const ones = ["zero","one","two","three","four","five","six","seven","eight","nine",
                 "ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen",
                 "seventeen","eighteen","nineteen"];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];

  let total = 0;
  let current = 0;

  const words = t.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const oneIdx = ones.indexOf(w);
    const tenIdx = tens.indexOf(w);

    if (oneIdx !== -1)      current += oneIdx;
    else if (tenIdx !== -1) current += tenIdx * 10;
    else if (w === "hundred") current *= 100;
    else if (w === "crore" || w === "crores") {
      total += current * 10000000;
      current = 0;
    }
    else if (w === "lakh" || w === "lakhs") {
      total += current * 100000;
      current = 0;
    }
    else if (w === "thousand") {
      current *= 1000;
    }
  }
  total += current;

  if (total === 0) return null;
  return parseFloat((total / 10000000).toFixed(2)); // to crores
}

module.exports = { extractOrderValueFromPDF };