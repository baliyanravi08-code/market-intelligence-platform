const axios = require("axios");
const pdfParse = require("pdf-parse");

const detectOrder = require("./orderDetector");

async function extractOrderFromPDF(url) {

  try {

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000
    });

    const buffer = Buffer.from(response.data);

    // handle both export formats
    const pdf = typeof pdfParse === "function"
      ? pdfParse
      : pdfParse.default;

    const data = await pdf(buffer);

    const text = data.text || "";

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