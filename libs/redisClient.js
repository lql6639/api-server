const Redis = require('ioredis');

let client = null;
let initialized = false;

function init(config) {
  if (initialized) return client;

  client = new Redis({
    host: config.host,
    port: config.port,
    password: process.env.REDIS_PASSWORD || config.password,
    db: Number(config.db) || 0,
    lazyConnect: true,
    retryStrategy: (times) => {
      if (times > 3) return null;
      return Math.min(times * 200, 2000);
    }
  });

  client.on('error', (err) => {
    require('../utils/logger').error('Redis 连接异常', { error: err.message });
  });

  initialized = true;
  return client;
}

async function connect() {
  if (!client) throw new Error('Redis 未初始化');
  await client.connect();
  return client;
}

function getClient() {
  return client;
}

async function destroy() {
  if (client) {
    try {
      await client.quit().catch(() => {});
    } catch { /* */ }
    try { client.disconnect(); } catch { /* */ }
    client = null;
    initialized = false;
  }
}

function isConnected() {
  return client && client.status === 'ready';
}

module.exports = { init, connect, getClient, destroy, isConnected };
