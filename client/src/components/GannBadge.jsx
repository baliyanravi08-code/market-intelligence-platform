"use strict";

/**
 * marketHours.js
 * server/services/intelligence/marketHours.js
 *
 * Single source of truth for Indian market hours.
 * NSE/BSE Hours: Mon–Fri, 09:00 – 15:45 IST (with buffer)
 */

const MARKET_OPEN_H  = 9;
const MARKET_OPEN_M  = 0;    // allow from 09:00 (pre-open)
const MARKET_CLOSE_H = 15;
const MARKET_CLOSE_M = 45;   // buffer past 15:30

/**
 * Returns current IST time parts.
 */
function nowIST() {
  const now   = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const istMs = utcMs + 5.5 * 60 * 60 * 1000;
  const ist   = new Date(istMs);
  return {
    day:     ist.getDay(),     // 0=Sun, 6=Sat
    hours:   ist.getHours(),
    minutes: ist.getMinutes(),
    date:    ist.toISOString().slice(0, 10),
    ist,
  };
}

/**
 * Returns true if the market is currently open.
 * Mon–Fri, 09:00–15:45 IST only.
 */
function isMarketOpen() {
  const { day, hours, minutes } = nowIST();
  if (day === 0 || day === 6) return false;
  const total = hours * 60 + minutes;
  const open  = MARKET_OPEN_H  * 60 + MARKET_OPEN_M;
  const close = MARKET_CLOSE_H * 60 + MARKET_CLOSE_M;
  return total >= open && total <= close;
}

/**
 * Returns true if today is a weekday (Mon–Fri).
 */
function isWeekday() {
  const { day } = nowIST();
  return day >= 1 && day <= 5;
}

/**
 * Returns minutes until next market open (from now, IST).
 * Returns 0 if market is already open.
 */
function minutesUntilOpen() {
  if (isMarketOpen()) return 0;
  const { day, hours, minutes } = nowIST();
  if (isWeekday()) {
    const totalNow  = hours * 60 + minutes;
    const totalOpen = MARKET_OPEN_H * 60 + MARKET_OPEN_M;
    if (totalNow < totalOpen) return totalOpen - totalNow;
  }
  return 999;
}

/**
 * Returns a human-readable status string.
 */
function marketStatus() {
  const { day, hours, minutes } = nowIST();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (day === 0 || day === 6) return `CLOSED (${days[day]} — weekend)`;
  if (isMarketOpen())         return `OPEN (${hours}:${String(minutes).padStart(2, "0")} IST)`;
  const total = hours * 60 + minutes;
  const open  = MARKET_OPEN_H * 60 + MARKET_OPEN_M;
  if (total < open) return `PRE-MARKET (opens 09:00 IST)`;
  return `CLOSED (after hours — ${hours}:${String(minutes).padStart(2, "0")} IST)`;
}

module.exports = { isMarketOpen, isWeekday, minutesUntilOpen, marketStatus, nowIST };