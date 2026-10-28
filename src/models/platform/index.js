/**
 * Platform (control plane) models. Like the tenant models, each file exports a
 * schema; `connectPlatformDb` registers them on the platform connection only.
 */
const PLATFORM_SCHEMAS = {
  Tenant: require('./Tenant'),
  TenantConfig: require('./TenantConfig'),
  ProvisioningJob: require('./ProvisioningJob'),
  TenantSecret: require('./TenantSecret'),
  DigestRun: require('./DigestRun'),
  AuditLog: require('./AuditLog')
};

const PLATFORM_MODEL_NAMES = Object.keys(PLATFORM_SCHEMAS);

function registerPlatformModels(connection) {
  for (const [name, schema] of Object.entries(PLATFORM_SCHEMAS)) connection.model(name, schema);
}

module.exports = { PLATFORM_SCHEMAS, PLATFORM_MODEL_NAMES, registerPlatformModels };
