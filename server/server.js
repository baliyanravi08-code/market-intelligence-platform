const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const {
  fetchBSEAnnouncement
} = require("./services/bseListener");

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
  cors:{origin:"*"}
});

/*
==============================
HEALTH
==============================
*/
app.get("/health",(req,res)=>{
  res.send("OK");
});

/*
==============================
SERVE FRONTEND
==============================
*/
const distPath =
 path.join(__dirname,"../client/dist");

app.use(express.static(distPath));

app.use((req,res)=>{
 res.sendFile(
  path.join(distPath,"index.html")
 );
});

/*
==============================
REAL BSE ENGINE
==============================
*/

setInterval(async()=>{

 try{

  const data =
   await fetchBSEAnnouncement();

  if(!data) return;

  console.log("📡 REAL BSE EVENT");

  io.emit("announcement",data);

 }catch(err){
  console.log("Engine Error");
 }

},20000);

/*
==============================
SOCKET
==============================
*/
io.on("connection",()=>{
 console.log("👤 Dashboard Connected");
});

/*
==============================
START SERVER
==============================
*/
const PORT =
 process.env.PORT || 4000;

server.listen(PORT,"0.0.0.0",()=>{
 console.log(
  `✅ SERVER LISTENING ON PORT ${PORT}`
 );
});