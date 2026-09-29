import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('127.0.0.1'),
  API_URL: z.url(),
  WEB_URL: z.url(),
  DATABASE_URL: z.url(),
  AUTH_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  AUTH_SECRET: z.string().min(32),
});
export type ServerConfig = z.infer<typeof schema>;
export function readConfig(env: Record<string, string | undefined>): ServerConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Never print values: this schema includes credentials.
    throw new Error(
      `Invalid environment variables: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  if (result.data.NODE_ENV === 'production') {
    throw new Error(
      'Production is gated until the launch requirements in docs/implementation.md are complete.',
    );
  }
  return result.data;
}
