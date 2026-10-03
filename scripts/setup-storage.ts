import { createS3Storage, readStorageConfig } from '../packages/storage/src/index';

const config = readStorageConfig(process.env);
if (
  !config?.S3_ENDPOINT ||
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(config.S3_ENDPOINT).hostname)
)
  throw new Error('This development setup command requires a loopback S3_ENDPOINT.');
const storage = createS3Storage(config);
try {
  await storage.setup();
  console.log('Private development attachment bucket and quarantine lifecycle configured.');
} finally {
  storage.close();
}
