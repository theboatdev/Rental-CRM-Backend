const { Schema } = require('mongoose');
const actorSchema = require('../actor');

/** Append-only record of every super admin action. */
const platformAuditLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: actorSchema, required: true },
    action: { type: String, required: true }, // e.g. "config.published"
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant' },
    tenantName: { type: String }, // kept so entries still read well after a tenant is deleted
    summary: { type: String }
  },
  { collection: 'platform_audit_logs', versionKey: false }
);

platformAuditLogSchema.index({ at: -1 });
platformAuditLogSchema.index({ tenantId: 1, at: -1 });

module.exports = platformAuditLogSchema;
