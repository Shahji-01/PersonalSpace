import { z } from 'zod';
import {
  attachmentDescriptorSchema,
  attachmentLimits,
  type AttachmentTransfer,
} from '@personalspace/validation';
import { AttachmentTransferError, newAttachmentTransfer } from '@personalspace/sync';
import type { createAttachmentTransport } from '@personalspace/api-client';

export type NativePut = Parameters<typeof createAttachmentTransport>[1];
export interface AttachmentFiles {
  pick(parentId: string, signal: AbortSignal): Promise<AttachmentTransfer | null>;
  inspect(uri: string, signal: AbortSignal): Promise<{ size: number; sha256: string }>;
  put: NativePut;
  remove(uri: string): Promise<void>;
  share(
    id: string,
    grant: { url: string; size: number; sha256: string | null; mime: string },
    signal: AbortSignal,
    permitted: () => Promise<boolean>,
  ): Promise<void>;
  pruneDownloads(ids: string[]): Promise<void>;
  watchNetwork(listener: (network: { connected: boolean; wifi: boolean }) => void): () => void;
}

// Load on demand: an older development binary can still open notes if new native
// modules have not been installed yet. The host reports attachment unavailability.
export async function createNativeAttachmentFiles(
  userId: string,
  newId: () => string,
): Promise<AttachmentFiles> {
  z.uuid().parse(userId);
  const [fs, crypto, picker, network, sharing, http] = await Promise.all([
    import('expo-file-system'),
    import('expo-crypto'),
    import('expo-document-picker'),
    import('expo-network'),
    import('expo-sharing'),
    import('expo/fetch'),
  ]);
  const root = new fs.Directory(fs.Paths.document, 'attachments', userId);
  root.create({ intermediates: true, idempotent: true });
  const cache = new fs.Directory(fs.Paths.cache, 'attachment-downloads', userId);
  cache.create({ intermediates: true, idempotent: true });
  const ownFile = (uri: string) => {
    const file = new fs.File(uri);
    if (!file.uri.startsWith(`${root.uri.replace(/\/$/, '')}/`))
      throw new AttachmentTransferError('local_file');
    const name = file.uri.slice(root.uri.replace(/\/$/, '').length + 1);
    if (!z.uuidv7().safeParse(name).success) throw new AttachmentTransferError('local_file');
    return file;
  };
  const hash = async (bytes: Uint8Array<ArrayBuffer>) =>
    Array.from(
      new Uint8Array(await crypto.digest(crypto.CryptoDigestAlgorithm.SHA256, bytes)),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
  const inspect = async (uri: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    try {
      const file = ownFile(uri);
      if (!file.exists || file.size < 1 || file.size > attachmentLimits.maxBytes)
        throw new Error('Invalid file');
      const bytes = await file.bytes();
      if (bytes.length !== file.size || bytes.length > attachmentLimits.maxBytes)
        throw new Error('Changed file');
      const sha256 = await hash(bytes);
      signal.throwIfAborted();
      return { size: bytes.length, sha256 };
    } catch {
      throw new AttachmentTransferError('local_file');
    }
  };
  return {
    inspect,
    pick: async (parentId, signal) => {
      const selected = await picker.getDocumentAsync({
        type: [
          ...attachmentDescriptorSchema.shape.mime.options.filter((mime) => mime !== 'audio/webm'),
          'audio/x-m4a',
          'image/heif',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      signal.throwIfAborted();
      if (selected.canceled) return null;
      const asset = selected.assets[0];
      if (!asset) return null;
      const source = new fs.File(asset.uri);
      if (!source.exists || source.size < 1 || source.size > attachmentLimits.maxBytes)
        throw new Error('Choose a file between 1 byte and 25 MB.');
      const extensions: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        heic: 'image/heic',
        pdf: 'application/pdf',
        txt: 'text/plain',
        md: 'text/markdown',
        csv: 'text/csv',
        m4a: 'audio/mp4',
        mp3: 'audio/mpeg',
        ogg: 'audio/ogg',
        opus: 'audio/ogg',
      };
      const declared =
        asset.mimeType && asset.mimeType !== 'application/octet-stream'
          ? asset.mimeType
          : extensions[asset.name.split('.').pop()?.toLowerCase() ?? ''];
      const mime =
        declared === 'audio/x-m4a'
          ? 'audio/mp4'
          : declared === 'image/heif'
            ? 'image/heic'
            : declared?.split(';')[0];
      const id = newId();
      const initial = attachmentDescriptorSchema.safeParse({
        id,
        parentId,
        filename: asset.name,
        mime,
        size: source.size,
        sha256: '0'.repeat(64),
      });
      if (!initial.success) throw new Error('This file type or filename is not supported.');
      const destination = new fs.File(root, id);
      if (destination.exists) throw new Error('Could not reserve a local file. Try again.');
      try {
        source.copy(destination);
        const fingerprint = await inspect(destination.uri, signal);
        return newAttachmentTransfer({ ...initial.data, ...fingerprint }, destination.uri);
      } catch (error) {
        if (destination.exists) destination.delete();
        throw error;
      }
    },
    put: async ({ localUri, start, end, grant, signal }) => {
      signal.throwIfAborted();
      const file = ownFile(localUri);
      if (
        !file.exists ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > file.size ||
        end - start > attachmentLimits.multipartAboveBytes
      )
        throw new AttachmentTransferError('local_file');
      if (grant.method !== 'PUT' || Number(grant.headers['content-length']) !== end - start)
        throw new AttachmentTransferError('protocol');
      const response = await http.fetch(grant.url, {
        method: 'PUT',
        headers: grant.headers,
        body: file.slice(start, end),
        signal,
        credentials: 'omit',
        redirect: 'error',
      });
      // Ignore storage error bodies: they may contain signed URLs.
      await response.body?.cancel();
      return { status: response.status, etag: response.headers.get('etag') };
    },
    remove: async (uri) => {
      const file = ownFile(uri);
      if (file.exists) file.delete();
    },
    pruneDownloads: async (ids) => {
      const keep = new Set(ids);
      for (const item of cache.list())
        if (item instanceof fs.File && !keep.has(item.name.split('.')[0]!)) item.delete();
    },
    share: async (id, grant, signal, permitted) => {
      z.uuidv7().parse(id);
      if (!grant.sha256 || grant.size < 1 || grant.size > attachmentLimits.maxBytes)
        throw new Error('Invalid download metadata.');
      if (!(await sharing.isAvailableAsync()))
        throw new Error('Saving or sharing files is unavailable on this device.');
      signal.throwIfAborted();
      const response = await http.fetch(grant.url, {
        signal,
        credentials: 'omit',
        redirect: 'error',
      });
      if (!response.ok || !response.body) throw new Error('Download failed. Please try again.');
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > grant.size) throw new Error('Download exceeded its expected size.');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      if (length !== grant.size || (await hash(bytes)) !== grant.sha256)
        throw new Error('Download verification failed. Try again.');
      signal.throwIfAborted();
      // Keep at most one verified download per account; unsynced originals live elsewhere.
      if (!(await permitted())) throw new Error('This file is no longer available.');
      signal.throwIfAborted();
      for (const item of cache.list()) if (item instanceof fs.File) item.delete();
      const extensions: Record<string, string> = {
        'image/webp': 'webp',
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'text/markdown': 'md',
        'text/csv': 'csv',
        'audio/mp4': 'm4a',
        'audio/mpeg': 'mp3',
        'audio/ogg': 'ogg',
      };
      const file = new fs.File(cache, `${id}.${extensions[grant.mime] ?? 'bin'}`);
      file.write(bytes);
      await sharing.shareAsync(file.uri, {
        mimeType: grant.mime,
        dialogTitle: 'Save or share file',
      });
    },
    watchNetwork: (listener) => {
      let active = true,
        observed = false;
      const emit = (state: import('expo-network').NetworkState) => {
        if (active)
          listener({
            connected: state.isConnected === true && state.isInternetReachable !== false,
            wifi: state.type === network.NetworkStateType.WIFI,
          });
      };
      const subscription = network.addNetworkStateListener((state) => {
        observed = true;
        emit(state);
      });
      void network
        .getNetworkStateAsync()
        .then((state) => {
          if (!observed) emit(state);
        })
        .catch(() => {});
      return () => {
        active = false;
        subscription.remove();
      };
    },
  };
}
