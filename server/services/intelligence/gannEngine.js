/**
 * gannEngine.js
 * server/services/intelligence/gannEngine.js
 *
 * W.D. Gann Analysis Engine for NSE/BSE India
 *
 * Implements:
 *   1. Square of Nine  — price targets & vibration levels
 *   2. Gann Angles     — 1×1, 2×1, 1×2, 4×1, 1×4 from swing pivots
 *   3. Time Cycles     — 90°, 120°, 144°, 180°, 270°, 360° from key dates
 *   4. Cardinal Cross  — horizontal S/R from Square of Nine cardinal axis
 *   5. Gann Fan        — multi-angle fan from a confirmed swing point
 *   6. Seasonal Dates  — Gann's "master time factor" calendar for India market
 *   7. Signal fusion   — converts all Gann readings into a single bias + alerts
 *
 * Usage:
 *   const gann = require("./gannEngine");
 *
 *   // Full analysis
 *   const analysis = gann.analyzeGann({
 *     symbol: "RELIANCE",
 *     ltp: 2941.50,
 *     high52w: 3217.90,
 *     low52w: 2220.30,
 *     swingHigh: { price: 3050, date: "2024-09-27" },
 *     swingLow:  { price: 2680, date: "2024-11-14" },
 *     listingDate: "1977-11-12",   // for time cycle origin
 *     priceUnit: 1,                // 1 for large-cap, 0.5 for mid-cap
 *   });
 *
 *   // Just Square of Nine levels for a price
 *   const levels = gann.squareOfNine(2941.50);
 *
 *   // Gann angles from a swing point
 *   const fan = gann.gannFan({ price: 2680, date: "2024-11-14", direction: "UP", priceUnit: 1 });
 */

"use strict";

const path = require("path");
const fs   = require("fs");

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Gann angle ratios: price-units per time-unit (1 trading day).
 * The 1×1 (45°) is the master angle — price and time in balance.
 * Above 1×1 = strong bull; below = bear.
 */
const GANN_ANGLES = [
  { name: "8×1", ratio: 8,     degrees: 82.5, strength: "extreme bull" },
  { name: "4×1", ratio: 4,     degrees: 75,   strength: "very strong bull" },
  { name: "3×1", ratio: 3,     degrees: 71.25,strength: "strong bull" },
  { name: "2×1", ratio: 2,     degrees: 63.75,strength: "bull" },
  { name: "1×1", ratio: 1,     degrees: 45,   strength: "balanced / master" },
  { name: "1×2", ratio: 0.5,   degrees: 26.25,strength: "bear" },
  { name: "1×3", ratio: 0.333, degrees: 18.75,strength: "strong bear" },
  { name: "1×4", ratio: 0.25,  degrees: 15,   strength: "very strong bear" },
  { name: "1×8", ratio: 0.125, degrees: 7.5,  strength: "extreme bear" },
];

/**
 * Gann time cycle degrees — key turning-point distances.
 * Based on Gann's "Law of Vibration": price vibrates in 360° circles.
 */
const TIME_CYCLE_DEGREES = [45, 90, 120, 144, 180, 225, 270, 315, 360, 480, 540, 720];

/**
 * Gann's Seasonal / Master Time Factor dates.
 * These are the natural calendar pressure points Gann described.
 * Expressed as [month, day] pairs.
 */
const GANN_SEASONAL_DATES = [
  { label: "Spring Equinox",    month: 3,  day: 21 },
  { label: "45° from Spring",   month: 5,  day: 5  },
  { label: "Summer Solstice",   month: 6,  day: 21 },
  { label: "45° from Summer",   month: 8,  day: 7  },
  { label: "Fall Equinox",      month: 9,  day: 22 },
  { label: "45° from Fall",     month: 11, day: 7  },
  { label: "Winter Solstice",   month: 12, day: 22 },
  { label: "45° from Winter",   month: 2,  day: 4  },
];

// NSE/BSE specific market structure dates (budget, expiry rhythms, etc.)
const INDIA_MARKET_PRESSURE_DATES = [
  { label: "Union Budget",        month: 2,  day: 1  },
  { label: "RBI Policy (Apr)",    month: 4,  day: 5  },
  { label: "RBI Policy (Jun)",    month: 6,  day: 7  },
  { label: "RBI Policy (Aug)",    month: 8,  day: 8  },
  { label: "RBI Policy (Oct)",    month: 10, day: 9  },
  { label: "RBI Policy (Dec)",    month: 12, day: 6  },
  { label: "F&O Expiry (last Thu)", isLastThursday: true },
];

// ── Square of Nine ────────────────────────────────────────────────────────────

/**
 * W.D. Gann's Square of Nine.
 *
 * The square is a spiral of numbers starting from 1 at the center.
 * Each number's angle on the spiral determines its "vibration."
 * Numbers on the same spoke (0°, 90°, 180°, 270°) are harmonics.
 *
 * Algorithm:
 *   angle = (sqrt(price) - 1) * 180  (in degrees)
 *   next harmonic = ((sqrt(price) + n*2) ^ 2) where n is integer
 *
 * @param {number} price - current LTP
 * @param {number} [levels=8] - how many support/resistance levels to return
 * @returns {object} { angle, cardinal, diagonals, supports, resistances, vibrations }
 */
