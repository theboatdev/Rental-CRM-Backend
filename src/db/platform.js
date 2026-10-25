const mongoose = require('mongoose');
const { registerPlatformModels } = require('../models/platform');

// Indexes are never built implicitly; these options are inherited by tenant DBs.
const connectionOptions = (dbName) => ({ dbName, autoIndex: false, autoCreate: false });

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
 * `connection.asPromise()` (or `waitForConnection`) to wait for it.
 */
function connectPlatformDb({ uri, dbName = 'platform' }) {
  const connection = mongoose.createConnection(uri, connectionOptions(dbName));
  registerPlatformModels(connection);
  return connection;
}

/**
 * Waits until the connection is open, retrying every `retryMs` while it can't
 * be, e.g. while Atlas refuses an IP that isn't on its access list yet. The
 * driver only retries on its own after a first successful connection.
 */
async function waitForConnection(connection, { uri, dbName = 'platform', retryMs = 15_000, onRetry = () => {} }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (attempt === 1) await connection.asPromise();
      else await connection.openUri(uri, connectionOptions(dbName));
      return connection;
    } catch (error) {
      onRetry(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

const syncPlatformIndexes = (connection) =>
  Promise.all(Object.values(connection.models).map((model) => model.syncIndexes()));

const isConnected = (connection) => connection?.readyState === mongoose.ConnectionStates.connected;

module.exports = { connectPlatformDb, waitForConnection, syncPlatformIndexes, isConnected };
