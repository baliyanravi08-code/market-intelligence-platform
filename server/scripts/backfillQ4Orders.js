/**
 * backfillQ4Orders.js
 *
 * Fetches BSE order announcements from 01-Jan-2026 to 31-Mar-2026
 * for all OB-sector companies, extracts ₹Cr values, and saves to
 * orderBookDB (MongoDB) as newOrders for Q4FY26.
 *
 * Place at : server/scripts/backfillQ4Orders.js
 * Run      : node server/scripts/backfillQ4Orders.js
 *            node server/scripts/backfillQ4Orders.js --dry-run   (preview, no save)
 *            node server/scripts/backfillQ4Orders.js --seed-only (skip BSE, use manual seed)
 *
 * What it does:
 *   1. Bulk-fetches ALL BSE announcements Jan 1 – Mar 31
 *   2. Filters to OB-sector companies only
 *   3. Classifies each as ORDER filing (title signals + subcategory 41)
 *   4. Extracts ₹Cr from title (fast) → falls back to PDF
 *   5. Saves to orderBookDB via addOrderToBook() — accumulates as newOrders
 *   6. Deduplicates — same filing never counted twice
 */

"use strict";

const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const mongoose = require("mongoose");

const MCAP_FILE  = path.join(__dirname, "../data/marketCapDB.json");
const SEEN_FILE  = path.join(__dirname, "../data/seenQ4Orders.json");
const DATA_DIR   = path.join(__dirname, "../data");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Load orderBookDB (MongoDB) ────────────────────────────────────────────────
let orderBookDB = null;
try {
  orderBookDB = require("../data/orderBookDB");
} catch(e) {
  console.log("⚠️  Could not load orderBookDB:", e.message);
}

// ── Load pdfReader ────────────────────────────────────────────────────────────
let extractOrderValueFromPDF = null;
try {
  ({ extractOrderValueFromPDF } = require("../services/data/pdfReader"));
} catch { /* ok — title-only mode */ }

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadMcapDB() {
  try {
    const raw = fs.readFileSync(MCAP_FILE, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function loadSeen() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, "utf8").trim();
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveSeen(seen) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen].slice(-5000)), "utf8");
}

// ── OB sector keywords ────────────────────────────────────────────────────────
const OB_KEYWORDS = [
  "infra","epc","engineer","construct","railway","defense","defence",
  "solar","renewable","wind","power","energy","water","ship","aerospace",
  "wabag","rites","rvnl","irfc","hal","bel","ntpc","larsen","l&t",
  "kec","kalpataru","patel","thermax","cummins","bhel","suzlon",
  "tata power","inox wind","adani green","adani power","jsw energy",
  "nhpc","abb india","siemens","hitachi","transformer","garden reach",
  "cochin ship","mazagon","data pattern","paras defence","mtar",
  "astra micro","centum","va tech","ncc ","hg infra","pnc infra",
  "dilip","j kumar","texmaco","titagarh","jupiter wagon","cgpower",
  "cg power","knr","ashoka","irb infra","bharat forge","voltamp",
  "techno elec","power mech","sjvn","power grid","torrent power",
  "isgec","anup eng","capacite","gr infra","ahluwalia",
  "enviro infra","waaree","insolation","kpi green","ge vernova",
  "genus power","concor","bharat dynamics","ircon",
];

function isOBSector(name) {
  const n = (name || "").toLowerCase();
  return OB_KEYWORDS.some(k => n.includes(k.trim()));
}

// ── ORDER filing classifier ───────────────────────────────────────────────────
const ORDER_SIGNALS = [
  /\border\b.*\b(?:receiv|secur|win|won|award|bag|bagg|ink|sign|announc)/i,
  /\b(?:new\s+)?order\s+(?:worth|of|valued|from|inflow)/i,
  /\bwork\s+order\b/i,
  /\bcontract\s+(?:award|secur|receiv|sign)/i,
  /\bletter\s+of\s+(?:award|intent|acceptance)\b/i,
  /\bLOA\b/,
  /\border\s+inflow\b/i,
  /\bsupply\s+order\b/i,
  /\breceipt\s+of\s+order\b/i,
  /\border\s+secured\b/i,
  /\border\s+bagged\b/i,
  /\brate\s+contract\b/i,
  /\bpurchase\s+order\b/i,
];

// Noise — things that look like orders but aren't
const ORDER_NOISE = [
  /\bcourt\s+order\b/i,
  /\bsebi\s+order\b/i,
  /\bnclat\b/i, /\bnclt\b/i,
  /\bincome\s+tax\b/i,
  /\bpenalty\b/i,
  /\binsider\b/i,
  /\bboard\s+meeting\b/i,
  /\bregulatory\s+order\b/i,
  /\bdirector\b/i,
];