function squareOfNine(price, levels = 8) {
  if (!price || price <= 0) return null;

  const sqrtPrice = Math.sqrt(price);

  // Angle of price on the square (0–360)
  const rawAngle = ((sqrtPrice - Math.floor(sqrtPrice)) * 360) % 360;

  // Cardinal angles: 0°, 90°, 180°, 270° (strongest S/R)
  // Diagonal angles: 45°, 135°, 225°, 315° (secondary S/R)
  const cardinalAngles   = [0, 90, 180, 270];
  const diagonalAngles   = [45, 135, 225, 315];

  // Generate vibration levels up and down the spiral
  const allLevels = [];

  for (let step = -levels; step <= levels; step++) {
    if (step === 0) continue;
    // Move step half-rotations (180° = one "ring" out on the spiral)
    const newSqrt = sqrtPrice + step * (180 / 360) * 2;
    if (newSqrt > 0) {
      const newPrice = Math.pow(newSqrt, 2);
      if (newPrice > 0) {
        allLevels.push({
          price: Math.round(newPrice * 100) / 100,
          direction: step > 0 ? "resistance" : "support",
          steps: Math.abs(step),
          angle: (rawAngle + step * 180) % 360,
        });
      }
    }
  }

  // Cardinal cross levels (strongest) — 90° rotations
  const cardinalLevels = [];
  for (let n = -4; n <= 4; n++) {
    if (n === 0) continue;
    const targetAngle = (rawAngle + n * 90) % 360;
    const targetSqrt  = sqrtPrice + n * (90 / 360) * 2;
    if (targetSqrt > 0) {
      cardinalLevels.push({
        price:    Math.round(Math.pow(targetSqrt, 2) * 100) / 100,
        angle:    Math.round(targetAngle * 10) / 10,
        cardinalOffset: n * 90,
        strength: "cardinal",
      });
    }
  }

  // 45° (octagon) levels — secondary
  const octagonLevels = [];
  for (let n = -4; n <= 4; n++) {
    if (n === 0) continue;
    const targetSqrt = sqrtPrice + n * (45 / 360) * 2;
    if (targetSqrt > 0) {
      octagonLevels.push({
        price:    Math.round(Math.pow(targetSqrt, 2) * 100) / 100,
        angle:    Math.round(((rawAngle + n * 45) % 360) * 10) / 10,
        strength: "octagon",
      });
    }
  }

  const supports    = [...cardinalLevels, ...octagonLevels]
    .filter(l => l.price < price)
    .sort((a, b) => b.price - a.price)
    .slice(0, 6);

  const resistances = [...cardinalLevels, ...octagonLevels]
    .filter(l => l.price > price)
    .sort((a, b) => a.price - b.price)
    .slice(0, 6);

  // Nearest cardinal above and below
  const nearestSupport    = supports[0]    || null;
  const nearestResistance = resistances[0] || null;

  // Price position analysis
  const positionOnSquare = analyzeSquarePosition(rawAngle);

  return {
    price,
    sqrtPrice:    Math.round(sqrtPrice * 10000) / 10000,
    angleOnSquare: Math.round(rawAngle * 10) / 10,
    positionOnSquare,
    supports,
    resistances,
    nearestSupport,
    nearestResistance,
    cardinalLevels: cardinalLevels.filter(l => Math.abs(l.cardinalOffset) <= 180),
    octagonLevels:  octagonLevels.filter((_,i) => i < 8),
    // Key insight
    priceVibration: getPriceVibration(rawAngle),
  };
}

function analyzeSquarePosition(angle) {
  if (angle < 10 || angle > 350)        return { zone: "cardinal_0",   label: "At 0° cardinal — key pivot zone",       strength: "EXTREME" };
  if (angle >= 80  && angle <= 100)     return { zone: "cardinal_90",  label: "At 90° cardinal — strong S/R",          strength: "STRONG"  };
  if (angle >= 170 && angle <= 190)     return { zone: "cardinal_180", label: "At 180° cardinal — major reversal zone", strength: "EXTREME" };
  if (angle >= 260 && angle <= 280)     return { zone: "cardinal_270", label: "At 270° cardinal — strong S/R",          strength: "STRONG"  };
  if (angle >= 40  && angle <= 50)      return { zone: "diagonal_45",  label: "At 45° diagonal — secondary S/R",       strength: "MODERATE" };
  if (angle >= 130 && angle <= 140)     return { zone: "diagonal_135", label: "At 135° diagonal",                      strength: "MODERATE" };
  if (angle >= 220 && angle <= 230)     return { zone: "diagonal_225", label: "At 225° diagonal",                      strength: "MODERATE" };
  if (angle >= 310 && angle <= 320)     return { zone: "diagonal_315", label: "At 315° diagonal",                      strength: "MODERATE" };
  return { zone: "between",             label: `${Math.round(angle)}° — between key vibration levels`,                 strength: "LOW"     };
}

