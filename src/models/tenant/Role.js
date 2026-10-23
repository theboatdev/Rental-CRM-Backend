const { Schema } = require('mongoose');
const { ROLE_KEY_PATTERN } = require('../../platform/rbac/permissions');

/**
 * System roles (seeded by initTenantDb) and the tenant's custom roles. Unknown
 * permission strings are tolerated here and dropped by effectivePermissions,
 * so a permission removed in a later release doesn't make old roles unsavable.
 */
const roleSchema = new Schema(
  {
    key: { type: String, required: true, match: ROLE_KEY_PATTERN },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false }
  },
  { collection: 'roles', timestamps: true }
);

roleSchema.index({ key: 1 }, { unique: true });

module.exports = roleSchema;
