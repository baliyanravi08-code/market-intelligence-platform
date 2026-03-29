/**
 * fetchLiveMcap.js
 * 
 * Fetches live mcap for ALL companies in marketCapDB.json
 * using BSE getScripHeaderData API (no token needed).
 * Saves to both marketCapDB.json + MongoDB.
 * 
 * Place at : server/scripts/fetchLiveMcap.js
 * Run      : node server/scripts/fetchLiveMcap.js
 * Refresh  : node server/scripts/fetchLiveMcap.js --from=500000  (resume from code)
 */

"use strict";

const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");

const MCAP_FILE = path.join(__dirname, "../data/marketCapDB.json");
const DATA_DIR  = path.join(__dirname, "../data");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── MongoDB Company Schema (minimal — only what we need) ──────────────────────
const CompanySchema = new mongoose.Schema({
  code:       { type: String, unique: true, index: true },
  name:       String,
  isin:       String,
  symbol:     String,
  mcap:       Number,
  lastPrice:  Number,
  lastMcapAt: Number,
  updatedAt:  Number,
}, { strict: false });

let Company = null;

async function connectMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.log("⚠️  No MONGODB_URI — will save to JSON only");
    return false;
  }
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
    try { Company = mongoose.model("Company"); }
    catch { Company = mongoose.model("Company", CompanySchema); }
    console.log("✅ MongoDB connected");
    return true;
  } catch (e) {
    console.log(`⚠️  MongoDB failed: ${e.message} — JSON only`);
    return false;
  }
}

// ── Load / save JSON ──────────────────────────────────────────────────────────
function loadDB() {
  try {
    const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MCAP_FILE, JSON.stringify(db, null, 2), "utf8");
}

// ── BSE headers ───────────────────────────────────────────────────────────────
const BSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Referer":         "https://www.bseindia.com",
  "Accept":          "application/json, text/plain, */*",
  "Origin":          "https://www.bseindia.com",
  "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
};

