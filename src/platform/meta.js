const { MODULES, MODULE_KEYS } = require('./config/modules');
const { CONFIG_SCHEMA_VERSION, RESIDENT_TYPES, getTenantConfigJsonSchema } = require('./config/schema');
const { CONFIG_TEMPLATES, CONFIG_TEMPLATE_KEYS } = require('./config/templates');
const { BUILT_IN_FIELDS } = require('./config/fields');
const { PERMISSIONS, ALL_PERMISSIONS, SYSTEM_ROLES } = require('./rbac/permissions');
const { TENANT_STATUSES, TENANT_STATUS_TRANSITIONS, PROVISIONING_STEPS } = require('./tenants/rules');

let cached;

/**
 * Everything the admin dashboard (and later the tenant app) needs to know
 * about the config file and permissions, so the backend stays the single
 * source of truth. Static for a given release, so it is built once.
 */
function getPlatformMeta() {
  cached ??= {
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
    configJsonSchema: getTenantConfigJsonSchema(),
    modules: MODULE_KEYS.map((key) => ({ key, ...MODULES[key] })),
    residentTypes: RESIDENT_TYPES,
    builtInFields: BUILT_IN_FIELDS,
    templates: CONFIG_TEMPLATE_KEYS.map((key) => ({ key, ...CONFIG_TEMPLATES[key] })),
    tenantStatuses: TENANT_STATUSES,
    tenantStatusTransitions: TENANT_STATUS_TRANSITIONS,
    provisioningSteps: PROVISIONING_STEPS,
    permissions: ALL_PERMISSIONS.map((key) => ({ key, ...PERMISSIONS[key] })),
    systemRoles: SYSTEM_ROLES
  };
  return cached;
}

module.exports = { getPlatformMeta };
