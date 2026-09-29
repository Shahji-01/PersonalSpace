import { Redis } from 'ioredis';
import { readConfig } from '@personalspace/config';
import { createDatabase } from '@personalspace/db';
import { createApp } from './app';

const config = readConfig(process.env);
const domain = createDatabase(config.DATABASE_URL);
const auth = createDatabase(config.AUTH_DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
redis.on('error', () => {
  /* Readiness reports failure without logging connection credentials. */
});
const app = await createApp({
  config,
  db: domain.db,
  authDb: auth.db,
  ready: async () => {
    await Promise.all([domain.pool.query('select 1'), auth.pool.query('select 1'), redis.ping()]);
  },
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  redis.disconnect();
  await Promise.all([domain.pool.end(), auth.pool.end()]);
}
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
await app.listen({ port: config.PORT, host: config.HOST });
