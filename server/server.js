const express = require("express")
const http = require("http")
const axios = require("axios")
const { Server } = require("socket.io")

const sectorMap = require("./services/data/sectorMap")

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
 BANK:50,
 PHARMA:50,
 DEFENSE:50,
 RAILWAY:50,
 AUTO:50,
 OTHER:50
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
SIGNAL ENGINE
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
  sectorScore[sector] += 2

 if(signal === "NEGATIVE")
  sectorScore[sector] -= 2

}

/*
==============================
FLOW ENGINE
==============================
*/

function detectFlow(){

 const flows = {}

 Object.entries(sectorScore)
 .forEach(([k,v])=>{

  if(v > 65)
   flows[k] = "🔥 STRONG BUY FLOW"

  else if(v < 40)
   flows[k] = "⚠ SELL PRESSURE"

  else
   flows[k] = "➖ NEUTRAL"

 })

 return flows

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

 if(total > 350) return "BULLISH 📈"
 if(total < 250) return "BEARISH 📉"

 return "SIDEWAYS"

}

/*
==============================
BSE FETCH ENGINE
==============================
*/

async function fetchAnnouncements(){

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
   market:marketDirection(),
   flow:detectFlow()

  })

  console.log("📡 RESULT DETECTED:",company)

 }catch(e){

  console.log("⚠ Market Fetch Failed")

 }

}

/*
==============================
MULTI WATCHERS
==============================
*/

setInterval(fetchAnnouncements,5000)

setTimeout(()=>{
 setInterval(fetchAnnouncements,5000)
},2000)

setTimeout(()=>{
 setInterval(fetchAnnouncements,5000)
},4000)

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
 console.log("🚀 ULTRA FAST RESULT ENGINE RUNNING")
})