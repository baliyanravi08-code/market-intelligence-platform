const { subscribe, publish } = require("../server/queue")

const { detectSector, updateSector, sectorScore }
= require("../engines/sectorEngine")

subscribe("RESULT_ANALYZED",async(data)=>{

 const sector = detectSector(data.headline)

 updateSector(sector,data.signal)

 await publish("SECTOR_UPDATED",{

  headline:data.headline,
  sector,
  signal:data.signal,
  sectorScore

 })

 console.log("📊 SECTOR UPDATED")

})