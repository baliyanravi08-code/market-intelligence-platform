const axios = require("axios");
const pdfParse = require("pdf-parse");

const detectOrder = require("./orderDetector");

async function extractOrderFromPDF(url){

  try{

    const res = await axios.get(url,{
      responseType:"arraybuffer",
      timeout:15000
    });

    const buffer = Buffer.from(res.data);

    // support both export styles
    const parser = typeof pdfParse === "function"
      ? pdfParse
      : pdfParse.default;

    const data = await parser(buffer);

    const text = data?.text || "";

    const orderValue = detectOrder(text);

    if(!orderValue) return null;

    return {
      value: orderValue,
      source: "PDF"
    };

  }catch(err){

    console.log("PDF parse failed:", err.message);

    return null;

  }

}

module.exports = extractOrderFromPDF;