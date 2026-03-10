// Maps BSE scrip codes AND company name keywords → sector
const CODE_MAP = {
  // BANKING
  "532215": "Banking", "532418": "Banking", "500247": "Banking",
  "532149": "Banking", "532648": "Banking", "500180": "Banking",
  "500010": "Banking", "500112": "Banking", "532134": "Banking",
  "540611": "Banking", "532978": "Banking", "500116": "Banking",

  // IT
  "500209": "IT", "532540": "IT", "507685": "IT", "526299": "IT",
  "500696": "IT", "532755": "IT", "533218": "IT", "500475": "IT",

  // PHARMA
  "500124": "Pharma", "524715": "Pharma", "500359": "Pharma",
  "532488": "Pharma", "500302": "Pharma", "500087": "Pharma",
  "524494": "Pharma", "540180": "Pharma",

  // AUTO
  "500520": "Auto", "532500": "Auto", "500182": "Auto",
  "500570": "Auto", "532977": "Auto", "500493": "Auto",
  "520056": "Auto",

  // ENERGY / OIL
  "500325": "Energy", "500312": "Energy", "532555": "Energy",
  "500010": "Energy", "524208": "Energy", "500096": "Energy",

  // METALS
  "500470": "Metals", "500400": "Metals", "500010": "Metals",
  "532286": "Metals", "500316": "Metals",

  // FMCG
  "500696": "FMCG", "500470": "FMCG", "500875": "FMCG",
  "500676": "FMCG", "500484": "FMCG",

  // INFRA / CONSTRUCTION
  "532978": "Infrastructure", "500010": "Infrastructure",
  "500420": "Infrastructure", "532538": "Infrastructure",

  // TELECOM
  "532454": "Telecom", "532975": "Telecom", "500900": "Telecom",

  // CEMENT
  "500387": "Cement", "532868": "Cement", "500425": "Cement",
  "500770": "Cement",

  // REAL ESTATE
  "532819": "RealEstate", "533274": "RealEstate",
  "532721": "RealEstate",
};

// Keyword fallback — if code not found, match company name
const KEYWORD_MAP = [
  { words: ["bank", "finance", "financial", "nbfc", "credit", "lending", "microfinance"], sector: "Banking" },
  { words: ["tech", "software", "infotech", "systems", "digital", "data", "cyber", "it "], sector: "IT" },
  { words: ["pharma", "drug", "biotech", "life science", "healthcare", "health", "hospital", "medic", "lab", "diagnostics"], sector: "Pharma" },
  { words: ["auto", "motor", "vehicle", "tyres", "tractor", "wheels"], sector: "Auto" },
  { words: ["oil", "gas", "petro", "energy", "power", "solar", "wind", "renew"], sector: "Energy" },
  { words: ["steel", "metal", "copper", "zinc", "alumin", "iron", "mineral"], sector: "Metals" },
  { words: ["fmcg", "consumer", "foods", "beverage", "dairy", "agro", "tobacco"], sector: "FMCG" },
  { words: ["infra", "construct", "cement", "engineer", "road", "bridge", "build"], sector: "Infrastructure" },
  { words: ["telecom", "tower", "mobile", "broadband", "network"], sector: "Telecom" },
  { words: ["realty", "real estate", "housing", "property", "developer"], sector: "RealEstate" },
  { words: ["insurance", "insur"], sector: "Insurance" },
  { words: ["textile", "garment", "fabric", "apparel", "cotton"], sector: "Textiles" },
  { words: ["chemical", "plastic", "polymer", "paint", "adhesive"], sector: "Chemicals" },
  { words: ["retail", "mall", "store", "ecommerce", "d-mart"], sector: "Retail" },
];

function getSector(code, companyName) {
  if (code && CODE_MAP[String(code)]) return CODE_MAP[String(code)];
  if (!companyName) return null;
  const lower = companyName.toLowerCase();
  for (const { words, sector } of KEYWORD_MAP) {
    if (words.some(w => lower.includes(w))) return sector;
  }
  return null;
}

module.exports = { getSector };