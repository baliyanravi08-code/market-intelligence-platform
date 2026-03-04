const EventEmitter = require("events")

const bus = new EventEmitter()

function publish(channel,data){

 bus.emit(channel,data)

}

function subscribe(channel,handler){

 bus.on(channel,handler)

}

module.exports = { publish, subscribe }