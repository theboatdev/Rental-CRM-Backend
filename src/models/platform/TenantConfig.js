const { Schema } = require('mongoose');
const actorSchema = require('../actor');

/** One immutable document per published config version. */
const tenantConfigSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    version: { type: Number, required: true, min: 1 },
    config: { type: Schema.Types.Mixed, required: true }, // validated by parseTenantConfig before insert
    note: { type: String, required: true },
    createdBy: { type: actorSchema, required: true }
  },
  // minimize: false keeps empty objects in the stored config exactly as published.
  { collection: 'tenant_configs', timestamps: { createdAt: true, updatedAt: false }, minimize: false, versionKey: false }
);

tenantConfigSchema.index({ tenantId: 1, version: -1 }, { unique: true });

module.exports = tenantConfigSchema;
