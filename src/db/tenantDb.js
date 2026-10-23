const { registerTenantModels } = require('../models/tenant');
const { isTenantDbName } = require('../platform/tenants/rules');
const { SYSTEM_ROLES } = require('../platform/rbac/permissions');

/**
 * Returns `getTenantDb(dbName)`: the tenant's database on the platform
 * connection's pool, with the tenant models registered on it. `useCache` hands
 * back the same connection object for the same name, so models are registered
 * once per tenant. This is the only way to reach tenant models.
 */
function createTenantDbGetter(platformConnection) {
  return function getTenantDb(dbName) {
    if (!isTenantDbName(dbName)) throw new Error(`Not a tenant database name: ${dbName}`);
    const db = platformConnection.useDb(dbName, { useCache: true });
    if (!db.models.Member) registerTenantModels(db);
    return db;
  };
}

/**
 * Prepares a tenant database: builds the indexes of every tenant model and
 * upserts the system roles. Counters are created on first use. Idempotent, so
 * provisioning can retry it and a release that changes a system role can re-run it.
 */
async function initTenantDb(db) {
  await Promise.all(Object.values(db.models).map((model) => model.syncIndexes()));
  await db.models.Role.bulkWrite(
    SYSTEM_ROLES.map(({ key, name, description, permissions }) => ({
      updateOne: { filter: { key }, update: { $set: { name, description, permissions, system: true } }, upsert: true }
    }))
  );
}

module.exports = { createTenantDbGetter, initTenantDb };
