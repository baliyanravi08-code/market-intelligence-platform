const express = require("express")
const http = require("http")
const { Server } = require("socket.io")

const sectorMap = require("./data/sectorMap")

const app = express()
const server = http.createServer(app)

const io = new Server(server,{
 cors:{origin:"*"}
})

/*
==============================
DATABASE (TEMP MEMORY)
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

/*
==============================
DETECT SECTOR
==============================
*/

function detectSector(company){

 const key = company.replace(/\s/g,"").toUpperCase()

 if(sectorMap[key]){
  return sectorMap[key]
 }

 return "OTHER"
}

/*
==============================
SIGNAL GENERATOR
==============================
*/

function generateSignal(){

 const r = Math.random()

 if(r > 0.65) return "POSITIVE"
 if(r < 0.35) return "NEGATIVE"

 return "NEUTRAL"
}

/*
==============================
UPDATE SECTOR SCORE
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
MARKET DIRECTION
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
SIMULATED MARKET EVENTS
==============================
*/

setInterval(()=>{

 const companies = [
  "HDFCBANK",
  "ICICIBANK",
  "SUNPHARMA",
  "HAL",
  "BEL",
  "TITAN",
  "TATAMOTORS",
  "IRCTC",
  "RVNL"
 ]

 const company =
 companies[Math.floor(Math.random()*companies.length)]

 const sector = detectSector(company)

 const signal = generateSignal()

 updateSector(sector,signal)

 const result = {
  company,
  sector,
  signal,
  time:new Date().toLocaleTimeString()
 }

 results.unshift(result)

 io.emit("update",{
  result,
  sectorScore,
  market:marketDirection()
 })

 console.log("📡 MARKET EVENT",company)

},15000)

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
 console.log("🚀 MARKET INTELLIGENCE ENGINE RUNNING")
})