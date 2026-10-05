import archiver from 'archiver';
import {
  exportToCsv,
  exportToJson,
  exportToMarkdown,
  type ExportData,
  type ExportFormat,
} from '@personalspace/domain';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20000;

export async function buildExportArtifact(data: ExportData, format: ExportFormat) {
  if (format === 'json') {
    const body = Buffer.from(exportToJson(data), 'utf8');
    if (body.length > MAX_BYTES) throw new Error('Export exceeds the current size limit');
    return { body, mime: 'application/json', extension: 'json' };
  }
  const files = format === 'csv' ? exportToCsv(data) : exportToMarkdown(data);
  files['manifest.json'] = JSON.stringify(
    {
      exportedAt: data.exportedAt,
      scope: data.scope,
      format,
      files: Object.keys(files),
      attachmentBytesIncluded: false,
    },
    null,
    2,
  );
  files['README.txt'] =
    'PersonalSpace export\nUTF-8 text. Attachment bytes are not included in this export.\nCSV structured fields contain JSON; text beginning with formula characters has a protective apostrophe. Monetary amounts are stored in minor currency units.\nMarkdown uses stable ID filenames; folder README files contain display names.\n';
  if (
    Object.keys(files).length > MAX_FILES ||
    Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_BYTES
  )
    throw new Error('Export exceeds the current size limit');
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const result = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        archive.abort();
        reject(new Error('Export exceeds the current size limit'));
      } else chunks.push(chunk);
    });
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, content] of Object.entries(files))
    archive.append(content, { name, date: new Date('2000-01-01T00:00:00Z'), mode: 0o600 });
  // Subscribe before finalizing: stream completion may occur while finalizing.
  await Promise.all([archive.finalize(), result]);
  return { body: await result, mime: 'application/zip', extension: 'zip' };
}
