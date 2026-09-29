import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const example = await readFile(new URL('.env.example', root), 'utf8');
try {
  await writeFile(
    new URL('.env', root),
    example.replace('AUTH_SECRET=\n', `AUTH_SECRET=${randomBytes(32).toString('hex')}\n`),
    { flag: 'wx' },
  );
  console.log('Created .env with a random local auth secret.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Kept existing .env.');
}
try {
  await writeFile(
    new URL('apps/mobile/.env', root),
    'EXPO_PUBLIC_API_URL=http://localhost:4000\n',
    { flag: 'wx' },
  );
  console.log('Created mobile environment. Use your LAN address for a physical phone.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