function getPriceVibration(angle) {
  // Gann's Law of Vibration — numbers on same spoke vibrate together
  const spoke = Math.round(angle / 45) * 45 % 360;
  const labels = {
    0:   "Earth/Cardinal North — strongest resistance/support zone",
    45:  "NE diagonal — 1st harmonic from cardinal",
    90:  "East cardinal — 90° from start",
    135: "SE diagonal — constructive zone",
    180: "South cardinal — 180° opposition (major reversal)",
    225: "SW diagonal — destructive zone",
    270: "West cardinal — 270° (three-quarter cycle)",
    315: "NW diagonal — approaching completion",
  };
  return labels[spoke] || `${spoke}° vibration`;
}

// ── Gann Fan / Angles ─────────────────────────────────────────────────────────

/**
 * Compute Gann Fan lines projected from a confirmed swing point.
 *
 * Each angle gives a price level at today's date.
 * Price ABOVE 1×1 = bullish trend intact.
 * Price BELOW 1×1 = trend broken, next support is 2×1 etc.
 *
 * @param {object} params
 *   pivot       - { price, date }  swing high or low (confirmed reversal)
 *   direction   - "UP" | "DOWN"    fan direction
 *   priceUnit   - price unit per time unit (auto-calculated if not given)
 *   today       - Date (default: now)
 * @returns {object} { angles[], currentPosition, trend, key1x1Price }
 */
function gannFan({ pivot, direction = "UP", priceUnit = null, today = new Date() }) {
  if (!pivot?.price || !pivot?.date) return null;

  const pivotDate = new Date(pivot.date);
  const tradingDays = countTradingDays(pivotDate, today);

  // Auto-calculate price unit if not provided
  // Gann's rule: take the range (H-L) and divide by trading days in the move
  // For NSE large-caps: typically 1-5 rupees per day
  const pu = priceUnit || Math.max(0.5, Math.round(pivot.price / 500));

  const angles = GANN_ANGLES.map(a => {
    // For UP fan from swing low: price increases by ratio×pu per day
    // For DOWN fan from swing high: price decreases by ratio×pu per day
    const priceMove = a.ratio * pu * tradingDays;
    const currentAnglePrice = direction === "UP"
      ? pivot.price + priceMove
      : pivot.price - priceMove;

    return {
      name:             a.name,
      degrees:          a.degrees,
      strength:         a.strength,
      ratio:            a.ratio,
      priceUnit:        pu,
      currentPrice:     Math.round(currentAnglePrice * 100) / 100,
      // Future projections (next 30 trading days)
      projections:      projectAngle(pivot, direction, a.ratio, pu, tradingDays),
    };
  });

  // Find where LTP sits between angles
  // (caller passes ltp separately; here we return the angle array)
  const masterAngle = angles.find(a => a.name === "1×1");

  return {
    pivot,
    direction,
    tradingDays,
    priceUnit: pu,
    angles,
    masterAngle1x1: masterAngle?.currentPrice || null,
    // The 1×1 is the most important — market above = bull, below = bear
    summary: `Gann Fan from ${direction === "UP" ? "swing low" : "swing high"} ₹${pivot.price} on ${pivot.date} (${tradingDays} trading days ago)`,
  };
}

function projectAngle(pivot, direction, ratio, priceUnit, currentDays) {
  const projections = [];
  for (let d = currentDays; d <= currentDays + 30; d += 5) {
    const move  = ratio * priceUnit * d;
    const price = direction === "UP"
      ? pivot.price + move
      : pivot.price - move;
    projections.push({
      tradingDaysFromPivot: d,
      price: Math.round(price * 100) / 100,
    });
  }
  return projections;
}

/**
 * Given LTP and a Gann Fan, determine which angle the price is sitting on/between.
 */
function classifyPriceOnFan(ltp, fanResult, direction = "UP") {
  if (!fanResult?.angles) return null;

  const angles = [...fanResult.angles].sort((a, b) =>
    direction === "UP"
      ? a.currentPrice - b.currentPrice   // ascending for UP fan
      : b.currentPrice - a.currentPrice   // descending for DOWN fan
  );

  let below = null, above = null;

  for (const angle of angles) {
    if (angle.currentPrice <= ltp) below = angle;
    else { above = angle; break; }
  }

  const master = angles.find(a => a.name === "1×1");
  const aboveMaster = master ? ltp >= master.currentPrice : null;

  let trendStrength;
  if (below?.name === "4×1" || below?.name === "8×1") trendStrength = "EXTREMELY STRONG BULL";
  else if (below?.name === "2×1")                      trendStrength = "STRONG BULL";
  else if (below?.name === "1×1")                      trendStrength = "BULL — master angle holding";
  else if (below?.name === "1×2")                      trendStrength = "WEAK — below master angle";
  else if (below?.name === "1×4" || !below)            trendStrength = "BEAR — critical angles broken";
  else trendStrength = "NEUTRAL";

  return {
    ltp,
    supportingAngle:  below,
    nextAngle:        above,
    aboveMasterAngle: aboveMaster,
    trendStrength,
    criticalLevel:    master?.currentPrice,
    alert: below && above
      ? `Price between ${below.name} (₹${below.currentPrice}) and ${above.name} (₹${above.currentPrice})`
      : null,
  };
}

