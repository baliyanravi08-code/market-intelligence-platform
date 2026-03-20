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

const pdfCache  = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function extractOrderValueFromPDF(pdfUrl) {
  if (!pdfUrl) return null;

  if (pdfCache[pdfUrl] && (Date.now() - pdfCache[pdfUrl].fetchedAt) < CACHE_TTL) {
    return pdfCache[pdfUrl].crores;
  }

  try {
    console.log(`📄 PDF fetch: ${pdfUrl.substring(0, 70)}...`);

    const res = await axios.get(pdfUrl, {
      headers:      BSE_HEADERS,
      responseType: "arraybuffer",
      timeout:      12000
    });

    const data   = await pdfParse(Buffer.from(res.data));
    const text   = data.text || "";
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

function extractCroresFromText(rawText) {
  if (!rawText) return null;

  // Normalize whitespace + common OCR artifacts
  const t = rawText
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    // Fix OCR artifacts: 't5.50' or 'tS.50' → '5.50', ',5.50' → '5.50'
    .replace(/[',`´''](\d)/g, " $1")
    // Fix 'tS.50' where t = ₹ in bad OCR
    .replace(/\bt(\d)/g, " $1");

  // ── 1. Explicit crore/cr mention with currency symbol ──
  // "Rs.7,51,10,062" or "₹62.36 Crores" or "INR 5.50 crore"
  const croreWithSymbol = t.match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crores?|cr)\b/gi);
  if (croreWithSymbol) {
    const vals = croreWithSymbol.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g, "")) : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  // ── 2. Crore mention without symbol ──
  // "5.50 crores" "62.36 Crore"
  const croreOnly = t.match(/([\d,]+(?:\.\d+)?)\s*(?:crores?)\b/gi);
  if (croreOnly) {
    const vals = croreOnly.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g, "")) : 0;
    }).filter(v => v > 0 && v < 100000); // sanity: <1 lakh crores
    if (vals.length) return Math.max(...vals);
  }

  // ── 3. OCR artifact: "worth ,5.50 crores" or "worth '5.50 crores" ──
  const ocrWorth = t.match(/(?:worth|value|amount|order of)\s*[,.'`'´~t₹]\s*([\d.]+)\s*(?:crores?|cr)\b/gi);
  if (ocrWorth) {
    const vals = ocrWorth.map(m => {
      const n = m.match(/([\d.]+)\s*(?:crores?|cr)/i);
      return n ? parseFloat(n[1]) : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  // ── 4. Raw Indian rupee number ──
  // "Rs.7,51,10,062.06" → 7.51 Cr
  const rawRupee = t.match(/(?:rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\b/gi);
  if (rawRupee) {
    let maxCrores = null;
    for (const match of rawRupee) {
      const n = match.match(/([\d,]+(?:\.\d+)?)/);
      if (!n) continue;
      const raw = parseFloat(n[1].replace(/,/g, ""));
      if (raw >= 100000) {
        const cr = parseFloat((raw / 10000000).toFixed(2));
        if (!maxCrores || cr > maxCrores) maxCrores = cr;
      }
    }
    if (maxCrores) return maxCrores;
  }

  // ── 5. Word amounts: "Seven Crore Fifty One Lakh" ──
  const wordMatch = t.match(
    /(?:total\s+)?(?:order|contract|project|work)?\s*(?:value|amount|worth)[^.]{0,80}((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|crore)\s*)+)/i
  );
  if (wordMatch) {
    const cr = wordsToNumber(wordMatch[1]);
    if (cr) return cr;
  }

  // ── 6. Million amounts ──
  const millionMatch = t.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*million/gi);
  if (millionMatch) {
    const vals = millionMatch.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g, "")) * 0.1 : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  return null;
}

function wordsToNumber(text) {
  const t = text.toLowerCase().trim();
  const ones = [
    "zero","one","two","three","four","five","six","seven","eight","nine",
    "ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen",
    "seventeen","eighteen","nineteen"
  ];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];

  let total   = 0;
  let current = 0;

  for (const w of t.split(/\s+/)) {
    const oi = ones.indexOf(w);
    const ti = tens.indexOf(w);
    if      (oi !== -1)   current += oi;
    else if (ti !== -1)   current += ti * 10;
    else if (w === "hundred")            current *= 100;
    else if (w === "thousand")           current *= 1000;
    else if (w === "lakh" || w === "lakhs") {
      total   += current * 100000;
      current  = 0;
    }
    else if (w === "crore" || w === "crores") {
      total   += current * 10000000;
      current  = 0;
    }
  }
  total += current;

  if (total === 0) return null;
  return parseFloat((total / 10000000).toFixed(2));
}

module.exports = { extractOrderValueFromPDF };