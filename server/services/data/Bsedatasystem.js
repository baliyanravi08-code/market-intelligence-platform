/**
 * bseDataSystem.js
 * 
 * Self-reliant BSE data pipeline — no API token needed.
 * 
 * What it does:
 *   1. Downloads BSE listed companies CSV daily (free, official)
 *   2. Parses CSV → updates marketCapDB.json with name + code + ISIN + sector
 *   3. Fetches live mcap from BSE quote API (no token) for all companies
 *   4. Syncs everything to MongoDB
 *   5. Runs on node-cron schedule
 * 
 * Place at: server/services/data/bseDataSystem.js
 * Call init() from your main server.js
 * 
 * Run standalone: node server/services/data/bseDataSystem.js
 */

"use strict";

const axios   = require("axios");
const cron    = require("node-cron");
const fs      = require("fs");
const path    = require("path");
const csv     = require("csv-parse/sync");   // npm i csv-parse
const mongoose = require("mongoose");

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, "../../data");
const MCAP_FILE   = path.join(DATA_DIR, "marketCapDB.json");
const CSV_CACHE   = path.join(DATA_DIR, "bse_listed_cache.csv");

// ─── MongoDB Schema ───────────────────────────────────────────────────────────
const CompanySchema = new mongoose.Schema({
  code:       { type: String, unique: true, index: true },
  name:       { type: String, index: true },
  isin:       { type: String, index: true },
  sector:     String,
  industry:   String,
  status:     String,   // "Active" | "Suspended" etc
  mcap:       Number,   // Cr
  lastMcapAt: Number,   // timestamp
  updatedAt:  { type: Number, default: Date.now },
}, { strict: false });

let Company = null;

function initMongo() {
  try {
    Company = mongoose.model("Company");
  } catch {
    Company = mongoose.model("Company", CompanySchema);
    console.log("✅ Company model registered");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadMcapDB() {
  try {
    if (fs.existsSync(MCAP_FILE)) return JSON.parse(fs.readFileSync(MCAP_FILE, "utf8"));
  } catch { /* ok */ }
  return {};
}

function saveMcapDB(db) {
  ensureDataDir();
  fs.writeFileSync(MCAP_FILE, JSON.stringify(db, null, 2), "utf8");
}

// ─── BSE Headers (no token needed for public endpoints) ──────────────────────
const BSE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Referer":         "https://www.bseindia.com",
  "Connection":      "keep-alive",
};

const BSE_API_HEADERS = {
  ...BSE_HEADERS,
  "Accept":           "application/json, text/plain, */*",
  "Referer":          "https://www.bseindia.com",
  "Origin":           "https://www.bseindia.com",
  "X-Requested-With": "XMLHttpRequest",
};

// ─── STEP 1: Download BSE listed companies CSV ────────────────────────────────
// BSE provides this file publicly — no login, no token
// URL pattern: https://www.bseindia.com/corporates/List_Scrips.aspx (HTML form)
// But the actual downloadable data comes from their download endpoint

const BSE_CSV_URLS = [
  // Primary: equity scrips master
  "https://www.bseindia.com/download/BhavCopy/Equity/EQ_ISINCODE_{DATE}.CSV",
  // Fallback: listed securities
  "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active",
];

async function downloadBSECompanyList() {
  console.log("📥 Downloading BSE company list...");

  // Method 1: Try the BSE scrips API (returns JSON, most reliable)
  try {
    const url = "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active";
    const res = await axios.get(url, {
      headers: { ...BSE_API_HEADERS },
      timeout: 30000,
    });

    const data = res.data;
    // BSE returns array or { Table: [...] }
    const rows = Array.isArray(data) ? data
               : data?.Table || data?.Table1 || data?.data || [];

    if (rows.length > 100) {
      console.log(`✅ BSE API: ${rows.length} companies`);
      return { source: "api", rows };
    }
  } catch (e) {
    console.log(`   BSE scrips API failed: ${e.message}`);
  }

  // Method 2: BhavCopy CSV (today and yesterday)
  for (let daysAgo = 0; daysAgo <= 5; daysAgo++) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const dateStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    const url = `https://www.bseindia.com/download/BhavCopy/Equity/EQ_ISINCODE_${dateStr}.CSV`;

    try {
      const res = await axios.get(url, {
        headers: BSE_HEADERS,
        responseType: "text",
        timeout: 30000,
      });
      if (res.data && res.data.length > 1000) {
        console.log(`✅ BhavCopy CSV: ${dateStr} (${Math.round(res.data.length/1024)}KB)`);
        fs.writeFileSync(CSV_CACHE, res.data, "utf8");
        return { source: "bhav_csv", raw: res.data, date: dateStr };
      }
    } catch (e) {
      console.log(`   BhavCopy ${dateStr}: ${e.message}`);
    }
    await sleep(1000);
  }

  // Method 3: Use cached CSV if download fails
  if (fs.existsSync(CSV_CACHE)) {
    console.log("⚠️  Using cached CSV from previous run");
    return { source: "cache", raw: fs.readFileSync(CSV_CACHE, "utf8") };
  }

  throw new Error("All BSE company list sources failed");
}

