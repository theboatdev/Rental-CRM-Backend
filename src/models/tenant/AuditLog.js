const { Schema } = require('mongoose');
const actorSchema = require('../actor');

/** Append-only record of what members did in this tenant. */
const auditLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: actorSchema, required: true },
    action: { type: String, required: true }, // e.g. "rental.returned"
    entityType: { type: String }, // e.g. "rental"
    entityId: { type: String },
    summary: { type: String }
  },
  { collection: 'audit_logs', versionKey: false }
);

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1, at: -1 });

module.exports = auditLogSchema;
