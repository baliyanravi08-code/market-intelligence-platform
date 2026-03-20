// Maps BSE scrip codes AND company name keywords → sector
// NOTE: Each code must appear only ONCE — last entry wins otherwise

const CODE_MAP = {
  // ── BANKING ──
  "532215": "Banking", "532418": "Banking", "500247": "Banking",
  "532149": "Banking", "532648": "Banking", "500180": "Banking",
  "500010": "Banking", "500112": "Banking", "532134": "Banking",
  "540611": "Banking", "532978": "Banking", "500116": "Banking",
  "532187": "Banking", "532483": "Banking", "543257": "Banking",

  // ── IT / TECHNOLOGY ──
  "500209": "IT", "532540": "IT", "507685": "IT", "526299": "IT",
  "532755": "IT", "533218": "IT", "500475": "IT", "532174": "IT",
  "544320": "IT",   // Rnit AI Solutions

  // ── PHARMA / HEALTHCARE ──
  "500124": "Pharma", "524715": "Pharma", "500359": "Pharma",
  "532488": "Pharma", "500302": "Pharma", "500087": "Pharma",
  "524494": "Pharma", "540180": "Pharma", "543278": "Pharma",

  // ── AUTO ──
  "500520": "Auto", "532500": "Auto", "500182": "Auto",
  "500570": "Auto", "532977": "Auto", "500493": "Auto",
  "520056": "Auto", "544320": "Auto",

  // ── ENERGY / OIL / GAS ──
  "500325": "Energy", "500312": "Energy", "532555": "Energy",
  "524208": "Energy", "500096": "Energy", "533096": "Energy",  // Adani Power
  "542066": "Energy", "539526": "Energy",
  "544200": "Energy",   // ACME Solar

  // ── SOLAR / RENEWABLE ──
  "540702": "Solar", "542726": "Solar", "544516": "Solar",   // Airfloa Rail (solar orders)
  "543245": "Solar", "544200": "Solar",

  // ── DEFENSE ──
  "541143": "Defense", "500024": "Defense", "540678": "Defense",
  "541179": "Defense", "543280": "Defense", "533096": "Defense",
  "543700": "Defense",

  // ── RAILWAY / INFRASTRUCTURE ──
  "544453": "Infrastructure",  // Monarch Surveyors
  "542649": "Infrastructure",  // RVNL
  "532898": "Infrastructure",  // IRFC
  "500420": "Infrastructure",  "532538": "Infrastructure",
  "500010": "Infrastructure",

  // ── WATER / EPC ──
  "533269": "Water",   // VA Tech Wabag
  "500510": "Water",   // L&T (also EPC)

  // ── METALS / STEEL ──
  "500470": "Metals",  "532286": "Metals", "500316": "Metals",
  "500295": "Metals",  "500400": "Metals",

  // ── FMCG ──
  "500875": "FMCG", "500676": "FMCG", "500484": "FMCG",
  "500696": "FMCG",

  // ── TELECOM ──
  "532454": "Telecom", "532975": "Telecom", "500900": "Telecom",

  // ── CEMENT ──
  "500387": "Cement", "532868": "Cement", "500425": "Cement",
  "500770": "Cement",

  // ── REAL ESTATE ──
  "532819": "RealEstate", "533274": "RealEstate", "532721": "RealEstate",

  // ── CHEMICALS ──
  "542434": "Chemicals", "500042": "Chemicals", "506395": "Chemicals",
  "524598": "Chemicals",

  // ── TEXTILES ──
  "514162": "Textiles", "532644": "Textiles", "500355": "Textiles",
};

// ── Keyword fallback — match company name if code not in map ──
const KEYWORD_MAP = [
  // Finance / Banking
  { words: ["bank", "finance", "financial", "nbfc", "credit", "lending", "microfinance", "capital advisors", "capital service"], sector: "Banking" },

  // IT
  { words: ["tech", "software", "infotech", "systems", "digital", "data", "cyber", "solutions ltd", "ai solutions"], sector: "IT" },

  // Pharma
  { words: ["pharma", "drug", "biotech", "life science", "healthcare", "hospital", "medic", "lab", "diagnostics", "health"], sector: "Pharma" },

  // Auto
  { words: ["auto", "motor", "vehicle", "tyres", "tractor", "wheels", "stampings", "automotive"], sector: "Auto" },

  // Defense
  { words: ["defence", "defense", "ordnance", "armament", "military", "bharat electronics", "bel", "hal", "drdo"], sector: "Defense" },

  // Railway
  { words: ["railway", "rail ", "metro", "rvnl", "irfc", "irctc", "coaches", "bogies", "locomotive"], sector: "Railway" },

  // Solar / Renewable
  { words: ["solar", "wind energy", "renewable", "rooftop solar", "solar pv", "green energy", "clean energy"], sector: "Solar" },

  // Energy / Power
  { words: ["power", "energy", "oil", "gas", "petro", "thermal", "ntpc", "adani power", "tata power"], sector: "Energy" },

  // Water / EPC
  { words: ["water", "wabag", "sewage", "desalin", "wastewater", "irrigation"], sector: "Water" },

  // Infrastructure / Construction
  { words: ["infra", "construct", "engineer", "road", "bridge", "build", "surveyors", "epc", "turnkey", "structural"], sector: "Infrastructure" },

  // Metals
  { words: ["steel", "metal", "copper", "zinc", "alumin", "iron", "mineral", "hindalco", "tata steel"], sector: "Metals" },

  // Chemicals
  { words: ["chemical", "plastic", "polymer", "paint", "adhesive", "resin", "fertilizer"], sector: "Chemicals" },

  // Cement
  { words: ["cement", "ultratech", "shree cement", "ambuja", "acc "], sector: "Cement" },

  // FMCG
  { words: ["fmcg", "consumer", "foods", "beverage", "dairy", "agro", "tobacco", "britannia", "nestl"], sector: "FMCG" },

  // Telecom
  { words: ["telecom", "tower", "mobile", "broadband", "network", "airtel", "jio", "vodafone"], sector: "Telecom" },

  // Real Estate
  { words: ["realty", "real estate", "housing", "property", "developer", "estates"], sector: "RealEstate" },

  // Insurance
  { words: ["insurance", "insur", "life insurance", "general insurance"], sector: "Insurance" },

  // Textiles
  { words: ["textile", "garment", "fabric", "apparel", "cotton", "yarn", "spinning"], sector: "Textiles" },

  // Retail
  { words: ["retail", "mall", "store", "ecommerce", "d-mart", "supermarket"], sector: "Retail" },
];

function getSector(code, companyName) {
  // Code lookup first — most accurate
  if (code && CODE_MAP[String(code)]) return CODE_MAP[String(code)];

  // Company name keyword fallback
  if (!companyName) return null;
  const lower = companyName.toLowerCase();

  for (const { words, sector } of KEYWORD_MAP) {
    if (words.some(w => lower.includes(w))) return sector;
  }

  return null;
}

module.exports = { getSector };