// ─── STEP 2: Parse company list into standard format ─────────────────────────
function parseCompanyList(result) {
  const companies = []; // [{ code, name, isin, sector, industry, status }]

  if (result.source === "api" && result.rows) {
    for (const row of result.rows) {
      // BSE API field names vary — handle all known variants
      const code = String(
        row.SCRIP_CD || row.scripCode || row.Scrip_Code || row.scrip_cd || ""
      ).trim();
      const name = (
        row.SCRIP_NAME || row.scripName || row.Scrip_Name || row.LONG_NAME || ""
      ).trim();
      const isin = (row.ISIN_NUMBER || row.isin || row.ISIN || "").trim();
      const sector = (row.SECTOR_NAME || row.sector || row.Sector || "").trim();
      const industry = (row.INDUSTRY || row.industry || "").trim();
      const status = (row.STATUS || row.status || "Active").trim();

      if (!code || !name) continue;
      companies.push({ code, name, isin, sector, industry, status });
    }
  } else if (result.raw) {
    // Parse CSV — handle BhavCopy format
    // BhavCopy columns: CODE,NAME,ISIN,PREVCLOSE,OPEN,HIGH,LOW,CLOSE,TOTTRDQTY,TOTTRDVAL,...
    try {
      const records = csv.parse(result.raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      });

      for (const row of records) {
        const code = String(
          row.CODE || row.SC_CODE || row.Scrip_Code || row["SCRIP CODE"] || ""
        ).trim();
        const name = (
          row.NAME || row.SC_NAME || row.Scrip_Name || row["SCRIP NAME"] || ""
        ).trim();
        const isin = (row.ISIN || row.ISIN_CODE || row["ISIN CODE"] || "").trim();

        if (!code || !name || !/^\d{6}$/.test(code)) continue;
        companies.push({
          code,
          name,
          isin,
          sector:   row.SECTOR   || row.Sector   || "",
          industry: row.INDUSTRY || row.Industry || "",
          status:   row.STATUS   || "Active",
        });
      }
    } catch (e) {
      console.log(`   CSV parse error: ${e.message}`);
    }
  }

  console.log(`📋 Parsed ${companies.length} companies from BSE`);
  return companies;
}

// ─── STEP 3: Fetch live mcap from BSE quote API (no token) ───────────────────
// BSE provides market cap in their quote endpoint — completely free
async function fetchLiveMcap(code) {
  // BSE quote API — no auth needed
  const url = `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Scrip_Cd=${code}`;
  try {
    const res = await axios.get(url, {
      headers: BSE_API_HEADERS,
      timeout: 8000,
    });
    const d = res.data;

    // Try all known field names BSE uses for market cap
    const mcapRaw =
      d?.MktCapFull   ||   // Full market cap in lakhs usually
      d?.Mktcap       ||
      d?.MKTCAP       ||
      d?.MarketCap    ||
      d?.mktcap       ||
      null;

    if (!mcapRaw) return null;

    // BSE sometimes returns in lakhs, sometimes crores — detect by magnitude
    const val = parseFloat(String(mcapRaw).replace(/,/g, ""));
    if (!val || val <= 0) return null;

    // If value > 50,000 it's likely in lakhs → convert to crores
    const crores = val > 50000 ? parseFloat((val / 100).toFixed(2)) : val;
    return crores;

  } catch {
    return null;
  }
}