// ── Time Cycles ───────────────────────────────────────────────────────────────

/**
 * Calculate Gann time cycle dates from a key anchor date.
 *
 * Gann's principle: time controls price. A major high or low will often
 * see a reversal or acceleration at 90, 180, 360 calendar days later.
 *
 * Also checks: anniversary of the date (360° = 1 year),
 * and multiples (2 years, 3 years = "master cycle").
 *
 * @param {object} params
 *   anchorDate   - key date (IPO, all-time high, all-time low, last major pivot)
 *   label        - what this date represents
 *   today        - Date
 * @returns {Array} sorted list of cycle dates with proximity alerts
 */
function timeCycles({ anchorDate, label = "pivot", today = new Date() }) {
  if (!anchorDate) return [];

  const anchor = new Date(anchorDate);
  const cycles = [];

  // Primary degree cycles (calendar days)
  const degreeToDays = (deg) => Math.round((deg / 360) * 365.25);

  for (const deg of TIME_CYCLE_DEGREES) {
    const days      = degreeToDays(deg);
    const cycleDate = new Date(anchor);
    cycleDate.setDate(cycleDate.getDate() + days);

    // Also check yearly multiples for important degrees
    const yearsAhead = [1, 2, 3, 5, 7, 10];
    for (const yr of yearsAhead) {
      const multiDate = new Date(anchor);
      multiDate.setDate(multiDate.getDate() + days * yr);

      const daysFromToday = Math.round((multiDate - today) / (1000 * 60 * 60 * 24));
      const absDistance   = Math.abs(daysFromToday);

      // Only care about cycles within ±30 days
      if (absDistance <= 30) {
        cycles.push({
          degree:        deg * yr,
          label:         `${deg}° × ${yr} year${yr > 1 ? "s" : ""} from ${label}`,
          date:          multiDate.toISOString().split("T")[0],
          daysFromToday,
          proximity:     absDistance <= 3  ? "IMMINENT"  :
                         absDistance <= 7  ? "THIS_WEEK" :
                         absDistance <= 14 ? "THIS_FORTNIGHT" : "THIS_MONTH",
          cycleStrength: deg === 360 || deg === 180 ? "MAJOR"
                       : deg === 90  || deg === 270 ? "SIGNIFICANT"
                       : "MINOR",
          past:          daysFromToday < 0,
        });
      }
    }
  }

  // Anniversary dates (multiples of 365 days) — Gann considered these extremely important
  for (let yr = 1; yr <= 20; yr++) {
    const annivDate = new Date(anchor);
    annivDate.setFullYear(annivDate.getFullYear() + yr);
    const daysFromToday = Math.round((annivDate - today) / (1000 * 60 * 60 * 24));

    if (Math.abs(daysFromToday) <= 30) {
      cycles.push({
        degree:        360 * yr,
        label:         `${yr}-year anniversary of ${label}`,
        date:          annivDate.toISOString().split("T")[0],
        daysFromToday,
        proximity:     Math.abs(daysFromToday) <= 3 ? "IMMINENT" : "NEARBY",
        cycleStrength: yr % 5 === 0 ? "EXTREME" : yr % 3 === 0 ? "MAJOR" : "SIGNIFICANT",
        past:          daysFromToday < 0,
        isAnniversary: true,
      });
    }
  }

  return cycles.sort((a, b) => a.daysFromToday - b.daysFromToday);
}

/**
 * Check if today is near a Gann seasonal pressure date.
 * Returns any seasonal events within the next 21 days.
 */
function seasonalPressureDates(today = new Date()) {
  const year = today.getFullYear();
  const alerts = [];

  for (const sd of [...GANN_SEASONAL_DATES, ...INDIA_MARKET_PRESSURE_DATES]) {
    if (sd.isLastThursday) {
      // Last Thursday of current month
      const lastThu = getLastThursdayOfMonth(today.getFullYear(), today.getMonth());
      const daysAway = Math.round((lastThu - today) / (1000 * 60 * 60 * 24));
      if (daysAway >= -2 && daysAway <= 7) {
        alerts.push({
          label:     sd.label,
          date:      lastThu.toISOString().split("T")[0],
          daysAway,
          type:      "india_market",
        });
      }
      continue;
    }

    const sdDate = new Date(year, sd.month - 1, sd.day);
    const daysAway = Math.round((sdDate - today) / (1000 * 60 * 60 * 24));

    if (daysAway >= -3 && daysAway <= 21) {
      alerts.push({
        label:   sd.label,
        date:    sdDate.toISOString().split("T")[0],
        daysAway,
        type:    GANN_SEASONAL_DATES.includes(sd) ? "gann_seasonal" : "india_market",
      });
    }
  }

  return alerts.sort((a, b) => a.daysAway - b.daysAway);
}

