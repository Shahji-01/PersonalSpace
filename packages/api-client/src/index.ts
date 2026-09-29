import { z } from 'zod';
import { pullResponseSchema, pushResponseSchema, type Mutation } from '@personalspace/validation';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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
    const data: unknown = await response.json();
    if (!response.ok) {
      const parsed = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(data);
      throw new ApiError(
        response.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
        parsed.success ? parsed.data.error.message : 'The request failed. Please try again.',
      );
    }
    return schema.parse(data);
  }
  return {
    pull: (cursor: number) => request(`/api/v1/sync/pull?cursor=${cursor}`, pullResponseSchema),
    push: (mutations: Mutation[]) =>
      request('/api/v1/sync/push', pushResponseSchema, { mutations }),
    me: () => request('/api/v1/me', z.object({ data: z.object({ id: z.string() }) })),
    signOut: () => request('/api/auth/sign-out', z.unknown(), {}),
  };
}