// Batch mcap fetch with rate limiting
async function fetchMcapBatch(codes, onProgress) {
  const results = {}; // code → crores
  const BATCH   = 10;  // parallel requests
  const DELAY   = 300; // ms between batches

  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async code => {
        const mcap = await fetchLiveMcap(code);
        return { code, mcap };
      })
    );

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value.mcap) {
        results[s.value.code] = s.value.mcap;
      }
    }

    if (onProgress) onProgress(Math.min(i + BATCH, codes.length), codes.length);
    await sleep(DELAY);
  }

  return results;
}

// ─── STEP 4: Merge into marketCapDB.json ─────────────────────────────────────
function mergeIntoMcapDB(companies, mcapMap) {
  const db = loadMcapDB();
  let added = 0, updated = 0;

  for (const co of companies) {
    const existing = db[co.code];
    const mcap     = mcapMap[co.code] || existing?.mcap || null;

    if (!existing) {
      db[co.code] = {
        name:     co.name,
        isin:     co.isin,
        sector:   co.sector,
        industry: co.industry,
        status:   co.status,
        mcap,
        updatedAt: Date.now(),
      };
      added++;
    } else {
      // Never overwrite name with a blank
      db[co.code] = {
        ...existing,
        name:     co.name || existing.name,
        isin:     co.isin || existing.isin,
        sector:   co.sector || existing.sector,
        industry: co.industry || existing.industry,
        status:   co.status || existing.status,
        ...(mcap ? { mcap, lastMcapAt: Date.now() } : {}),
        updatedAt: Date.now(),
      };
      updated++;
    }
  }

  saveMcapDB(db);
  console.log(`💾 marketCapDB.json — added: ${added}, updated: ${updated}, total: ${Object.keys(db).length}`);
  return db;
}

// ─── STEP 5: Sync to MongoDB ──────────────────────────────────────────────────
async function syncToMongo(db) {
  if (!Company) { console.log("⚠️  MongoDB not ready — skipping sync"); return; }

  console.log(`🍃 Syncing ${Object.keys(db).length} companies to MongoDB...`);
  let synced = 0, errors = 0;
  const entries = Object.entries(db);

  // Bulk upsert in batches of 100
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100);
    const ops   = batch.map(([code, data]) => ({
      updateOne: {
        filter: { code },
        update: { $set: { code, ...data, updatedAt: Date.now() } },
        upsert: true,
      },
    }));

    try {
      await Company.bulkWrite(ops, { ordered: false });
      synced += batch.length;
    } catch (e) {
      errors++;
      console.log(`   Batch ${i}-${i+100} error: ${e.message}`);
    }

    if (i % 1000 === 0 && i > 0) {
      process.stdout.write(`   ${i}/${entries.length} synced...\r`);
    }
  }

  console.log(`✅ MongoDB sync complete — ${synced} upserted, ${errors} batch errors`);
}

