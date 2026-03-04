const axios = require("axios")
const { publish } = require("../server/queue")

let lastHeadline = ""

async function checkNSE(){

 try{

  const response = await axios.get(
   "https://www.nseindia.com/api/corporate-announcements"
  ,{
   headers:{
    "User-Agent":"Mozilla/5.0",
    "Accept":"application/json"
   }
  })

  const data = response.data

  if(!data || !data.data) return

  const announcement = data.data.find(a =>
   a.desc && a.desc.toLowerCase().includes("result")
  )

  if(!announcement) return

  const headline = announcement.desc

  if(headline === lastHeadline) return

  lastHeadline = headline

  console.log("📡 NSE RESULT DETECTED")

  await publish("RESULT_DETECTED",{
   headline
  })

 }catch(e){

  console.log("NSE Worker Error")

 }

}

setInterval(checkNSE,7000)