import { createConnection } from 'node:net';
import { z } from 'zod';

export type AttachmentScanner = (bytes: Buffer) => Promise<'clean' | 'infected'>;
export function readProcessorConfig(env: Record<string, string | undefined>) {
  const names = ['ATTACHMENT_DATABASE_URL', 'CLAMAV_HOST', 'CLAMAV_PORT'] as const;
  if (!names.some((name) => env[name])) return null;
  const parsed = z
    .object({
      ATTACHMENT_DATABASE_URL: z.url(),
      CLAMAV_HOST: z.string().trim().min(1),
      CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    })
    .safeParse(env);
  if (!parsed.success)
    throw new Error('Attachment processing requires ATTACHMENT_DATABASE_URL and CLAMAV_HOST.');
  return parsed.data;
}

/** clamd INSTREAM: no temporary files, filenames, tokens or scanner details in errors. */
export function createClamScanner(
  host: string,
  port: number,
  timeoutMs = 30000,
): AttachmentScanner {
  return (bytes) =>
    new Promise((resolve, reject) => {
      const socket = createConnection({ host, port });
      let settled = false,
        streamSent = false,
        response = Buffer.alloc(0);
      const finish = (result?: 'clean' | 'infected') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (result) resolve(result);
        else reject(new Error('Attachment scanner unavailable'));
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      socket.on('error', () => finish());
      socket.on('end', () => finish());
      socket.on('close', () => finish());
      socket.on('data', (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > 4096) return finish();
        const end = response.indexOf(0);
        if (end < 0) return;
        const value = response.subarray(0, end).toString('utf8');
        if (end !== response.length - 1) return finish();
        if (value === 'stream: OK' && streamSent) finish('clean');
        else if (/^stream: [^\r\n]+ FOUND$/.test(value)) finish('infected');
        else finish();
      });
      const write = (chunk: Buffer) =>
        new Promise<void>((done, fail) => {
          socket.write(chunk, (error) => (error ? fail(error) : done()));
        });
      socket.once('connect', () => {
        void (async () => {
          await write(Buffer.from('zINSTREAM\0'));
          for (let start = 0; start < bytes.length && !settled; start += 65536) {
            const chunk = bytes.subarray(start, start + 65536),
              length = Buffer.alloc(4);
            length.writeUInt32BE(chunk.length);
            await write(Buffer.concat([length, chunk]));
          }
          if (!settled) {
            streamSent = true;
            await write(Buffer.alloc(4));
          }
        })().catch(() => finish());
      });
    });
}