// ─── Full pipeline ────────────────────────────────────────────────────────────
async function runPipeline(opts = {}) {
  const { skipMcap = false } = opts;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  BSE Data Pipeline — ${new Date().toLocaleString("en-IN")}`);
  console.log(`${"═".repeat(60)}\n`);

  try {
    // 1. Download
    const raw        = await downloadBSECompanyList();
    const companies  = parseCompanyList(raw);

    if (companies.length === 0) {
      console.log("❌ No companies parsed — aborting pipeline");
      return;
    }

    // 2. Live mcap (optional — skip on first run or if BSE is slow)
    let mcapMap = {};
    if (!skipMcap) {
      console.log(`\n📈 Fetching live mcap for ${companies.length} companies...`);
      console.log("   (This takes ~5-10 min for 2000+ companies)\n");

      const codes = companies.map(c => c.code);
      let lastPct = 0;
      mcapMap = await fetchMcapBatch(codes, (done, total) => {
        const pct = Math.floor(done / total * 100);
        if (pct >= lastPct + 10) {
          console.log(`   mcap fetch: ${pct}% (${done}/${total})`);
          lastPct = pct;
        }
      });

      const fetched = Object.keys(mcapMap).length;
      console.log(`   ✅ mcap fetched for ${fetched}/${companies.length} companies`);
    }

    // 3. Merge into JSON
    const db = mergeIntoMcapDB(companies, mcapMap);

    // 4. Sync to MongoDB
    await syncToMongo(db);

    console.log(`\n✅ Pipeline complete — ${companies.length} companies processed\n`);
    return db;

  } catch (e) {
    console.error(`❌ Pipeline failed: ${e.message}`);
  }
}

// ─── node-cron schedule ───────────────────────────────────────────────────────
function startScheduler() {
  console.log("⏰ BSE Data System scheduler started");

  // Daily at 8:00 AM IST — full pipeline with mcap
  // BSE opens at 9:15 AM so 8 AM gives fresh pre-market data
  cron.schedule("0 8 * * 1-5", async () => {
    console.log("⏰ [CRON] Daily BSE update starting...");
    await runPipeline({ skipMcap: false });
  }, { timezone: "Asia/Kolkata" });

  // Every 4 hours on trading days — mcap refresh only (faster, no CSV download)
  cron.schedule("0 10,13,16 * * 1-5", async () => {
    console.log("⏰ [CRON] mcap refresh...");
    const db = loadMcapDB();
    const codes = Object.keys(db);
    console.log(`📈 Refreshing mcap for ${codes.length} companies...`);

    let updated = 0;
    const mcapMap = await fetchMcapBatch(codes, null);
    for (const [code, mcap] of Object.entries(mcapMap)) {
      if (db[code]) { db[code].mcap = mcap; db[code].lastMcapAt = Date.now(); updated++; }
    }
    saveMcapDB(db);

    // Sync updated mcaps to MongoDB
    if (Company) {
      const ops = Object.entries(mcapMap).map(([code, mcap]) => ({
        updateOne: {
          filter: { code },
          update: { $set: { mcap, lastMcapAt: Date.now() } },
          upsert: false,
        },
      }));
      try { await Company.bulkWrite(ops, { ordered: false }); } catch { /* ok */ }
    }
    console.log(`✅ mcap refreshed for ${updated} companies`);
  }, { timezone: "Asia/Kolkata" });

  console.log("   Daily full sync:  Mon–Fri 8:00 AM IST");
  console.log("   mcap refresh:     Mon–Fri 10 AM, 1 PM, 4 PM IST\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────
async function init(opts = {}) {
  ensureDataDir();
  initMongo();

  const db = loadMcapDB();
  const count = Object.keys(db).length;

  if (count === 0) {
    // First run — download everything now, skip slow mcap fetch initially
    console.log("🚀 First run — downloading BSE company list now...");
    await runPipeline({ skipMcap: true });
    // Then fetch mcap in background
    setTimeout(() => runPipeline({ skipMcap: false }), 5000);
  } else {
    console.log(`📊 marketCapDB.json: ${count} companies already loaded`);
  }

  startScheduler();
}

// ─── Standalone run ───────────────────────────────────────────────────────────
if (require.main === module) {
  const args       = process.argv.slice(2);
  const skipMcap   = args.includes("--skip-mcap");
  const mcapOnly   = args.includes("--mcap-only");

  (async () => {
    ensureDataDir();

    if (mcapOnly) {
      // Just refresh mcap for existing companies
      const db    = loadMcapDB();
      const codes = Object.keys(db);
      console.log(`📈 mcap-only refresh for ${codes.length} companies...`);
      const mcapMap = await fetchMcapBatch(codes, (done, total) => {
        if (done % 200 === 0) console.log(`   ${done}/${total}`);
      });
      for (const [code, mcap] of Object.entries(mcapMap)) {
        if (db[code]) { db[code].mcap = mcap; db[code].lastMcapAt = Date.now(); }
      }
      saveMcapDB(db);
      console.log(`✅ Done — updated ${Object.keys(mcapMap).length} mcaps`);
    } else {
      await runPipeline({ skipMcap });
    }
  })();
}

module.exports = { init, runPipeline, fetchLiveMcap, loadMcapDB, syncToMongo };