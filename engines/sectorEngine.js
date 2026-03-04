const sectorScore = {

 BANK:50,
 PHARMA:50,
 DEFENSE:50,
 AUTO:50,
 RAILWAY:50,
 OTHER:50

}

function detectSector(text){

 const t = text.toLowerCase()

 if(t.includes("bank")) return "BANK"
 if(t.includes("pharma")) return "PHARMA"
 if(t.includes("defence")) return "DEFENSE"
 if(t.includes("auto")) return "AUTO"
 if(t.includes("rail")) return "RAILWAY"

 return "OTHER"

}

function updateSector(sector,signal){

 if(signal === "POSITIVE")
  sectorScore[sector] += 2

 if(signal === "NEGATIVE")
  sectorScore[sector] -= 2

}

module.exports = { detectSector, updateSector, sectorScore }