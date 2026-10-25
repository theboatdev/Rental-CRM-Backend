const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { connectPlatformDb, waitForConnection, isConnected } = require('../src/db/platform');

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

describe('platform database connection', () => {
  it('keeps retrying the first connection until the database is reachable', async () => {
    const port = await freePort();
    const uri = `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=300`;
    const connection = connectPlatformDb({ uri, dbName: 'platform' });
    const retries = [];
    const waiting = waitForConnection(connection, { uri, dbName: 'platform', retryMs: 200, onRetry: (error, attempt) => retries.push(attempt) });

    // Nothing listens yet, like Atlas refusing an IP that isn't on its access list.
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(isConnected(connection), false);
    const server = await MongoMemoryServer.create({ instance: { port } });
    try {
      await waiting;
      assert.equal(isConnected(connection), true);
      assert.equal(connection.name, 'platform');
      assert.ok(retries.length >= 1);
    } finally {
      await connection.close();
      await server.stop();
    }
  });
});
