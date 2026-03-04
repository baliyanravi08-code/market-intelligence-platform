const axios = require("axios")
const { publish } = require("../server/queue")

let lastHeadline = ""

async function checkBSE(){

 try{

  const response = await axios.get(
   "https://api.allorigins.win/raw?url=https://www.bseindia.com/corporates/ann.html"
  )

  const html = response.data

  const match = html.match(/Financial Results[^<]*/i)

  if(!match) return

  const headline = match[0]

  if(headline === lastHeadline) return

  lastHeadline = headline

  console.log("📡 RESULT DETECTED")

  await publish("RESULT_DETECTED",{
   headline
  })

 }catch(e){

  console.log("BSE Worker Error")

 }

}

setInterval(checkBSE,5000)