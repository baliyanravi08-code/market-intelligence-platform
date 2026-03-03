const express = require("express");
const http = require("http");
const path = require("path");

const app = express();
const server = http.createServer(app);

/*
====================================
RENDER HEALTH CHECK
====================================
VERY IMPORTANT
*/
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/*
====================================
SERVE FRONTEND BUILD
====================================
*/

const distPath = path.join(__dirname, "../client/dist");

app.use(express.static(distPath));

/*
Express v5 SAFE fallback
*/
app.use((req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

/*
====================================
START SERVER (RENDER SAFE)
====================================
*/

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ SERVER LISTENING ON PORT ${PORT}`);
});