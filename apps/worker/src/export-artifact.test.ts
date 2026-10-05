import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { buildExportArtifact } from './export-artifact';

// Read the ZIP central directory independently from the archive writer.
function entries(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const files: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10),
      size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28),
      extraLength = zip.readUInt16LE(offset + 30),
      commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = zip.readUInt32LE(offset + 42);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(bytes) : bytes).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe('export artifacts', () => {
  it('writes real CSV and Markdown ZIP archives with Unicode content and a manifest', async () => {
    const id = v7(),
      data = {
        exportedAt: new Date().toISOString(),
        scope: 'notes' as const,
        notes: [
          {
            id,
            title: 'नोट',
            contentJson: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Saved content' }] }],
            },
          },
        ],
      };
    const csv = await buildExportArtifact(data, 'csv');
    expect(csv.mime).toBe('application/zip');
    expect(csv.extension).toBe('zip');
    expect(entries(csv.body)['notes.csv']).toContain('नोट');
    const markdown = entries((await buildExportArtifact(data, 'markdown')).body);
    expect(markdown[`notes/note-${id}.md`]).toContain('Saved content');
    expect(JSON.parse(markdown['manifest.json']!).attachmentBytesIncluded).toBe(false);
    const json = await buildExportArtifact(data, 'json');
    expect(json.mime).toBe('application/json');
    expect(JSON.parse(json.body.toString()).notes).toEqual(data.notes);
  });
  it('produces an explanatory archive for an empty scope and rejects oversized artifacts', async () => {
    const data = { exportedAt: new Date().toISOString(), scope: 'notes' as const, notes: [] };
    expect(Object.keys(entries((await buildExportArtifact(data, 'csv')).body)).sort()).toEqual([
      'README.txt',
      'manifest.json',
    ]);
    await expect(
      buildExportArtifact({ ...data, notes: [{ text: 'x'.repeat(50 * 1024 * 1024) }] }, 'json'),
    ).rejects.toThrow('size limit');
  });
});
