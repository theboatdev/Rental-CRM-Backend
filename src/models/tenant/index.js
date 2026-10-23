/**
 * Tenant models. Each file exports a schema, never a model: the models are
 * registered per tenant connection by `getTenantDb` (src/db/tenantDb.js), so
 * no tenant model exists on a global or platform connection.
 */
const TENANT_SCHEMAS = {
  Member: require('./Member'),
  Role: require('./Role'),
  Vehicle: require('./Vehicle'),
  Renter: require('./Renter'),
  Rental: require('./Rental'),
  Payment: require('./Payment'),
  VehicleCost: require('./VehicleCost'),
  FuelLog: require('./FuelLog'),
  Counter: require('./Counter'),
  AuditLog: require('./AuditLog')
};

const TENANT_MODEL_NAMES = Object.keys(TENANT_SCHEMAS);

function registerTenantModels(connection) {
  for (const [name, schema] of Object.entries(TENANT_SCHEMAS)) connection.model(name, schema);
}

module.exports = { TENANT_SCHEMAS, TENANT_MODEL_NAMES, registerTenantModels };
