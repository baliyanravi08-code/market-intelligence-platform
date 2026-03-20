/**
 * pdfReader.js
 * Fetches BSE PDFs and extracts order values.
 * Polyfills DOMMatrix etc for Render deployment (no native canvas).
 */

const axios = require("axios");

const BSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":    "https://www.bseindia.com",
  "Accept":     "application/pdf,*/*"
};

const pdfCache  = {};
const CACHE_TTL = 60 * 60 * 1000;

// ── Polyfills for pdf-parse on Render (no native canvas) ──
function applyPolyfills() {
  if (typeof globalThis.DOMMatrix === "undefined") {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor() { this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0; }
      multiply() { return this; }
      translate() { return this; }
      scale() { return this; }
      rotate() { return this; }
      inverse() { return this; }
      transformPoint(p) { return p || {x:0,y:0}; }
    };
  }
  if (typeof globalThis.ImageData === "undefined") {
    globalThis.ImageData = class ImageData {
      constructor(w,h) { this.width=w; this.height=h; this.data=new Uint8ClampedArray(w*h*4); }
    };
  }
  if (typeof globalThis.Path2D === "undefined") {
    globalThis.Path2D = class Path2D { addPath(){} };
  }
}

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

    applyPolyfills();
    const pdfParseModule = require("pdf-parse");
const pdfParse = pdfParseModule.default || pdfParseModule;
const data     = await pdfParse(Buffer.from(res.data), { max: 0 });
    const text     = data.text || "";
    const crores   = extractCroresFromText(text);

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

  const t = rawText
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[',`\u2018\u2019](\d)/g, " $1")
    .replace(/\bt(\d)/g, " $1");

  // 1. Symbol + crore: "Rs.62.36 Crores" "₹22.50 crore"
  const sym = t.match(/(?:rs\.?|₹|inr)\s*([\d,]+(?:\.\d+)?)\s*(?:crores?|cr)\b/gi);
  if (sym) {
    const vals = sym.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g,"")) : 0;
    }).filter(v => v > 0 && v < 100000);
    if (vals.length) return Math.max(...vals);
  }

  // 2. Crore only: "22.50 crores"
  const cr = t.match(/([\d,]+(?:\.\d+)?)\s*(?:crores?)\b/gi);
  if (cr) {
    const vals = cr.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g,"")) : 0;
    }).filter(v => v > 0 && v < 100000);
    if (vals.length) return Math.max(...vals);
  }

  // 3. OCR artifact: "worth ,5.50 crores" or "worth t5.50"
  const ocr = t.match(/(?:worth|value|amount|order of)\s*[,.'`~t₹]\s*([\d.]+)\s*(?:crores?|cr)\b/gi);
  if (ocr) {
    const vals = ocr.map(m => {
      const n = m.match(/([\d.]+)\s*(?:crores?|cr)/i);
      return n ? parseFloat(n[1]) : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  // 4. Raw Indian rupee number: Rs.7,51,10,062
  const raw = t.match(/(?:rs\.?|₹)\s*([\d,]+(?:\.\d+)?)\b/gi);
  if (raw) {
    let max = null;
    for (const m of raw) {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      if (!n) continue;
      const v = parseFloat(n[1].replace(/,/g,""));
      if (v >= 100000) {
        const c = parseFloat((v/10000000).toFixed(2));
        if (!max || c > max) max = c;
      }
    }
    if (max) return max;
  }

  // 5. Word amounts: "Seven Crore Fifty One Lakh"
  const wm = t.match(/(?:total\s+)?(?:order|contract|project|work)?\s*(?:value|amount|worth)[^.]{0,80}((?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|crore)\s*)+)/i);
  if (wm) { const c = wordsToNumber(wm[1]); if (c) return c; }

  // 6. Million
  const mil = t.match(/(?:rs\.?|₹|inr|usd|\$)?\s*([\d,]+(?:\.\d+)?)\s*million/gi);
  if (mil) {
    const vals = mil.map(m => {
      const n = m.match(/([\d,]+(?:\.\d+)?)/);
      return n ? parseFloat(n[1].replace(/,/g,"")) * 0.1 : 0;
    }).filter(v => v > 0);
    if (vals.length) return Math.max(...vals);
  }

  return null;
}

function wordsToNumber(text) {
  const t = text.toLowerCase().trim();
  const ones = ["zero","one","two","three","four","five","six","seven","eight","nine","ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
  let total = 0, current = 0;
  for (const w of t.split(/\s+/)) {
    const oi=ones.indexOf(w), ti=tens.indexOf(w);
    if      (oi!==-1)                       current+=oi;
    else if (ti!==-1)                       current+=ti*10;
    else if (w==="hundred")                 current*=100;
    else if (w==="thousand")                current*=1000;
    else if (w==="lakh"||w==="lakhs")     { total+=current*100000; current=0; }
    else if (w==="crore"||w==="crores")   { total+=current*10000000; current=0; }
  }
  total+=current;
  if (total===0) return null;
  return parseFloat((total/10000000).toFixed(2));
}

module.exports = { extractOrderValueFromPDF };