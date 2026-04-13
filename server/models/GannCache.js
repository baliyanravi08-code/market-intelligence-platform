"use strict";

/**
 * GannCache.js
 * server/models/GannCache.js
 *
 * FIX: removed duplicate index on symbol — was declared both via
 * "unique: true" in the schema field (which auto-creates an index)
 * AND via GannCacheSchema.index({ symbol: 1 }) below.
 * Mongoose 7+ throws a warning and may create two indexes.
 * Fix: removed the redundant schema.index({ symbol: 1 }) call.
 * The unique: true on the field is sufficient.
 */

const mongoose = require("mongoose");

const GannCacheSchema = new mongoose.Schema(
  {
    symbol:     { type: String, required: true, unique: true, uppercase: true, trim: true },
    analysis:   { type: mongoose.Schema.Types.Mixed, required: true },
    computedAt: { type: Date,   required: true },
    ltp:        { type: Number, default: null },
    bias:       { type: String, default: null },
    score:      { type: Number, default: null },
  },
  {
    timestamps: true,
    collection: "gann_cache",
  }
);

// Only ONE index on symbol — the unique:true above already creates it.
// FIX: removed duplicate GannCacheSchema.index({ symbol: 1 }) that was here.
GannCacheSchema.index({ updatedAt: -1 });

module.exports = mongoose.model("GannCache", GannCacheSchema);