// ── Fetch mcap for one code ───────────────────────────────────────────────────
async function fetchOneMcap(code) {
  try {
    const res = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Scrip_Cd=${code}`,
      { headers: BSE_HEADERS, timeout: 7000 }
    );
    const d = res.data;
    if (!d || typeof d !== "object") return null;

    // MCap field — BSE returns different field names across versions
    const mcapRaw = d.MarketCapCr ?? d.Mktcap ?? d.mktcap ?? d.MktCap
                 ?? d.MKTCAP ?? d.mktCapCr ?? null;
    // Price field
    const priceRaw = d.CurrRate ?? d.Ltrade ?? d.LastRate ?? d.currentPrice ?? null;

    let mcap  = mcapRaw  ? parseFloat(String(mcapRaw).replace(/,/g, ""))  : null;
    let price = priceRaw ? parseFloat(String(priceRaw).replace(/,/g, "")) : null;

    // BSE sometimes returns mcap in lakhs — if value > 50000 it's lakhs
    if (mcap && mcap > 50000) mcap = parseFloat((mcap / 100).toFixed(2));

    if (mcap  <= 0) mcap  = null;
    if (price <= 0) price = null;

    return { mcap, price };
  } catch {
    return null;
  }
}

// ── Batch fetch with parallelism + rate limiting ──────────────────────────────
async function fetchMcapBatch(codes, db, mongoReady) {
  const PARALLEL   = 6;   // concurrent requests
  const DELAY_MS   = 350; // between batches — stay under BSE rate limit
  const SAVE_EVERY = 100; // save to disk every N companies

  let fetched = 0, failed = 0, mongoOps = [];

  console.log(`\n📈 Fetching mcap for ${codes.length} companies...\n`);

  for (let i = 0; i < codes.length; i += PARALLEL) {
    const batch = codes.slice(i, i + PARALLEL);

    const results = await Promise.allSettled(
      batch.map(async code => {
        const data = await fetchOneMcap(code);
        return { code, ...data };
      })
    );

    for (const r of results) {
      if (r.status !== "fulfilled") { failed++; continue; }
      const { code, mcap, price } = r.value;

      if (mcap) {
        fetched++;
        db[code] = {
          ...db[code],
          mcap,
          ...(price ? { lastPrice: price } : {}),
          lastMcapAt: Date.now(),
          updatedAt:  Date.now(),
        };

        // Queue MongoDB op
        if (mongoReady) {
          mongoOps.push({
            updateOne: {
              filter: { code },
              update: { $set: {
                code,
                name:       db[code].name,
                isin:       db[code].isin,
                symbol:     db[code].symbol,
                mcap,
                ...(price ? { lastPrice: price } : {}),
                lastMcapAt: Date.now(),
                updatedAt:  Date.now(),
              }},
              upsert: true,
            }
          });
        }
      } else {
        failed++;
      }
    }

    // Save JSON periodically
    if ((i + PARALLEL) % SAVE_EVERY === 0 || i + PARALLEL >= codes.length) {
      saveDB(db);

      // Flush MongoDB ops
      if (mongoReady && mongoOps.length > 0 && Company) {
        try {
          await Company.bulkWrite(mongoOps, { ordered: false });
        } catch (e) {
          console.log(`   Mongo batch error: ${e.message}`);
        }
        mongoOps = [];
      }

      const pct  = Math.round((i + PARALLEL) / codes.length * 100);
      const done = Math.min(i + PARALLEL, codes.length);
      process.stdout.write(
        `   ${pct}% (${done}/${codes.length}) — fetched: ${fetched} failed: ${failed}\r`
      );
    }

    await sleep(DELAY_MS);
  }

  // Final flush
  if (mongoReady && mongoOps.length > 0 && Company) {
    try { await Company.bulkWrite(mongoOps, { ordered: false }); } catch { /* ok */ }
  }

  return { fetched, failed };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const fromCode = args.find(a => a.startsWith("--from="))?.split("=")[1] || null;

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Live MCap Fetcher — BSE API → JSON + MongoDB          ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // Load env for MongoDB
  try { require("dotenv").config({ path: path.join(__dirname, "../../.env") }); } catch { /* ok */ }

  const mongoReady = await connectMongo();
  const db = loadDB();
  let codes = Object.keys(db);

  if (codes.length === 0) {
    console.error("❌ marketCapDB.json is empty. Run parseUpstoxBSE.js first.");
    process.exit(1);
  }

  // Resume from a specific code if provided
  if (fromCode) {
    const idx = codes.indexOf(fromCode);
    if (idx > 0) {
      console.log(`⏩ Resuming from code ${fromCode} (skipping ${idx} already done)`);
      codes = codes.slice(idx);
    }
  }

  // Sort codes numerically for predictable order
  codes.sort((a, b) => Number(a) - Number(b));

  console.log(`📊 Companies to process: ${codes.length}`);
  console.log(`💾 Save targets: JSON ${mongoReady ? "+ MongoDB" : "only"}`);
  console.log(`⏱️  Estimated time: ~${Math.round(codes.length * 350 / 6 / 60000)} min\n`);

  const start = Date.now();
  const { fetched, failed } = await fetchMcapBatch(codes, db, mongoReady);
  const elapsed = Math.round((Date.now() - start) / 1000);

  // Final save
  saveDB(db);

  // Summary
  const withMcap = Object.values(db).filter(d => d.mcap > 0).length;
  console.log(`\n\n${"═".repeat(55)}`);
  console.log(`  Completed in    : ${elapsed}s`);
  console.log(`  MCap fetched    : ${fetched}`);
  console.log(`  Failed/no data  : ${failed}`);
  console.log(`  Total with mcap : ${withMcap} / ${Object.keys(db).length}`);
  console.log(`\n✅ marketCapDB.json updated`);
  if (mongoReady) console.log(`✅ MongoDB synced`);
  console.log(`\nNext: node server/scripts/backfillResults_v3.js\n`);

  if (mongoReady) await mongoose.disconnect();
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});