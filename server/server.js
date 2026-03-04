const express = require("express")
const http = require("http")
const axios = require("axios")
const { Server } = require("socket.io")

const sectorMap = require("./data/sectorMap")

const app = express()
const server = http.createServer(app)

const io = new Server(server,{
 cors:{origin:"*"}
})

/*
==============================
STORAGE
==============================
*/

const results = []

const sectorScore = {
 BANK:0,
 PHARMA:0,
 DEFENSE:0,
 RAILWAY:0,
 AUTO:0,
 OTHER:0
}

let lastId = ""

/*
==============================
SECTOR DETECTOR
==============================
*/

function detectSector(company){

 const key = company.replace(/\s/g,"").toUpperCase()

 if(sectorMap[key])
  return sectorMap[key]

 return "OTHER"

}

/*
==============================
RESULT SIGNAL ENGINE
==============================
*/

function analyze(text){

 const t = text.toLowerCase()

 if(t.includes("record") || t.includes("growth"))
  return "POSITIVE"

 if(t.includes("loss") || t.includes("decline"))
  return "NEGATIVE"

 return "NEUTRAL"

}

/*
==============================
UPDATE SECTOR
==============================
*/

function updateSector(sector,signal){

 if(signal === "POSITIVE")
  sectorScore[sector]++

 if(signal === "NEGATIVE")
  sectorScore[sector]--

}

/*
==============================
MARKET TREND
==============================
*/

function marketDirection(){

 const total =
 Object.values(sectorScore)
 .reduce((a,b)=>a+b,0)

 if(total > 5) return "BULLISH"
 if(total < -5) return "BEARISH"

 return "SIDEWAYS"

}

/*
==============================
BSE RESULT WATCHER
==============================
*/

async function checkBSE(){

 try{

  const response = await axios.get(
   "https://api.allorigins.win/raw?url=https://www.bseindia.com/corporates/ann.html"
  )

  const html = response.data

  const match =
  html.match(/Financial Results[^<]*/i)

  if(!match) return

  const text = match[0]

  const id = text.slice(0,40)

  if(id === lastId) return

  lastId = id

  const company =
  text.split(" ")[0]

  const sector = detectSector(company)

  const signal = analyze(text)

  updateSector(sector,signal)

  const result = {

   company,
   sector,
   signal,
   insight:text,
   time:new Date().toLocaleTimeString()

  }

  results.unshift(result)

  io.emit("update",{
   result,
   sectorScore,
   market:marketDirection()
  })

  console.log("📡 RESULT DETECTED:",company)

 }catch(e){

  console.log("⚠ Market Fetch Failed")

 }

}

/*
==============================
RUN EVERY 5 SEC
==============================
*/

setInterval(checkBSE,5000)

/*
==============================
API
==============================
*/

app.get("/history",(req,res)=>{
 res.json(results)
})

/*
==============================
SOCKET
==============================
*/

io.on("connection",()=>{
 console.log("👤 Dashboard Connected")
})

/*
==============================
START SERVER
==============================
*/

const PORT = process.env.PORT || 4000

server.listen(PORT,()=>{
 console.log("🚀 REAL MARKET WATCHER RUNNING")
})