// ── Cardinal Cross ────────────────────────────────────────────────────────────

/**
 * Gann Cardinal Cross: price levels at 0°, 90°, 180°, 270° on Square of Nine
 * These form the most powerful horizontal support/resistance grid.
 *
 * In practice: find the "root" of the current price on the Square,
 * then project outward on all four cardinal spokes.
 */
function cardinalCross(price, range = 6) {
  const sqrtP  = Math.sqrt(price);
  const levels = { north: [], south: [], east: [], west: [] };

  // Cardinal spokes: move in increments of 2 (one full ring of the square)
  for (let n = 1; n <= range; n++) {
    levels.north.push(Math.round(Math.pow(sqrtP + n * 2,     2) * 100) / 100);  // 0°
    levels.east.push (Math.round(Math.pow(sqrtP + n * 2 + 0.5, 2) * 100) / 100); // 90°
    levels.south.push(Math.round(Math.pow(sqrtP + n * 2 + 1,   2) * 100) / 100); // 180°
    levels.west.push (Math.round(Math.pow(sqrtP + n * 2 + 1.5, 2) * 100) / 100); // 270°
  }

  // Merge and sort
  const allResistance = [...levels.north, ...levels.east, ...levels.south, ...levels.west]
    .filter(l => l > price)
    .sort((a, b) => a - b)
    .slice(0, 8);

  const allSupport = [
    ...Array.from({length: range}, (_, n) => Math.round(Math.pow(Math.max(0.1, sqrtP - (n+1)*2),     2) * 100) / 100),
    ...Array.from({length: range}, (_, n) => Math.round(Math.pow(Math.max(0.1, sqrtP - (n+1)*2 - 0.5), 2) * 100) / 100),
    ...Array.from({length: range}, (_, n) => Math.round(Math.pow(Math.max(0.1, sqrtP - (n+1)*2 - 1),   2) * 100) / 100),
    ...Array.from({length: range}, (_, n) => Math.round(Math.pow(Math.max(0.1, sqrtP - (n+1)*2 - 1.5), 2) * 100) / 100),
  ]
    .filter(l => l > 0 && l < price)
    .sort((a, b) => b - a)
    .slice(0, 8);

  return {
    price,
    resistanceLevels: allResistance,
    supportLevels:    allSupport,
    nearestResistance: allResistance[0] || null,
    nearestSupport:    allSupport[0]    || null,
    // Zone proximity check
    inCardinalZone:    isNearCardinal(price),
  };
}

function isNearCardinal(price) {
  const sqrtP = Math.sqrt(price);
  const frac  = sqrtP % 1;  // fractional part
  // Near 0, 0.5, 1.0 fractions = near cardinal spoke
  const dist  = Math.min(frac, 1 - frac, Math.abs(frac - 0.5));
  return {
    isNear:   dist < 0.05,
    distance: Math.round(dist * 1000) / 1000,
    strength: dist < 0.02 ? "ON_CARDINAL" : dist < 0.05 ? "NEAR_CARDINAL" : "BETWEEN",
  };
}

// ── Full Analysis Fusion ──────────────────────────────────────────────────────

/**
 * Master function: run all Gann modules and fuse into a single analysis doc.
 *
 * @param {object} params
 *   symbol       - NSE/BSE ticker
 *   ltp          - last traded price
 *   high52w      - 52-week high
 *   low52w       - 52-week low
 *   swingHigh    - { price, date } most recent confirmed swing high
 *   swingLow     - { price, date } most recent confirmed swing low
 *   ipoDate      - IPO/listing date (string) — for long-term time cycles
 *   allTimeHigh  - { price, date } — for time cycle from ATH
 *   allTimeLow   - { price, date } — for time cycle from ATL
 *   priceUnit    - Gann price unit (default auto)
 *   today        - Date (default: now)
 */
