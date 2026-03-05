const axios = require("axios");
const fs = require("fs");
const path = require("path");
const extract = require("pdf-text-extract");

const detectOrder = require("./orderDetector");

async function extractOrderFromPDF(url){

  try{

    const tempFile = path.join(__dirname, "temp.pdf");

    const res = await axios.get(url,{
      responseType:"arraybuffer",
      timeout:15000
    });

    fs.writeFileSync(tempFile,res.data);

    return new Promise((resolve)=>{

      extract(tempFile,function(err,pages){

        fs.unlinkSync(tempFile);

        if(err){
          console.log("PDF parse failed:",err.message);
          return resolve(null);
        }

        const text = pages.join(" ");

        const orderValue = detectOrder(text);

        if(!orderValue) return resolve(null);

        resolve({
          value: orderValue,
          source:"PDF"
        });

      });

    });

  }catch(err){

    console.log("PDF download failed:",err.message);

    return null;

  }

}

module.exports = extractOrderFromPDF;