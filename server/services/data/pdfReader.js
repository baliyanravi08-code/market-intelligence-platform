/**
 * pdfReader.js
 * Extracts order values from BSE PDFs.
 * Uses direct buffer parsing — no pdf-parse library needed.
 */

const axios = require("axios");

const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":    "https://www.bseindia.com",
  "Accept":     "application/pdf,*/*"
};

const pdfCache  = {};
const CACHE_TTL = 60 * 60 * 1000;

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

    // Extract readable text from PDF buffer without any library
    // PDFs contain stream text between BT/ET markers and plain strings
    const text   = extractTextFromPDFBuffer(Buffer.from(res.data));
    const crores = extractCroresFromText(text);

    console.log(`📄 PDF text length: ${text.length}, result: ${crores ? `₹${crores}Cr` : "no value"}`);

    pdfCache[pdfUrl] = { crores, fetchedAt: Date.now() };
    return crores;

  } catch (err) {
    console.log(`📄 PDF failed: ${err.message}`);
    pdfCache[pdfUrl] = { crores: null, fetchedAt: Date.now() };
    return null;
  }
}

/**
 * Extract readable ASCII text from a PDF buffer.
 * PDFs store text in streams — we extract printable ASCII chunks.
 * Not perfect but good enough for Indian BSE filings which use simple text.
 */
function extractTextFromPDFBuffer(buf) {
  const str = buf.toString("latin1"); // latin1 preserves all bytes

  let text = "";

  // Method 1: Extract text between parentheses (PDF string literals)
  // PDF text: (Hello World) Tj  or [(H)(e)(l)(l)(o)] TJ
  const parenRegex = /\(([^)]{1,200})\)\s*(?:Tj|TJ|'|")/g;
  let m;
  while ((m = parenRegex.exec(str)) !== null) {
    const chunk = m[1]
      .replace(/\\n/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\d{3}/g, " ")  // octal escapes
      .replace(/\\(.)/g, "$1");   // other escapes
    // Only keep printable ASCII
    const clean = chunk.replace(/[^\x20-\x7E\u20B9]/g, " ").trim();
    if (clean.length > 1) text += clean + " ";
  }

  // Method 2: Also scan raw stream for rupee/number patterns
  // Look for readable sequences with ₹ or Rs in the raw bytes
  const rsPattern = /Rs\.?\s*[\d,]+/gi;
  const rawMatches = str.match(rsPattern) || [];
  text += " " + rawMatches.join(" ");

  return text;
}

function extractCroresFromText(rawText) {
  if (!rawText || rawText.length < 5) return null;

  const t = rawText
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[''`´]/g, "'")
    .toLowerCase();

  // 1. Symbol + crore: "rs.62.36 crores" "inr 22.50 crore"
  const sym = t.match(/(?:rs\.?|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crores?|cr)\b/gi);
  if (sym) {
    const vals = sym.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g, "")) : 0;
    }).filter(v => v > 0 && v < 100000);
    if (vals.length) return Math.max(...vals);
  }

  // 2. Crore only: "22.50 crores" "7.51 crore"
  const cr = t.match(/([\d,]+(?:\.\d+)?)\s*(?:crores?)\b/g);
  if (cr) {
    const vals = cr.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g, "")) : 0;
    }).filter(v => v > 0 && v < 100000);
    if (vals.length) return Math.max(...vals);
  }

  // 3. OCR artifact: "worth ,5.50 crores"
  const ocr = t.match(/(?:worth|value|amount)\s*[,'t]\s*([\d.]+)\s*(?:crores?|cr)\b/g);
  if (ocr) {
    const vals = ocr.map(m => {
      const n = m.match(/([\d.]+)\s*(?:crores?|cr)/);
      return n ? parseFloat(n[1]) : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  // 4. Raw Indian rupee: Rs.7,51,10,062
  const raw = t.match(/rs\.?\s*([\d,]+(?:\.\d+)?)\b/g);
  if (raw) {
    let max = null;
    for (const m of raw) {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      if (!n) continue;
      const v = parseFloat(n[1].replace(/,/g, ""));
      if (v >= 100000) {
        const c = parseFloat((v / 10000000).toFixed(2));
        if (!max || c > max) max = c;
      }
    }
    if (max) return max;
  }

  // 5. Lakh amounts
  const lakh = t.match(/([\d,]+(?:\.\d+)?)\s*lakhs?\b/g);
  if (lakh) {
    const vals = lakh.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g, "")) / 100 : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  // 6. Word amounts
  const wm = t.match(/(?:value|amount|worth)[^.]{0,100}((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|crore)\s*)+)/i);
  if (wm) {
    const c = wordsToNumber(wm[1]);
    if (c) return c;
  }

  return null;
}

function wordsToNumber(text) {
  const t = text.toLowerCase().trim();
  const ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  let total = 0, current = 0;
  for (const w of t.split(/\s+/)) {
    const oi = ones.indexOf(w), ti = tens.indexOf(w);
    if      (oi !== -1)               current += oi;
    else if (ti !== -1)               current += ti * 10;
    else if (w === "hundred")         current *= 100;
    else if (w === "thousand")        current *= 1000;
    else if (w === "lakh"  || w === "lakhs")  { total += current * 100000;    current = 0; }
    else if (w === "crore" || w === "crores") { total += current * 10000000;  current = 0; }
  }
  total += current;
  if (total === 0) return null;
  return parseFloat((total / 10000000).toFixed(2));
}

module.exports = { extractOrderValueFromPDF };