function analyzeGann(params) {
  const {
    symbol,
    ltp,
    high52w,
    low52w,
    swingHigh,
    swingLow,
    ipoDate,
    allTimeHigh,
    allTimeLow,
    priceUnit = null,
    today = new Date(),
  } = params;

  if (!ltp || ltp <= 0) return { error: "Invalid LTP", symbol };

  // ── 1. Square of Nine ──────────────────────────────────────────────────────
  const son = squareOfNine(ltp, 8);

  // Also run on 52w high and low to find historical vibration zones
  const sonHigh = high52w ? squareOfNine(high52w, 4) : null;
  const sonLow  = low52w  ? squareOfNine(low52w,  4) : null;

  // ── 2. Gann Fan from swing points ─────────────────────────────────────────
  const fanFromLow = swingLow
    ? gannFan({ pivot: swingLow,  direction: "UP",   priceUnit, today })
    : null;

  const fanFromHigh = swingHigh
    ? gannFan({ pivot: swingHigh, direction: "DOWN", priceUnit, today })
    : null;

  const priceOnUpFan   = fanFromLow   ? classifyPriceOnFan(ltp, fanFromLow,  "UP")   : null;
  const priceOnDownFan = fanFromHigh  ? classifyPriceOnFan(ltp, fanFromHigh, "DOWN") : null;

  // ── 3. Time Cycles ─────────────────────────────────────────────────────────
  const allCycles = [];

  if (swingHigh) {
    allCycles.push(...timeCycles({ anchorDate: swingHigh.date, label: "swing high", today }));
  }
  if (swingLow) {
    allCycles.push(...timeCycles({ anchorDate: swingLow.date,  label: "swing low",  today }));
  }
  if (ipoDate) {
    allCycles.push(...timeCycles({ anchorDate: ipoDate,         label: "IPO/listing",today }));
  }
  if (allTimeHigh) {
    allCycles.push(...timeCycles({ anchorDate: allTimeHigh.date,label: "all-time high", today }));
  }
  if (allTimeLow) {
    allCycles.push(...timeCycles({ anchorDate: allTimeLow.date, label: "all-time low",  today }));
  }

  // Deduplicate nearby cycles
  const upcomingCycles = allCycles
    .filter(c => c.daysFromToday >= -2 && c.daysFromToday <= 30)
    .sort((a, b) => a.daysFromToday - b.daysFromToday)
    .slice(0, 10);

  const seasonal = seasonalPressureDates(today);

  // ── 4. Cardinal Cross ─────────────────────────────────────────────────────
  const cardinal = cardinalCross(ltp);

  // ── 5. Gann Signal Fusion ─────────────────────────────────────────────────
  const signal = fuseGannSignals({
    son, priceOnUpFan, priceOnDownFan, upcomingCycles, cardinal, ltp, high52w, low52w,
  });

  // ── 6. Build alerts ────────────────────────────────────────────────────────
  const alerts = buildGannAlerts({
    symbol, ltp, son, priceOnUpFan, priceOnDownFan, upcomingCycles, cardinal, seasonal,
  });

  // ── 7. Key levels summary ─────────────────────────────────────────────────
  const keyLevels = buildKeyLevels({ son, cardinal, fanFromLow, fanFromHigh, priceOnUpFan, ltp });

  return {
    symbol,
    ltp,
    analysisTime: today.toISOString(),

    // Core analysis objects
    squareOfNine:      son,
    gannFanUp:         fanFromLow,
    gannFanDown:       fanFromHigh,
    priceOnUpFan,
    priceOnDownFan,
    cardinalCross:     cardinal,
    timeCycles:        upcomingCycles,
    seasonalAlerts:    seasonal,

    // Synthesis
    signal,       // { bias, score, strength, summary }
    alerts,       // array of actionable alerts
    keyLevels,    // { supports: [], resistances: [], masterAngle: price }

    // For UI display
    headline:     buildHeadline(symbol, ltp, signal, keyLevels, upcomingCycles),
  };
}

// ── Signal Fusion ─────────────────────────────────────────────────────────────

