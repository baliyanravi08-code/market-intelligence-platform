function startCoordinator(io) {

  console.log("🚀 Coordinator Running")

  setInterval(() => {

    io.emit("system_event", {
      type: "heartbeat",
      time: new Date().toISOString()
    })

  }, 10000)

}

module.exports = startCoordinator