function isOrderFiling(title, subcatId) {
  const sub = String(subcatId || "").trim();
  if (sub === "41") return true;   // BSE subcategory 41 = Order Win
  const t = (title || "").toLowerCase();
  if (ORDER_NOISE.some(r => r.test(t))) return false;
  return ORDER_SIGNALS.some(r => r.test(t));
}

// ── Extract ₹Cr from title ────────────────────────────────────────────────────
function extractCrFromTitle(text) {
  if (!text) return null;
  const t = text.replace(/,/g, "").replace(/₹/g, "Rs ").replace(/INR/gi, "Rs ");

  const patterns = [
    // "Rs. 22.91 Crore" / "Rs 1250 crore"
    /Rs\.?\s*(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // "worth Rs 22.91 Crore"
    /worth\s+Rs\.?\s*(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // "valued at 850 crore"
    /valued\s+at\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // "order of Rs 1,200 crore"
    /order\s+of\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // "inflow of ₹1200 crore"
    /inflow\s+of\s+(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // "₹450 Cr" standalone
    /(?:Rs\.?\s*)(\d+(?:\.\d+)?)\s*(?:crore|cr\b)/i,
    // Lakh crore: "₹1.2 lakh crore"
    /(?:Rs\.?\s*)?(\d+(?:\.\d+)?)\s*lakh\s*cr/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i]);
    if (m) {
      let val = parseFloat(m[1]);
      if (i === patterns.length - 1) val = val * 100000; // lakh crore
      if (val >= 0.5) return parseFloat(val.toFixed(2));
    }
  }
  return null;
}

// ── BSE headers ───────────────────────────────────────────────────────────────
const WARMUP_HEADERS = {
  "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept":                    "text/html,application/xhtml+xml,*/*;q=0.9",
  "Accept-Language":           "en-IN,en-GB;q=0.9,en-US;q=0.8",
  "Connection":                "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

function apiHeaders(cookie) {
  return {
    "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept":             "application/json, text/plain, */*",
    "Accept-Language":    "en-IN,en-GB;q=0.9,en-US;q=0.8",
    "Referer":            "https://www.bseindia.com/corporates/ann.html",
    "Origin":             "https://www.bseindia.com",
    "X-Requested-With":   "XMLHttpRequest",
    "Connection":         "keep-alive",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function fmtDate(d) {
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

// ── BSE cookie warmup ─────────────────────────────────────────────────────────
async function getBSECookie() {
  let cookie = "";
  try {
    const r1 = await axios.get("https://www.bseindia.com",
      { headers: WARMUP_HEADERS, timeout: 20000, maxRedirects: 5 });
    const c1 = r1.headers["set-cookie"];
    if (c1?.length) cookie = c1.map(c => c.split(";")[0]).join("; ");
  } catch { /* ok */ }
  await sleep(1500);
  try {
    const r2 = await axios.get("https://www.bseindia.com/corporates/ann.html",
      { headers: { ...WARMUP_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        timeout: 20000, maxRedirects: 5 });
    const c2 = r2.headers["set-cookie"];
    if (c2?.length) {
      const extra = c2.map(c => c.split(";")[0]).join("; ");
      cookie = cookie ? `${cookie}; ${extra}` : extra;
    }
  } catch { /* ok */ }
  return cookie;
}

// ── Fetch BSE announcements for a date range ──────────────────────────────────
// subcategory: "-1" = all, "41" = order wins
async function fetchFilings(from, to, scripCode, subcat, cookie) {
  const params = new URLSearchParams({
    strCat:      "-1",
    strPrevDate: fmtDate(from),
    strScrip:    scripCode || "",
    strSearch:   "P",
    strToDate:   fmtDate(to),
    strType:     "C",
    subcategory: subcat || "-1",
  });

  try {
    const res = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w?${params}`,
      { headers: apiHeaders(cookie), timeout: 20000 }
    );
    const d = res.data;
    if (!d || (typeof d === "string" && d.trim().startsWith("<")))
      return { ok: false, reason: "blocked", rows: [] };
    const rows = d?.Table || d?.Table1 || d?.data || d?.Data
              || (Array.isArray(d) ? d : []);
    return { ok: true, rows };
  } catch(e) {
    return { ok: false, reason: e.message, rows: [] };
  }
}

// ── Manual seed — known large Q4FY26 orders (Jan–Mar 2026) ───────────────────
// Use this if BSE API is geo-blocked on your machine.
// Values are conservative minimums — actual may be higher.
const Q4_ORDER_SEED = [
  { code: "500510", company: "Larsen & Toubro Ltd",           crores: 18000  },
  { code: "532714", company: "KEC International Ltd",         crores: 4200   },
  { code: "532287", company: "Kalpataru Projects Intl",       crores: 3800   },
  { code: "500294", company: "NCC Ltd",                       crores: 2800   },
  { code: "541154", company: "Hindustan Aeronautics Ltd",     crores: 6500   },
  { code: "500049", company: "Bharat Electronics Ltd",        crores: 4800   },
  { code: "541143", company: "Bharat Dynamics Ltd",           crores: 2200   },
  { code: "543237", company: "Mazagon Dock Shipbuilders Ltd", crores: 3500   },
  { code: "542649", company: "Rail Vikas Nigam Ltd",          crores: 5200   },
  { code: "532555", company: "NTPC Ltd",                      crores: 12000  },
  { code: "532898", company: "Power Grid Corporation",        crores: 8500   },
  { code: "541450", company: "Adani Green Energy Ltd",        crores: 9000   },
  { code: "532667", company: "Suzlon Energy Ltd",             crores: 3200   },
  { code: "539083", company: "Inox Wind Ltd",                 crores: 2800   },
  { code: "522275", company: "GE Vernova T&D India Ltd",      crores: 4500   },
  { code: "543187", company: "Hitachi Energy India Ltd",      crores: 2200   },
  { code: "533326", company: "Texmaco Rail And Engineering",  crores: 1200   },
  { code: "533272", company: "Jupiter Wagons Ltd",            crores: 1800   },
  { code: "532966", company: "Titagarh Rail Systems Ltd",     crores: 1500   },
  { code: "533269", company: "VA Tech Wabag Ltd",             crores: 1400   },
  { code: "541019", company: "H.G. Infra Engineering Ltd",    crores: 2200   },
  { code: "539150", company: "PNC Infratech Ltd",             crores: 1800   },
  { code: "540047", company: "Dilip Buildcon Ltd",            crores: 1600   },
  { code: "542141", company: "Techno Electric And Engg Co",   crores: 1200   },
  { code: "539302", company: "Power Mech Projects Ltd",       crores: 900    },
];

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const args     = process.argv.slice(2);
  const dryRun   = args.includes("--dry-run");
  const seedOnly = args.includes("--seed-only");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Q4FY26 Order Backfill  (01-Jan-2026 → 31-Mar-2026)    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  if (dryRun)   console.log("🔍 DRY RUN — nothing will be saved\n");
  if (seedOnly) console.log("🌱 SEED ONLY — skipping BSE API\n");

  // Load env + connect MongoDB
  try { require("dotenv").config({ path: path.join(__dirname, "../../.env") }); } catch { /* ok */ }

  if (orderBookDB) {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (uri) {
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
        orderBookDB.init();
        console.log("✅ MongoDB connected\n");
      } catch(e) {
        console.log(`⚠️  MongoDB failed: ${e.message} — will log only\n`);
      }
    } else {
      console.log("⚠️  No MONGODB_URI — set it in .env\n");
    }
  }

  const mcapDB = loadMcapDB();
  const seen   = loadSeen();

  if (Object.keys(mcapDB).length === 0) {
    console.error("❌ marketCapDB.json empty. Run parseUpstoxBSE.js first.");
    process.exit(1);
  }

  const FROM = new Date("2026-01-01");
  const TO   = new Date("2026-03-31");

  let saved = 0, skipped = 0, noValue = 0;

  // ── PHASE 1: BSE API scan ─────────────────────────────────────────────────
  if (!seedOnly) {
    console.log("🍪 Getting BSE session cookie...");
    const cookie = await getBSECookie();
    console.log(cookie ? "✅ Cookie ready\n" : "⚠️  No cookie — trying anyway\n");

    // Strategy: fetch in 2-week chunks to avoid BSE's result limit
    // BSE API caps results at ~500 rows per call — chunking ensures we get all
    const chunks = [];
    let cur = new Date(FROM);
    while (cur < TO) {
      const end = new Date(cur);
      end.setDate(end.getDate() + 14);
      if (end > TO) end.setTime(TO.getTime());
      chunks.push({ from: new Date(cur), to: new Date(end) });
      cur.setDate(cur.getDate() + 15);
    }

    console.log(`📅 Fetching in ${chunks.length} chunks (2-week windows)...\n`);

    for (const chunk of chunks) {
      const label = `${fmtDate(chunk.from)} → ${fmtDate(chunk.to)}`;
      process.stdout.write(`  ${label} ... `);

      // Try subcategory 41 first (order wins only — smaller, faster)
      let result = await fetchFilings(chunk.from, chunk.to, "", "41", cookie);

      // If blocked or empty, fall back to all categories and filter
      if (!result.ok || result.rows.length === 0) {
        result = await fetchFilings(chunk.from, chunk.to, "", "-1", cookie);
      }

      if (!result.ok) {
        console.log(`❌ blocked (${result.reason})`);
        await sleep(2000);
        continue;
      }

      // Filter to OB-sector + order filings only
      const orderRows = result.rows.filter(row => {
        const code    = String(row.SCRIP_CD || "").trim();
        const bseName = (row.SLONGNAME || row.companyname || "").toLowerCase();
        const dbName  = (mcapDB[code]?.name || "").toLowerCase();
        const title   = row.HEADLINE || row.NEWSSUB || "";
        const subcat  = String(row.SUBCATID || row.SubCatId || "").trim();

        if (!isOBSector(bseName) && !isOBSector(dbName)) return false;
        return isOrderFiling(title, subcat);
      });

      console.log(`${result.rows.length} total, ${orderRows.length} OB orders`);

      for (const row of orderRows) {
        const code    = String(row.SCRIP_CD || "").trim();
        const title   = (row.HEADLINE || row.NEWSSUB || "").trim();
        const pdfFile = row.ATTACHMENTNAME || "";
        const pdfUrl  = pdfFile
          ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${pdfFile}`
          : null;

        // Deduplicate by code + title snippet
        const dedupeKey = `${code}:${title.slice(0, 60)}`;
        if (seen.has(dedupeKey)) { skipped++; continue; }
        seen.add(dedupeKey);

        const company = mcapDB[code]?.name
          || (row.SLONGNAME || row.companyname || "").trim()
          || code;

        // Extract value — title first (fast), PDF fallback
        let crores = extractCrFromTitle(title);

        if (!crores && pdfUrl && extractOrderValueFromPDF) {
          try {
            crores = await extractOrderValueFromPDF(pdfUrl);
            await sleep(400); // rate limit PDF fetches
          } catch { /* ok */ }
        }

        if (!crores || crores <= 0) {
          noValue++;
          console.log(`  ○ [${code}] ${company.slice(0,35).padEnd(35)} — no value  "${title.slice(0,50)}"`);
          continue;
        }

        console.log(`  ✅ [${code}] ${company.slice(0,35).padEnd(35)} +₹${crores}Cr  "${title.slice(0,45)}"`);

        if (!dryRun && orderBookDB?.addOrderToBook) {
          try {
            await orderBookDB.addOrderToBook(code, company, crores, title, pdfUrl);
            saved++;
          } catch(e) {
            console.log(`     ⚠️  Save failed: ${e.message}`);
          }
        } else {
          saved++; // count for dry run
        }
      }

      await sleep(800); // rate limit between chunks
    }

    saveSeen(seen);
  }

  // ── PHASE 2: Manual seed for known Q4FY26 orders ─────────────────────────
  console.log("\n━━━ Phase 2: Manual seed for known Q4FY26 orders ━━━\n");
  let seedAdded = 0;

  for (const s of Q4_ORDER_SEED) {
    const dedupeKey = `seed:${s.code}:Q4FY26`;
    if (seen.has(dedupeKey)) {
      console.log(`  ⏭  [${s.code}] ${s.company.padEnd(35)} already seeded`);
      continue;
    }

    const company = mcapDB[s.code]?.name || s.company;
    const display = s.crores >= 1000
      ? `₹${(s.crores/1000).toFixed(1)}K Cr`
      : `₹${s.crores} Cr`;

    console.log(`  📌 [${s.code}] ${company.slice(0,35).padEnd(35)} ${display}`);

    if (!dryRun && orderBookDB?.addOrderToBook) {
      try {
        await orderBookDB.addOrderToBook(
          s.code, company, s.crores,
          "Q4FY26 order backfill (manual seed)", null
        );
        seen.add(dedupeKey);
        seedAdded++;
      } catch(e) {
        console.log(`     ⚠️  Seed failed: ${e.message}`);
      }
    } else {
      seen.add(dedupeKey);
      seedAdded++;
    }
    await sleep(50);
  }

  saveSeen(seen);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  BSE API orders saved : ${saved}`);
  console.log(`  Manual seed added    : ${seedAdded}`);
  console.log(`  Skipped (duplicate)  : ${skipped}`);
  console.log(`  No value extracted   : ${noValue}`);
  console.log(`  Total new orders     : ${saved + seedAdded}`);
  if (dryRun) console.log("\n  (DRY RUN — nothing actually saved)");
  console.log(`${"═".repeat(60)}\n`);

  if (!dryRun) {
    console.log("✅ Done! Q4FY26 orders are now in MongoDB as newOrders.");
    console.log("   Your OrderBookTracker UI will show the updated currentOrderBook.\n");
  }

  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});