const { Schema } = require('mongoose');
const actorSchema = require('../actor');
const { TENANT_STATUSES, tenantDbName } = require('../../platform/tenants/rules');
const { CONFIG_TEMPLATE_KEYS } = require('../../platform/config/templates');

const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    status: { type: String, enum: TENANT_STATUSES, default: 'provisioning' },
    template: { type: String, enum: CONFIG_TEMPLATE_KEYS, required: true },
    adminEmail: { type: String, required: true, trim: true, lowercase: true },
    adminName: { type: String, default: null },
    clerkOrgId: { type: String }, // set by the create_clerk_org provisioning step
    dbName: { type: String, required: true },
    activeConfigVersion: { type: Number, default: null },
    currency: { type: String }, // copied from the active config, for tenant lists
    limits: {
      maxVehicles: { type: Number, required: true },
      maxUsers: { type: Number, required: true },
      storageGb: { type: Number, required: true }
    },
    usage: {
      vehicles: { type: Number, default: 0 },
      members: { type: Number, default: 0 },
      storageGb: { type: Number, default: 0 }
    },
    createdBy: { type: actorSchema }
  },
  { collection: 'tenants', timestamps: true }
);

// The DB name comes from the immutable id, never the renamable slug.
tenantSchema.pre('validate', function setDbName() {
  this.dbName ??= tenantDbName(this.id);
});

tenantSchema.index({ slug: 1 }, { unique: true });
tenantSchema.index({ clerkOrgId: 1 }, { unique: true, partialFilterExpression: { clerkOrgId: { $type: 'string' } } });

module.exports = tenantSchema;
