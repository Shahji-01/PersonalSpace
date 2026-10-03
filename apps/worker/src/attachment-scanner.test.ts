import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createClamScanner, readProcessorConfig } from './attachment-scanner';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function scannerServer(reply: Buffer | null, truncate = false) {
  let received = Buffer.alloc(0);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      // Decode the framed request before responding, even if TCP splits chunks.
      if (received.length < 10) return;
      let offset = 10;
      while (offset + 4 <= received.length) {
        const size = received.readUInt32BE(offset);
        offset += 4;
        if (size === 0) {
          if (reply) {
            socket.write(reply.subarray(0, 3));
            socket.end(reply.subarray(3));
          } else if (truncate) socket.end();
          return;
        }
        if (offset + size > received.length) return;
        offset += size;
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { port: address.port, received: () => received };
}

describe('ClamAV streaming adapter', () => {
  it('frames complete bytes and accepts only the exact clean reply', async () => {
    const server = await scannerServer(Buffer.from('stream: OK\0'));
    const bytes = Buffer.alloc(70000, 17);
    expect(await createClamScanner('127.0.0.1', server.port)(bytes)).toBe('clean');
    const request = server.received();
    expect(request.subarray(0, 10).toString()).toBe('zINSTREAM\0');
    expect(request.readUInt32BE(10)).toBe(65536);
    expect(request.subarray(14, 65550)).toEqual(bytes.subarray(0, 65536));
    expect(request.readUInt32BE(request.length - 4)).toBe(0);
  });
  it('reports infected files without retaining signature or file data', async () => {
    const server = await scannerServer(Buffer.from('stream: Test-Signature FOUND\0'));
    expect(await createClamScanner('127.0.0.1', server.port)(Buffer.from('test'))).toBe('infected');
  });
  it.each([
    Buffer.from('stream: size limit exceeded ERROR\0'),
    Buffer.from('OK\0'),
    Buffer.from('stream: OK'),
  ])('fails closed on invalid or incomplete responses %s', async (reply) => {
    const server = await scannerServer(reply);
    await expect(createClamScanner('127.0.0.1', server.port)(Buffer.from('test'))).rejects.toThrow(
      'scanner unavailable',
    );
  });
  it('bounds stalled scans and disconnects without a verdict', async () => {
    const stalled = await scannerServer(null);
    await expect(
      createClamScanner('127.0.0.1', stalled.port, 50)(Buffer.from('test')),
    ).rejects.toThrow('scanner unavailable');
    const closed = await scannerServer(null, true);
    await expect(createClamScanner('127.0.0.1', closed.port)(Buffer.from('test'))).rejects.toThrow(
      'scanner unavailable',
    );
  });
  it('requires complete opt-in configuration without disclosing credentials', () => {
    expect(readProcessorConfig({})).toBeNull();
    expect(() => readProcessorConfig({ ATTACHMENT_DATABASE_URL: 'secret' })).toThrow('requires');
    expect(
      readProcessorConfig({
        ATTACHMENT_DATABASE_URL: 'postgres://local/test',
        CLAMAV_HOST: 'localhost',
      })?.CLAMAV_PORT,
    ).toBe(3310);
  });
});
