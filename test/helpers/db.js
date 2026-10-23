const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { connectPlatformDb, syncPlatformIndexes } = require('../../src/db/platform');
const { createTenantDbGetter } = require('../../src/db/tenantDb');

/**
 * An in-memory MongoDB replica set (transactions need one) with the platform
 * connection open and its indexes built, as server.js does at startup.
 */
async function startTestDb() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const platformDb = connectPlatformDb({ uri: replSet.getUri(), dbName: 'platform' });
  await platformDb.asPromise();
  await syncPlatformIndexes(platformDb);
  return {
    platformDb,
    getTenantDb: createTenantDbGetter(platformDb),
    async stop() {
      await platformDb.close();
      await replSet.stop();
    }
  };
}

module.exports = { startTestDb };
