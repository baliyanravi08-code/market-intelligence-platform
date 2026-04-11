"use strict";

/**
 * server/queue.js
 *
 * Central event bus for inter-module communication.
 *
 * Usage:
 *   const { publish, subscribe } = require("./queue");          // from server/
 *   const { publish, subscribe } = require("../queue");         // from server/api/
 *   const { publish, subscribe } = require("../../queue");      // from server/services/
 *
 *   publish("SECTOR_UPDATED", { sector: "IT", ... });
 *   subscribe("SECTOR_UPDATED", (data) => { ... });
 *
 * If any legacy file still does:
 *   const eventBus = require("./queue");
 *   eventBus.emit("SECTOR_UPDATED", data);
 * that still works because eventBus itself is also exported as default.
 */

const EventEmitter = require("events");

class EventBus extends EventEmitter {}

const eventBus = new EventBus();

// Raise the default listener limit — we have many subscribers across modules
eventBus.setMaxListeners(50);

/**
 * Emit an event to all subscribers.
 * @param {string} event
 * @param {*} data
 */
function publish(event, data) {
  eventBus.emit(event, data);
}

/**
 * Subscribe to an event. Handler is called every time the event fires.
 * @param {string} event
 * @param {function} handler
 */
function subscribe(event, handler) {
  eventBus.on(event, handler);
}

/**
 * Subscribe to an event once — auto-removes after first call.
 * @param {string} event
 * @param {function} handler
 */
function subscribeOnce(event, handler) {
  eventBus.once(event, handler);
}

/**
 * Remove a specific handler from an event.
 * @param {string} event
 * @param {function} handler
 */
function unsubscribe(event, handler) {
  eventBus.off(event, handler);
}

module.exports = {
  eventBus,      // legacy compat — old code doing require("./queue").emit() still works
  publish,
  subscribe,
  subscribeOnce,
  unsubscribe,
};