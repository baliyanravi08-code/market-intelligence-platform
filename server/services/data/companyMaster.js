const axios = require("axios");
const csv = require("csv-parser");
const { Readable } = require("stream");

let companyMap = new Map();

async function loadNSECompanies() {

  const url =
    "https://archives.nseindia.com/content/equities/EQUITY_L.csv";

  const res = await axios.get(url);

  const stream = Readable.from(res.data);

  return new Promise((resolve) => {

    stream
      .pipe(csv())
      .on("data", (row) => {

        companyMap.set(row.SYMBOL, {
          symbol: row.SYMBOL,
          name: row.NAME_OF_COMPANY,
          exchange: "NSE"
        });

      })
      .on("end", resolve);

  });

}

async function loadBSECompanies() {

  const url =
    "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w";

  const res = await axios.get(url);

  const list = res.data || [];

  list.forEach((item) => {

    companyMap.set(String(item.SCRIP_CD), {
      symbol: item.SCRIP_CD,
      name: item.SCRIPNAME,
      exchange: "BSE"
    });

  });

}

async function loadCompanyMaster() {

  console.log("📊 Loading company master...");

  await loadNSECompanies();
  await loadBSECompanies();

  console.log("✅ Companies loaded:", companyMap.size);

}

function getCompany(symbol) {

  return companyMap.get(symbol);

}

module.exports = {
  loadCompanyMaster,
  getCompany
};