"use strict";

/**
 * GannCache.js
 * server/models/GannCache.js
 *
 * MongoDB model for persisting Gann analysis so it survives
 * server restarts and Render spin-downs.
 *
 * One document per symbol — upserted on every cache write.
 */

const mongoose = require("mongoose");

const GannCacheSchema = new mongoose.Schema(
  {
    symbol:      { type: String, required: true, unique: true, uppercase: true, trim: true },
    analysis:    { type: mongoose.Schema.Types.Mixed, required: true },
    computedAt:  { type: Date,   required: true },
    ltp:         { type: Number, default: null },
    bias:        { type: String, default: null },
    score:       { type: Number, default: null },
  },
  {
    timestamps: true,   // adds createdAt / updatedAt
    collection: "gann_cache",
  }
);

// Index for fast symbol lookups
GannCacheSchema.index({ symbol: 1 });
GannCacheSchema.index({ updatedAt: -1 });

module.exports = mongoose.model("GannCache", GannCacheSchema);