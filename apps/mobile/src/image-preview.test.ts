import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  isPreviewData,
  validateWebpThumbnail,
  webpPreviewData,
  MAX_PREVIEW_BYTES,
} from './image-preview';

describe('bounded image preview bridge', () => {
  it.each([{ lossless: true }, { lossless: false }, { lossless: false, alpha: true }])(
    'accepts actual WebP bytes and preserves base64 (%j)',
    async ({ lossless, alpha }) => {
      const bytes = await sharp({
        create: {
          width: 240,
          height: 160,
          channels: alpha ? 4 : 3,
          background: { r: 120, g: 160, b: 140, alpha: 0.5 },
        },
      })
        .webp({ lossless })
        .toBuffer();
      expect(webpPreviewData(bytes)).toBe(`data:image/webp;base64,${bytes.toString('base64')}`);
      expect(isPreviewData(webpPreviewData(bytes))).toBe(true);
      const corrupt = Buffer.from(bytes);
      corrupt[4] = 0;
      expect(() => validateWebpThumbnail(corrupt)).toThrow();
      expect(() => validateWebpThumbnail(bytes.subarray(0, 24))).toThrow();
    },
  );
  it('rejects large dimensions, excessive bytes, animation and unsafe sources', async () => {
    const bytes = await sharp({
      create: { width: 321, height: 20, channels: 3, background: '#ffffff' },
    })
      .webp()
      .toBuffer();
    expect(() => validateWebpThumbnail(bytes)).toThrow();
    expect(() => validateWebpThumbnail(new Uint8Array(MAX_PREVIEW_BYTES + 1))).toThrow();
    const extended = await sharp({
      create: { width: 32, height: 32, channels: 4, background: '#ffffff80' },
    })
      .webp()
      .toBuffer();
    expect(extended.subarray(12, 16).toString()).toBe('VP8X');
    extended[20] = extended[20]! | 2;
    expect(() => validateWebpThumbnail(extended)).toThrow();
    for (const value of [
      'https://example.test/file',
      'file:///private',
      'data:image/svg+xml,<svg/>',
      null,
    ])
      expect(isPreviewData(value)).toBe(false);
  });
});
