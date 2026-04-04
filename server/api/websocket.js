const express = require("express")
const http = require("http")
const { Server } = require("socket.io")

const { subscribe } = require("../queue")

const app = express()
const server = http.createServer(app)

const io = new Server(server,{
 cors:{origin:"*"}
})

subscribe("SECTOR_UPDATED",(data)=>{

 io.emit("update",data)

})

io.on("connection",()=>{
 console.log("👤 Dashboard Connected")
})

server.listen(4000,()=>{

 console.log("🌐 WebSocket Server Running")

})