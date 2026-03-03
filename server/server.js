const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

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
TEST LIVE ENGINE
(simulates BSE)
==============================
*/

setInterval(()=>{

 const fakeData={
  company:"TCS",
  sector:"IT",
  strengthScore:
   Math.floor(Math.random()*100),
  marketStatus:"Bullish",
  time:new Date().toLocaleTimeString()
 };

 console.log("📡 Sending Live Data");

 io.emit("announcement",fakeData);

},10000);

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
 console.log(`✅ SERVER LISTENING ON PORT ${PORT}`);
});