const { Schema } = require('mongoose');

/** Sequences for human-readable codes (RNT-2026-0042, SR-0146), one document per key. */
const counterSchema = new Schema(
  {
    _id: { type: String }, // e.g. "rental:2026"
    seq: { type: Number, default: 0 }
  },
  { collection: 'counters', versionKey: false }
);

/** Atomically takes the next number for `key`, starting at 1. Pass `session` inside a transaction. */
counterSchema.statics.next = async function next(key, { session } = {}) {
  const counter = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session }
  ).lean();
  return counter.seq;
};

module.exports = counterSchema;
