/**
 * fetchAllMcap.js
 * Fetches MCap for ALL BSE companies > ₹100Cr
 * Run: node server/scripts/fetchAllMcap.js
 * Saves to: server/data/marketCapDB.json
 */

const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const OUT_FILE = path.join(__dirname, "../data/marketCapDB.json");
const MIN_MCAP = 100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseMcap(d) {
  const raw = d?.MarketCapCr || d?.Mktcap || d?.mktcap || d?.MktCap
            || d?.mktCap || d?.MKTCAP || d?.Mcap || d?.mcap || null;
  if (!raw) return null;
  const v = parseFloat(String(raw).replace(/,/g, ""));
  return v > 0 ? v : null;
}

// ── Try to get BSE cookie first ──
async function getBSECookie() {
  try {
    const res = await axios.get("https://www.bseindia.com/corporates/ann.html", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeout: 15000,
      maxRedirects: 5
    });
    const cookies = res.headers["set-cookie"];
    if (cookies?.length) {
      const cookie = cookies.map(c => c.split(";")[0]).join("; ");
      console.log("✅ Got BSE cookie");
      return cookie;
    }
  } catch(e) {
    console.log("⚠️ Could not get BSE cookie:", e.message);
  }
  return "";
}

async function fetchCompanyList(cookie) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.bseindia.com/corporates/ann.html",
    "Origin": "https://www.bseindia.com",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) headers["Cookie"] = cookie;

  // Try multiple APIs
  const apis = [
    // API 1: Full equity list
    "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&shname=&industry=&segment=Equity&status=Active",
    // API 2: Market cap list
    "https://api.bseindia.com/BseIndiaAPI/api/GetMarketcapData/w?segment=Equity&indexname=&scripcode=&msector=&pageno=1&pagesize=10000",
    // API 3: BSE 500
    "https://api.bseindia.com/BseIndiaAPI/api/GetIndexMembers/w?index=BSE500",
    // API 4: All listed
    "https://api.bseindia.com/BseIndiaAPI/api/getScripData/w?segment=Equity&status=Active",
  ];

  for (const url of apis) {
    try {
      console.log(`\n🔍 Trying: ${url.substring(0, 80)}...`);
      const res  = await axios.get(url, { headers, timeout: 30000 });
      const data = res.data;

      // Try all possible response structures
      const rows =
        data?.Table   || data?.Table1  || data?.Table2 ||
        data?.data    || data?.Data    || data?.members ||
        (Array.isArray(data) ? data : []);

      if (rows.length > 0) {
        console.log(`✅ Got ${rows.length} rows from this API`);
        console.log("Sample keys:", Object.keys(rows[0] || {}).slice(0, 10).join(", "));
        return rows;
      } else {
        console.log("⚠️ Empty response, keys:", Object.keys(data || {}).join(", "));
      }
    } catch(e) {
      console.log(`⚠️ API failed: ${e.message}`);
    }
    await sleep(1000);
  }
  return [];
}

async function fetchMcapForCode(code, cookie) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.bseindia.com",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.bseindia.com",
  };
  if (cookie) headers["Cookie"] = cookie;

  try {
    const res  = await axios.get(
      `https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w?Scrip_Cd=${code}`,
      { headers, timeout: 5000 }
    );
    return parseMcap(res.data);
  } catch(e) { return null; }
}

async function main() {
  console.log("🚀 MCap Fetcher — BSE Companies > ₹100Cr\n");

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  // Load existing data if any
  let result = {};
  if (fs.existsSync(OUT_FILE)) {
    try {
      result = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
      console.log(`📦 Loaded ${Object.keys(result).length} existing entries`);
    } catch(e) {}
  }

  // Get cookie
  const cookie = await getBSECookie();
  await sleep(2000);

  // Fetch company list
  const rows = await fetchCompanyList(cookie);

  if (rows.length === 0) {
    console.log("\n❌ Could not fetch company list from any BSE API");
    console.log("\n💡 Alternative: Using BSE bulk download");
    console.log("   Visit: https://www.bseindia.com/corporates/List_Scrips.html");
    console.log("   Download the CSV and place it at server/data/bse_companies.csv");
    console.log("   Then re-run this script\n");

    // Try CSV fallback
    const csvPath = path.join(__dirname, "../data/bse_companies.csv");
    if (fs.existsSync(csvPath)) {
      console.log("📂 Found CSV file, processing...");
      const csv  = fs.readFileSync(csvPath, "utf8");
      const lines = csv.split("\n").slice(1); // skip header
      for (const line of lines) {
        const parts = line.split(",");
        const code  = (parts[0] || "").trim().replace(/"/g, "");
        const name  = (parts[1] || "").trim().replace(/"/g, "");
        if (code && code.length >= 4) {
          rows.push({ code, name });
        }
      }
      console.log(`✅ Loaded ${rows.length} companies from CSV`);
    } else {
      process.exit(1);
    }
  }

  // Process each company
  const companies = rows.map(r => ({
    code: String(r.SCRIP_CD || r.scripCd || r.Scrip_Cd || r.scripcode || r.code || "").trim(),
    name: r.Scrip_Name || r.LONG_NAME || r.CompanyName || r.name || "",
    mcap: parseMcap(r) // some APIs return MCap directly
  })).filter(r => r.code && r.code.length >= 4);

  console.log(`\n📊 Processing ${companies.length} companies...`);

  // If MCap already in the list response, use it directly
  let directMcap = 0;
  for (const c of companies) {
    if (c.mcap && c.mcap >= MIN_MCAP) {
      result[c.code] = { mcap: c.mcap, name: c.name };
      directMcap++;
    }
  }

  if (directMcap > 100) {
    console.log(`✅ Got MCap directly from list API: ${directMcap} companies`);
  } else {
    // Need to fetch individually
    const toFetch = companies.filter(c => !result[c.code]);
    console.log(`\n⬇️  Fetching MCap individually for ${toFetch.length} companies`);
    console.log("⏱  Rate: 3/sec — estimated time:", Math.ceil(toFetch.length / 3 / 60), "minutes\n");

    let done = 0, found = 0;
    for (const company of toFetch) {
      const mcap = await fetchMcapForCode(company.code, cookie);
      if (mcap && mcap >= MIN_MCAP) {
        result[company.code] = { mcap, name: company.name };
        found++;
        process.stdout.write(`✅ ${company.name.substring(0,30).padEnd(30)} ₹${mcap}Cr\n`);
      }
      done++;
      if (done % 100 === 0) {
        console.log(`\n📊 Progress: ${done}/${toFetch.length} | Found: ${found} above ₹${MIN_MCAP}Cr`);
        fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
      }
      await sleep(334); // 3/sec
    }
  }

  // Save
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
  const sorted = Object.entries(result).sort((a,b) => b[1].mcap - a[1].mcap);
  console.log(`\n✅ SAVED: ${Object.keys(result).length} companies → ${OUT_FILE}`);
  console.log("\nTop 10:");
  sorted.slice(0,10).forEach(([code, d]) =>
    console.log(`  ${String(d.name).padEnd(35)} ${code}  ₹${d.mcap?.toLocaleString()}Cr`)
  );
}

main().catch(console.error);