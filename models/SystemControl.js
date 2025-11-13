const mongoose = require('mongoose');

const systemControlSchema = new mongoose.Schema({
  allowNewGames: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
}, { versionKey: false });

/**
 * Ensure there is always exactly one row.
 */
systemControlSchema.statics.getSingleton = async function () {
  const existing = await this.findOne({});
  if (existing) return existing;
  return this.create({});
};

module.exports = mongoose.model('SystemControl', systemControlSchema);
