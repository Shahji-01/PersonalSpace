import { z } from 'zod';
import {
  noteHistoryResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
  type SearchQuery,
  pullResponseSchema,
  pushResponseSchema,
  type Mutation,
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
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
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
      signal: AbortSignal.timeout(15000),
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