function fuseGannSignals({ son, priceOnUpFan, priceOnDownFan, upcomingCycles, cardinal, ltp, high52w, low52w }) {
  let score = 50; // neutral start
  const factors = [];

  // 1. Square of Nine position
  if (son) {
    const pos = son.positionOnSquare;
    if (pos.strength === "EXTREME" || pos.strength === "STRONG") {
      const nearResistance = son.nearestResistance && ltp >= son.nearestResistance.price * 0.99;
      const nearSupport    = son.nearestSupport    && ltp <= son.nearestSupport.price    * 1.01;

      if (nearSupport)    { score += 10; factors.push("Near Square of Nine support"); }
      if (nearResistance) { score -= 5;  factors.push("Near Square of Nine resistance"); }
    }
  }

  // 2. Gann Fan angle position
  if (priceOnUpFan) {
    if (priceOnUpFan.aboveMasterAngle) {
      score += 15;
      factors.push(`Above 1×1 master angle (₹${priceOnUpFan.criticalLevel}) — bullish trend`);
    } else {
      score -= 15;
      factors.push(`Below 1×1 master angle (₹${priceOnUpFan.criticalLevel}) — bearish warning`);
    }

    const supporting = priceOnUpFan.supportingAngle;
    if (supporting?.name === "4×1" || supporting?.name === "8×1") {
      score += 10;
      factors.push("Riding powerful 4×1 or 8×1 angle");
    } else if (supporting?.name === "1×4" || supporting?.name === "1×8") {
      score -= 10;
      factors.push("On very weak angle — momentum near exhaustion");
    }
  }

  // 3. Upcoming time cycles (within 7 days = high alert)
  const imminent = upcomingCycles.filter(c => Math.abs(c.daysFromToday) <= 7);
  if (imminent.length > 0) {
    const hasMajor = imminent.some(c => c.cycleStrength === "MAJOR" || c.cycleStrength === "EXTREME");
    score += hasMajor ? 0 : 0; // cycles = volatility, not direction
    factors.push(`${imminent.length} time cycle(s) active within 7 days — expect volatility`);
  }

  // 4. Cardinal zone
  if (cardinal?.inCardinalZone?.strength === "ON_CARDINAL") {
    factors.push("Price ON cardinal spoke of Square — key decision point");
  }

  // 5. 52w range position (basic but important in Gann)
  if (high52w && low52w) {
    const range  = high52w - low52w;
    const posInRange = (ltp - low52w) / range;
    if (posInRange > 0.75)     { score += 5;  factors.push("Price in upper quartile of 52w range"); }
    else if (posInRange < 0.25){ score -= 5;  factors.push("Price in lower quartile of 52w range"); }

    // 50% retracement (Gann's "50% rule" — most important retracement)
    const fiftyPct = low52w + range * 0.5;
    if (Math.abs(ltp - fiftyPct) / fiftyPct < 0.01) {
      score += 5;
      factors.push(`At 50% retracement of 52w range (₹${Math.round(fiftyPct)}) — Gann's key level`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const bias     = score >= 60 ? "BULLISH" : score <= 40 ? "BEARISH" : "NEUTRAL";
  const strength = score >= 80 ? "STRONG"  : score >= 60 ? "MODERATE" : score >= 40 ? "WEAK" : "STRONG"; // STRONG bear if < 40

  return {
    bias,
    score,
    strength: bias === "BEARISH" && score <= 30 ? "STRONG" : strength,
    factors,
    summary: `Gann: ${bias} (score ${score}/100). ${factors[0] || "No strong Gann signals."}`,
  };
}

// ── Alert Builder ─────────────────────────────────────────────────────────────

function buildGannAlerts({ symbol, ltp, son, priceOnUpFan, priceOnDownFan, upcomingCycles, cardinal, seasonal }) {
  const alerts = [];

  // Time cycle alerts
  for (const c of upcomingCycles.filter(c => c.daysFromToday >= 0 && c.daysFromToday <= 14)) {
    alerts.push({
      type:     "TIME_CYCLE",
      priority: c.cycleStrength === "EXTREME" ? "HIGH" : c.cycleStrength === "MAJOR" ? "MEDIUM" : "LOW",
      message:  `⏰ ${c.label} — ${c.daysFromToday === 0 ? "TODAY" : `in ${c.daysFromToday} days`} (${c.date})`,
      detail:   `${c.cycleStrength} cycle — watch for reversal or acceleration`,
    });
  }

  // Seasonal alerts
  for (const s of seasonal.filter(s => s.daysAway >= 0 && s.daysAway <= 7)) {
    alerts.push({
      type:     "SEASONAL",
      priority: "MEDIUM",
      message:  `📅 ${s.label} in ${s.daysAway} days (${s.date})`,
      detail:   "Gann seasonal pressure date — market-wide volatility expected",
    });
  }

  // Angle alerts
  if (priceOnUpFan) {
    const master = priceOnUpFan.criticalLevel;
    if (master) {
      const pctFromMaster = Math.abs(ltp - master) / master * 100;
      if (pctFromMaster < 1) {
        alerts.push({
          type:     "GANN_ANGLE",
          priority: "HIGH",
          message:  `⚡ Price within 1% of 1×1 master angle at ₹${Math.round(master)}`,
          detail:   `This is the most important Gann level. Break ${ltp > master ? "above" : "below"} = trend ${ltp > master ? "confirmed" : "reversal"}`,
        });
      }
    }
  }

  // Square of Nine alerts
  if (son?.nearestSupport) {
    const pctFromSupport = (ltp - son.nearestSupport.price) / ltp * 100;
    if (pctFromSupport < 1.5) {
      alerts.push({
        type:     "SQUARE_OF_NINE",
        priority: son.nearestSupport.strength === "cardinal" ? "HIGH" : "MEDIUM",
        message:  `🔢 Near Square of Nine ${son.nearestSupport.strength} support at ₹${son.nearestSupport.price}`,
        detail:   `${son.nearestSupport.angle}° on the square — ${son.nearestSupport.strength === "cardinal" ? "strongest level" : "secondary level"}`,
      });
    }
  }

  if (son?.nearestResistance) {
    const pctFromRes = (son.nearestResistance.price - ltp) / ltp * 100;
    if (pctFromRes < 1.5) {
      alerts.push({
        type:     "SQUARE_OF_NINE",
        priority: son.nearestResistance.strength === "cardinal" ? "HIGH" : "MEDIUM",
        message:  `🔢 Near Square of Nine ${son.nearestResistance.strength} resistance at ₹${son.nearestResistance.price}`,
        detail:   `${son.nearestResistance.angle}° on the square`,
      });
    }
  }

  // Cardinal zone
  if (cardinal?.inCardinalZone?.strength === "ON_CARDINAL") {
    alerts.push({
      type:     "CARDINAL_CROSS",
      priority: "HIGH",
      message:  `🎯 Price on Cardinal Cross spoke — KEY decision level`,
      detail:   "These are the strongest S/R zones in Gann theory. Expect decisive move.",
    });
  }

  return alerts.sort((a, b) => {
    const pri = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return pri[a.priority] - pri[b.priority];
  });
}

// ── Key Levels ────────────────────────────────────────────────────────────────

function buildKeyLevels({ son, cardinal, fanFromLow, priceOnUpFan, ltp }) {
  const supports    = new Map();
  const resistances = new Map();

  // From Square of Nine (cardinal levels are strongest)
  if (son?.supports) {
    son.supports.slice(0, 3).forEach(s => {
      supports.set(s.price, { price: s.price, source: "Square of Nine", strength: s.strength, angle: s.angle });
    });
  }
  if (son?.resistances) {
    son.resistances.slice(0, 3).forEach(r => {
      resistances.set(r.price, { price: r.price, source: "Square of Nine", strength: r.strength, angle: r.angle });
    });
  }

  // From Cardinal Cross
  if (cardinal?.supportLevels) {
    cardinal.supportLevels.slice(0, 2).forEach(p => {
      if (!supports.has(p)) {
        supports.set(p, { price: p, source: "Cardinal Cross", strength: "cardinal" });
      }
    });
  }
  if (cardinal?.resistanceLevels) {
    cardinal.resistanceLevels.slice(0, 2).forEach(p => {
      if (!resistances.has(p)) {
        resistances.set(p, { price: p, source: "Cardinal Cross", strength: "cardinal" });
      }
    });
  }

  // Master 1×1 angle level
  const masterAnglePrice = priceOnUpFan?.criticalLevel;
  if (masterAnglePrice) {
    const key = Math.round(masterAnglePrice);
    if (masterAnglePrice < ltp) {
      supports.set(key, { price: masterAnglePrice, source: "Gann 1×1 master angle", strength: "MASTER" });
    } else {
      resistances.set(key, { price: masterAnglePrice, source: "Gann 1×1 master angle", strength: "MASTER" });
    }
  }

  return {
    supports:    [...supports.values()].sort((a, b) => b.price - a.price).slice(0, 6),
    resistances: [...resistances.values()].sort((a, b) => a.price - b.price).slice(0, 6),
    masterAngle: masterAnglePrice,
  };
}

// ── Headline Builder ──────────────────────────────────────────────────────────

function buildHeadline(symbol, ltp, signal, keyLevels, cycles) {
  const parts = [];

  parts.push(`${symbol} @ ₹${ltp}`);

  if (signal.bias === "BULLISH") parts.push(`Gann BULLISH`);
  else if (signal.bias === "BEARISH") parts.push(`Gann BEARISH`);
  else parts.push("Gann NEUTRAL");

  if (keyLevels.masterAngle) {
    const rel = ltp > keyLevels.masterAngle ? "above" : "below";
    parts.push(`${rel} 1×1 master angle (₹${Math.round(keyLevels.masterAngle)})`);
  }

  const imminent = cycles.filter(c => c.daysFromToday >= 0 && c.daysFromToday <= 5);
  if (imminent.length > 0) {
    parts.push(`${imminent[0].cycleStrength} time cycle in ${imminent[0].daysFromToday}d`);
  }

  if (keyLevels.supports[0])    parts.push(`S1: ₹${Math.round(keyLevels.supports[0].price)}`);
  if (keyLevels.resistances[0]) parts.push(`R1: ₹${Math.round(keyLevels.resistances[0].price)}`);

  return parts.join(" · ");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count approximate trading days between two dates.
 * Excludes weekends; does NOT exclude Indian holidays (add that for prod).
 */
function countTradingDays(start, end) {
  let count = 0;
  const cur = new Date(start);
  while (cur < end) {
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return Math.max(1, count);
}

function getLastThursdayOfMonth(year, month) {
  const lastDay = new Date(year, month + 1, 0);
  const dayOfWeek = lastDay.getDay();
  const offset = (dayOfWeek >= 4) ? dayOfWeek - 4 : dayOfWeek + 3;
  lastDay.setDate(lastDay.getDate() - offset);
  return lastDay;
}

// ── Module exports ────────────────────────────────────────────────────────────

module.exports = {
  // Core functions
  analyzeGann,           // Full analysis (use this in coordinator.js)
  squareOfNine,          // Square of Nine levels for a price
  gannFan,               // Gann Fan angles from a swing pivot
  classifyPriceOnFan,    // Where is LTP on the fan?
  timeCycles,            // Time cycle dates from an anchor
  seasonalPressureDates, // Upcoming seasonal events
  cardinalCross,         // Cardinal Cross S/R grid

  // Constants (useful for UI rendering)
  GANN_ANGLES,
  TIME_CYCLE_DEGREES,
  GANN_SEASONAL_DATES,
};