export const MAX_PREVIEW_BYTES = 1024 * 1024;
export const MAX_PREVIEW_DATA_LENGTH = Math.ceil(MAX_PREVIEW_BYTES / 3) * 4 + 23;

// Accept only bounded, non-animated WebP thumbnails before crossing the DOM bridge.
export function validateWebpThumbnail(bytes: Uint8Array): void {
  const invalid = () => {
    throw new Error('This image preview is unavailable.');
  };
  if (bytes.length < 25 || bytes.length > MAX_PREVIEW_BYTES) return invalid();
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    text(0, 4) !== 'RIFF' ||
    text(8, 4) !== 'WEBP' ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return invalid();
  const kind = text(12, 4),
    chunkSize = view.getUint32(16, true);
  if (chunkSize + 20 > bytes.length) return invalid();
  let width: number, height: number;
  if (kind === 'VP8X' && chunkSize >= 10) {
    if (bytes[20]! & 2) return invalid();
    width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
  } else if (kind === 'VP8 ' && chunkSize >= 10 && text(23, 3) === '\x9d\x01\x2a') {
    width = view.getUint16(26, true) & 0x3fff;
    height = view.getUint16(28, true) & 0x3fff;
  } else if (kind === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f) {
    width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0xf) << 10);
  } else return invalid();
  if (width < 1 || height < 1 || width > 320 || height > 320) return invalid();
}

export function webpPreviewData(bytes: Uint8Array): string {
  validateWebpThumbnail(bytes);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const result: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result.push(
      alphabet[(value >>> 18) & 63]!,
      alphabet[(value >>> 12) & 63]!,
      i + 1 < bytes.length ? alphabet[(value >>> 6) & 63]! : '=',
      i + 2 < bytes.length ? alphabet[value & 63]! : '=',
    );
  }
  return `data:image/webp;base64,${result.join('')}`;
}

export function isPreviewData(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PREVIEW_DATA_LENGTH &&
    /^data:image\/webp;base64,UklGR[A-Za-z0-9+/]*={0,2}$/.test(value)
  );
}
