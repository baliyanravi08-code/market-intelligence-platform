/**
 * parseUpstoxBSE.js
 * 
 * Parses the Upstox BSE instrument file → marketCapDB.json
 * 
 * How to get the latest file (free, no token needed):
 *   Download: https://assets.upstox.com/market-quote/instruments/exchange/BSE.csv.gz
 *   Place at: server/data/BSE_csv.gz
 * 
 * Run: node server/scripts/parseUpstoxBSE.js
 * 
 * To refresh weekly (the file updates daily):
 *   node server/scripts/parseUpstoxBSE.js --download
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const axios = require("axios");

const GZ_FILE   = path.join(__dirname, "../data/BSE_csv.gz");
const MCAP_FILE = path.join(__dirname, "../data/marketCapDB.json");
const DATA_DIR  = path.join(__dirname, "../data");

function loadExistingDB() {
  try {
    if (fs.existsSync(MCAP_FILE)) {
      const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
      if (raw) return JSON.parse(raw);
    }
  } catch { /* ok */ }
  return {};
}

function saveDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MCAP_FILE, JSON.stringify(db, null, 2), "utf8");
}

// ── Download latest BSE.csv.gz from Upstox ────────────────────────────────────
async function downloadLatest() {
  console.log("📥 Downloading latest BSE.csv.gz from Upstox...");
  const url = "https://assets.upstox.com/market-quote/instruments/exchange/BSE.csv.gz";
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":     "*/*",
      },
    });
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GZ_FILE, Buffer.from(res.data));
    console.log(`✅ Downloaded: ${Math.round(res.data.byteLength / 1024)}KB`);
    return true;
  } catch (e) {
    console.log(`❌ Download failed: ${e.message}`);
    return false;
  }
}

// ── Parse BSE.csv.gz → DB entries ────────────────────────────────────────────
function parseGZ(gzPath) {
  console.log("🔍 Parsing BSE.csv.gz...");

  const compressed = fs.readFileSync(gzPath);
  const raw        = zlib.gunzipSync(compressed).toString("utf8");
  const lines      = raw.split("\n");

  const db      = {};
  let   skipped = 0;

  for (let i = 1; i < lines.length; i++) {  // skip header
    const line = lines[i].trim();
    if (!line) continue;

    // Parse CSV fields — handle quoted fields
    const fields = [];
    let inQuote = false, cur = "";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === "," && !inQuote) { fields.push(cur); cur = ""; continue; }
      cur += ch;
    }
    fields.push(cur);

    if (fields.length < 12) continue;

    const instrumentKey  = fields[0];  // BSE_EQ|INE...
    const exchangeToken  = fields[1];  // BSE scrip code
    const tradingSymbol  = fields[2];  // symbol
    const name           = fields[3];  // company name
    const lastPrice      = fields[4];  // last price
    const instrumentType = fields[9];  // EQUITY / INDEX / etc
    const exchange       = fields[11]; // BSE_EQ / BSE_FO etc

    // ── Filters ──────────────────────────────────────────────────────────────
    // Only equity, only BSE_EQ, only 6-digit codes
    if (instrumentType !== "EQUITY")      { skipped++; continue; }
    if (exchange       !== "BSE_EQ")      { skipped++; continue; }
    if (!/^\d{6}$/.test(exchangeToken))   { skipped++; continue; }

    const price = parseFloat(lastPrice) || 0;
    if (price <= 0) { skipped++; continue; }

    // Skip bonds, debentures, NCDs — they have % in name or bond-like symbols
    if (/%/.test(name))                   { skipped++; continue; }
    if (/\bNCD\b|\bBOND\b/i.test(name))   { skipped++; continue; }
    if (/-CP$/.test(tradingSymbol))        { skipped++; continue; }
    if (/\d{2,3}[A-Z]{2,}/.test(tradingSymbol) && /-/.test(name)) { skipped++; continue; }

    // Extract ISIN from instrument_key: "BSE_EQ|INE376L01013"
    const isin = instrumentKey.includes("|")
      ? instrumentKey.split("|")[1]
      : "";

    // Title-case the name cleanly
    const cleanName = name
      .trim()
      .replace(/\bLTD\b\.?/gi,     "Ltd")
      .replace(/\bLIMITED\b/gi,    "Limited")
      .replace(/\bPVT\b\.?/gi,     "Pvt")
      .replace(/\bINDIA\b/gi,      "India")
      .replace(/\bINDUSTRIES\b/gi, "Industries")
      .replace(/\bENTERPRISES\b/gi,"Enterprises")
      .replace(/\bINFRASTRUCTURE\b/gi, "Infrastructure")
      .replace(/\bTECHNOLOGIES\b/gi,   "Technologies")
      .replace(/\bSERVICES\b/gi,        "Services")
      .replace(/\bFINANCE\b/gi,         "Finance")
      .replace(/\bCAPITAL\b/gi,         "Capital")
      .replace(/\b([A-Z])/g, (_, c) => c.toUpperCase());

    db[exchangeToken] = {
      name:       cleanName,
      isin,
      symbol:     tradingSymbol,
      lastPrice:  price,
      updatedAt:  Date.now(),
    };
  }

  console.log(`✅ Parsed: ${Object.keys(db).length} equity stocks (skipped ${skipped})`);
  return db;
}

// ── Merge — preserve existing mcap + orderbook data ──────────────────────────
function mergeWithExisting(newData, existingDB) {
  let added = 0, updated = 0;

  for (const [code, entry] of Object.entries(newData)) {
    if (!existingDB[code]) {
      // New company — add it
      existingDB[code] = entry;
      added++;
    } else {
      // Existing — update name/isin/symbol/price but KEEP mcap + orderbook data
      existingDB[code] = {
        ...existingDB[code],           // keep existing mcap, confirmedOrderBook, etc
        name:      entry.name      || existingDB[code].name,
        isin:      entry.isin      || existingDB[code].isin,
        symbol:    entry.symbol    || existingDB[code].symbol,
        lastPrice: entry.lastPrice || existingDB[code].lastPrice,
        updatedAt: Date.now(),
      };
      updated++;
    }
  }

  console.log(`💾 Merge: added=${added} updated=${updated} total=${Object.keys(existingDB).length}`);
  return existingDB;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const args     = process.argv.slice(2);
  const download = args.includes("--download");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Upstox BSE Parser → marketCapDB.json                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Download fresh file if requested or if not present
  if (download || !fs.existsSync(GZ_FILE)) {
    const ok = await downloadLatest();
    if (!ok && !fs.existsSync(GZ_FILE)) {
      console.error("❌ No BSE.csv.gz file found. Download manually:");
      console.error("   https://assets.upstox.com/market-quote/instruments/exchange/BSE.csv.gz");
      console.error("   Place at: server/data/BSE_csv.gz");
      process.exit(1);
    }
  }

  // Parse the gz file
  const newData    = parseGZ(GZ_FILE);
  const existingDB = loadExistingDB();
  const finalDB    = mergeWithExisting(newData, existingDB);

  saveDB(finalDB);

  // Summary
  const withMcap   = Object.values(finalDB).filter(d => d.mcap > 0).length;
  const withISIN   = Object.values(finalDB).filter(d => d.isin).length;
  const withPrice  = Object.values(finalDB).filter(d => d.lastPrice > 0).length;

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Total companies : ${Object.keys(finalDB).length}`);
  console.log(`  With last price : ${withPrice}`);
  console.log(`  With ISIN       : ${withISIN}`);
  console.log(`  With mcap       : ${withMcap}`);
  console.log(`\n✅ marketCapDB.json ready at server/data/marketCapDB.json`);
  console.log(`\nNext steps:`);
  console.log(`  node server/scripts/backfillResults_v3.js   ← fill order books`);
  console.log(`  git add server/data/marketCapDB.json`);
  console.log(`  git commit -m "seed marketcap data"`);
  console.log(`  git push\n`);
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});