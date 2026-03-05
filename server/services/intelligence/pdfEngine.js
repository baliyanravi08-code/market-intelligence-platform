const axios = require("axios");
const pdf = require("pdf-parse");

const detectOrder = require("./orderDetector");

async function extractOrderFromPDF(url) {

  try {

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000
    });

    const data = await pdf(response.data);

    const text = data.text;

    const orderValue = detectOrder(text);

    if (!orderValue) return null;

    return {
      value: orderValue,
      source: "PDF"
    };

  } catch (err) {

    console.log("PDF parse failed:", err.message);
    return null;

  }

}

module.exports = extractOrderFromPDF;