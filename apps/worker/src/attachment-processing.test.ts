import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { prepareAttachment } from './attachment-processing';

describe('attachment content processing', () => {
  it('normalizes M4A and Opus signatures without accepting an MP4 video as audio', async () => {
    const m4a = Buffer.alloc(40);
    m4a.writeUInt32BE(24);
    m4a.write('ftypM4A ', 4);
    const opus = Buffer.alloc(40);
    opus.write('OggS');
    opus.write('OpusHead', 28);
    expect((await prepareAttachment(m4a, 'audio/mp4', async () => 'clean')).mime).toBe('audio/mp4');
    expect((await prepareAttachment(opus, 'audio/ogg', async () => 'clean')).mime).toBe(
      'audio/ogg',
    );
    m4a.write('mp42', 8);
    await expect(prepareAttachment(m4a, 'audio/mp4', async () => 'clean')).rejects.toMatchObject({
      reason: 'type',
    });
  });
  it('re-encodes and orients images without EXIF, and creates a bounded thumbnail', async () => {
    const input = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#3264ab' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Artist: 'Private name' } })
      .toBuffer();
    const scan = vi.fn(async () => 'clean' as const);
    const output = await prepareAttachment(input, 'image/jpeg', scan);
    expect(scan).toHaveBeenCalledWith(input);
    expect(output.mime).toBe('image/webp');
    const full = await sharp(output.bytes).metadata();
    expect(full).toMatchObject({ width: 400, height: 600, format: 'webp' });
    expect(full.exif).toBeUndefined();
    expect(full.icc).toBeUndefined();
    const thumb = await sharp(output.thumbnail!).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(320);
    expect(thumb.exif).toBeUndefined();
  });

  it('rejects mismatched types, invalid UTF-8, binary text and broken images', async () => {
    const clean = async () => 'clean' as const;
    const pdf = Buffer.from('%PDF-1.7\n%document');
    await expect(prepareAttachment(pdf, 'image/jpeg', clean)).rejects.toMatchObject({
      reason: 'type',
    });
    await expect(prepareAttachment(pdf, 'text/plain', clean)).rejects.toMatchObject({
      reason: 'type',
    });
    await expect(
      prepareAttachment(Buffer.from([0xff, 0xff]), 'text/plain', clean),
    ).rejects.toMatchObject({ reason: 'type' });
    await expect(
      prepareAttachment(Buffer.from('text\0hidden'), 'text/plain', clean),
    ).rejects.toMatchObject({ reason: 'type' });
    const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    await expect(prepareAttachment(png.subarray(0, 40), 'image/png', clean)).rejects.toMatchObject({
      reason: 'invalid_image',
    });
  });

  it('preserves scanned UTF-8 documents and never releases scanner failures', async () => {
    const bytes = Buffer.from('A private note\nनमस्ते\t');
    expect(await prepareAttachment(bytes, 'text/plain', async () => 'clean')).toEqual({
      bytes,
      mime: 'text/plain',
      thumbnail: null,
    });
    await expect(
      prepareAttachment(bytes, 'text/plain', async () => 'infected'),
    ).rejects.toMatchObject({ reason: 'malware' });
    await expect(
      prepareAttachment(bytes, 'text/plain', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
  });
});
