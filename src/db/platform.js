const mongoose = require('mongoose');
const { registerPlatformModels } = require('../models/platform');

/**
 * Opens the platform (control plane) database and registers the platform
 * models on it. Tenant databases share this connection's pool through
 * `useDb` (see tenantDb.js). Nothing uses mongoose's global connection, so a
 * model is only reachable through the connection it was registered on.
 *
 * Indexes are never built implicitly (`autoIndex: false`, inherited by tenant
 * DBs): the platform's with `syncPlatformIndexes`, each tenant's at
 * provisioning with `initTenantDb`.
 *
 * Returns at once while the connection opens in the background; await
 * `connection.asPromise()` to wait for it.
 */
function connectPlatformDb({ uri, dbName = 'platform' }) {
  const connection = mongoose.createConnection(uri, { dbName, autoIndex: false, autoCreate: false });
  registerPlatformModels(connection);
  return connection;
}

const syncPlatformIndexes = (connection) =>
  Promise.all(Object.values(connection.models).map((model) => model.syncIndexes()));

const isConnected = (connection) => connection?.readyState === mongoose.ConnectionStates.connected;

module.exports = { connectPlatformDb, syncPlatformIndexes, isConnected };
