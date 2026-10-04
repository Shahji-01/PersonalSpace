import { z } from 'zod';
import { AttachmentTransferError, type AttachmentUploadTransport } from '@personalspace/sync';
import {
  noteHistoryResponseSchema,
  attachmentUploadStateSchema,
  attachmentUploadGrantSchema,
  attachmentDownloadSchema,
  type AttachmentDescriptor,
  type UploadedPart,
  type AttachmentUploadGrant,
  searchQuerySchema,
  searchResponseSchema,
  type SearchQuery,
  pullResponseSchema,
  pushResponseSchema,
  type Mutation,
  preferencesResponseSchema,
  preferencesUpdateSchema,
  type PreferencesUpdate,
  exportRequestSchema,
  type ExportRequest,
  exportJobResponseSchema,
  deletionRequestSchema,
  type DeletionRequest,
  deletionStatusResponseSchema,
} from '@personalspace/validation';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
export function createClient(baseUrl: string, token: () => string | null) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const currentToken = token();
    const response = await fetch(`${baseUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'personalspace://',
        'X-App-Version': '0.1.0',
        ...(currentToken ? { Authorization: `Bearer ${currentToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(15000),
    });
    // Proxies can return HTML or an empty body for rate limits/outages. Preserve
    // their HTTP status so sync can still apply the appropriate retry policy.
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(data);
      throw new ApiError(
        response.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
        parsed.success ? parsed.data.error.message : 'The request failed. Please try again.',
        retryAfter(response.headers.get('Retry-After')),
      );
    }
    return schema.parse(data);
  }
  return {
    openAttachment: (
      descriptor: AttachmentDescriptor,
      sessionId: string | null,
      signal?: AbortSignal,
    ) =>
      request(
        '/api/v1/attachments/uploads',
        attachmentUploadStateSchema,
        { descriptor, sessionId },
        signal,
      ),
    attachmentPart: (id: string, sessionId: string, number: number, signal?: AbortSignal) =>
      request(
        `/api/v1/attachments/${encodeURIComponent(id)}/parts`,
        attachmentUploadGrantSchema,
        { sessionId, number },
        signal,
      ),
    completeAttachment: (
      id: string,
      sessionId: string,
      parts: UploadedPart[],
      signal?: AbortSignal,
    ) =>
      request(
        `/api/v1/attachments/${encodeURIComponent(id)}/complete`,
        attachmentUploadStateSchema,
        { sessionId, parts },
        signal,
      ),
    cancelAttachment: (id: string) =>
      request(
        `/api/v1/attachments/${encodeURIComponent(id)}/cancel`,
        z.object({ cancelled: z.literal(true) }),
        {},
      ),
    downloadAttachment: (id: string, variant: 'file' | 'thumbnail' = 'file') =>
      request(`/api/v1/attachments/${encodeURIComponent(id)}/download`, attachmentDownloadSchema, {
        variant,
      }),
    removeAttachment: (id: string) =>
      request(
        `/api/v1/attachments/${encodeURIComponent(id)}/remove`,
        z.object({ cancelled: z.literal(true) }),
        {},
      ),
    search: (input: SearchQuery) => {
      const query = searchQuerySchema.parse(input);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) params.set(key, String(value));
      return request(`/api/v1/search?${params}`, searchResponseSchema);
    },
    noteHistory: (id: string, beforeVersion?: number) =>
      request(
        `/api/v1/notes/${encodeURIComponent(id)}/versions${beforeVersion === undefined ? '' : `?beforeVersion=${beforeVersion}`}`,
        noteHistoryResponseSchema,
      ),
    pull: (cursor: number, full = false) =>
      request(`/api/v1/sync/pull?cursor=${cursor}${full ? '&mode=full' : ''}`, pullResponseSchema),
    push: (mutations: Mutation[]) =>
      request('/api/v1/sync/push', pushResponseSchema, { mutations }),
    me: () => request('/api/v1/me', z.object({ data: z.object({ id: z.string() }) })),
    signOut: () => request('/api/auth/sign-out', z.unknown(), {}),
    // Settings (§21)
    getSettings: () => request('/api/v1/settings', preferencesResponseSchema),
    updateSettings: (update: PreferencesUpdate) =>
      request('/api/v1/settings', preferencesResponseSchema, update),
    // Exports (§20.1)
    listExports: () =>
      request('/api/v1/exports', z.object({ data: z.array(exportJobResponseSchema) })),
    startExport: (req: ExportRequest) =>
      request('/api/v1/exports', exportJobResponseSchema, req),
    // Deletion (§64.3)
    getDeletionStatus: () =>
      request('/api/v1/me/deletion-status', deletionStatusResponseSchema),
    requestDeletion: (req: DeletionRequest) =>
      request('/api/v1/me/deletion', deletionStatusResponseSchema, req),
    cancelDeletion: () =>
      request('/api/v1/me/deletion', deletionStatusResponseSchema, { action: 'cancel' }),
  };
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value.trim())) {
    const delay = Number(value) * 1000;
    return Number.isFinite(delay) ? delay : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** The native adapter sends only this grant's headers, never the API bearer token. */
export function createAttachmentTransport(
  client: Pick<
    ReturnType<typeof createClient>,
    'openAttachment' | 'attachmentPart' | 'completeAttachment'
  >,
  put: (input: {
    localUri: string;
    start: number;
    end: number;
    grant: AttachmentUploadGrant;
    signal: AbortSignal;
  }) => Promise<{ status: number; etag: string | null }>,
): AttachmentUploadTransport {
  async function api<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AttachmentTransferError) throw error;
      if (error instanceof z.ZodError) throw new AttachmentTransferError('protocol');
      if (!(error instanceof ApiError)) throw new AttachmentTransferError('retry');
      if (error.status === 401 || error.status === 403) throw new AttachmentTransferError('auth');
      if (
        error.status === 429 ||
        error.status >= 500 ||
        ['UPLOAD_SESSION_CHANGED', 'UPLOAD_INCOMPLETE', 'NOTE_NOT_FOUND'].includes(error.code)
      )
        throw new AttachmentTransferError(
          'retry',
          error.retryAfterMs ?? (error.code === 'UPLOAD_RATE_LIMITED' ? 3600000 : 0),
        );
      throw new AttachmentTransferError('rejected');
    }
  }
  return {
    open: (descriptor, sessionId, signal) =>
      api(() => client.openAttachment(descriptor, sessionId, signal)),
    putPart: async ({ descriptor, sessionId, number, localUri, start, end, signal }) => {
      const grant = await api(() =>
        client.attachmentPart(descriptor.id, sessionId, number, signal),
      );
      if (
        Object.keys(grant.headers).some((key) =>
          ['authorization', 'cookie', 'proxy-authorization'].includes(key.toLowerCase()),
        )
      )
        throw new AttachmentTransferError('protocol');
      const response = await put({ localUri, start, end, grant, signal });
      // A storage 403 means the short-lived grant needs refreshing, not that the API session expired.
      if (response.status === 400 || response.status === 413)
        throw new AttachmentTransferError('local_file');
      if (response.status < 200 || response.status >= 300)
        throw new AttachmentTransferError('retry');
      if (!response.etag) throw new AttachmentTransferError('protocol');
      return response.etag;
    },
    complete: (id, sessionId, parts, signal) =>
      api(async () => {
        const result = await client.completeAttachment(id, sessionId, parts, signal);
        if (result.status === 'uploading') throw new AttachmentTransferError('protocol');
        return result;
      }),
  };
}
