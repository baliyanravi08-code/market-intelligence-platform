const express = require("express")
const http = require("http")
const { Server } = require("socket.io")
const path = require("path")

const app = express()
const server = http.createServer(app)

const io = new Server(server,{
 cors:{origin:"*"}
})

/*
========================================
SERVE FRONTEND (REACT BUILD)
========================================
*/

const clientPath = path.join(__dirname,"../client/dist")

app.use(express.static(clientPath))

app.get("*",(req,res)=>{
 res.sendFile(path.join(clientPath,"index.html"))
})

/*
========================================
WEBSOCKET
========================================
*/

io.on("connection",(socket)=>{
 console.log("👤 Dashboard Connected")
})

/*
========================================
MARKET ENGINE START
========================================
*/

console.log("🚀 ULTRA FAST RESULT ENGINE RUNNING")

const PORT = process.env.PORT || 4000

server.listen(PORT,()=>{
 console.log("🌐 Server running on port",PORT)
})