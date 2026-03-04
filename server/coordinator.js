console.log("🚀 Coordinator Running")

// Workers
require("../workers/bseWorker")
require("../workers/nseWorker")
require("../workers/analyzerWorker")
require("../workers/sectorWorker")

// API
require("../api/websocket")

console.log("✅ Workers Loaded")