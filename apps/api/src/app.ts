import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from '@personalspace/config';
import type { Database } from '@personalspace/db';
import type { AttachmentStorage } from '@personalspace/storage';
import {
  createCaptureService,
  createAttachmentService,
  createNoteHistoryService,
  createSearchService,
  DomainError,
} from '@personalspace/domain';
import {
  commandSchema,
  attachmentOpenSchema,
  attachmentPartRequestSchema,
  attachmentCompleteSchema,
  searchQuerySchema,
  searchResponseSchema,
  idSchema,
  noteHistoryResponseSchema,
  pullResponseSchema,
  pushResponseSchema,
  signupSchema,
  syncPushSchema,
  type MutationResult,
} from '@personalspace/validation';
import { createAuth } from './auth';

export async function createApp(deps: {
  config: ServerConfig;
  db: Database;
  authDb: Database;
  ready: () => Promise<void>;
  logger?: boolean;
  storage?: AttachmentStorage;
}) {
  const { config } = deps;
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: 'info',
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
          },
    disableRequestLogging: true,
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  const auth = createAuth(deps.authDb, config);
  const capture = createCaptureService(deps.db);
  const noteHistory = createNoteHistoryService(deps.db);
  const attachmentService = deps.storage ? createAttachmentService(deps.db, deps.storage) : null;
  const files = () => {
    if (!attachmentService)
      throw new DomainError('STORAGE_UNAVAILABLE', 'Attachment storage is not configured.', 503);
    return attachmentService;
  };
  await app.register(helmet);
  await app.register(cors, {
    origin: config.WEB_URL,
    credentials: true,
    exposedHeaders: ['set-auth-token', 'x-request-id'],
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'x-app-version'],
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: { title: 'PersonalSpace API', version: '0.1.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    // Route templates only: URLs and request bodies can contain private data.
    app.log.info(
      {
        requestId: request.id,
        route: request.routeOptions.url,
        status: reply.statusCode,
        latencyMs: reply.elapsedTime,
      },
      'request completed',
    );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Please check the submitted fields.',
          requestId: request.id,
          details: error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
        },
      });
    if (error instanceof DomainError) {
      if (error.code === 'UPLOAD_RATE_LIMITED') reply.header('Retry-After', '3600');
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, requestId: request.id } });
    }
    const status =
      error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    app.log.error(
      {
        requestId: request.id,
        errorType: error instanceof Error ? error.name : 'UnknownError',
        status,
      },
      'request failed',
    );
    return reply.code(status).send({
      error: {
        code:
          status === 400
            ? 'VALIDATION_FAILED'
            : status === 429
              ? 'RATE_LIMITED'
              : 'SERVICE_UNAVAILABLE',
        message:
          status === 400
            ? 'Please check the submitted fields.'
            : status === 429
              ? 'Too many requests. Try again shortly.'
              : 'The request could not be completed. Please retry.',
        requestId: request.id,
      },
    });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await deps.ready();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/openapi.json', async () => app.swagger());
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    handler: async (request, reply) => {
      const path = new URL(request.url, config.API_URL).pathname;
      const enabled = [
        '/sign-up/email',
        '/sign-in/email',
        '/sign-out',
        '/get-session',
        '/list-sessions',
        '/revoke-session',
      ];
      if (!enabled.some((suffix) => path === `/api/auth${suffix}`))
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'This endpoint is not enabled.' } });
      if (path === '/api/auth/sign-up/email') signupSchema.parse(request.body);
      const response = await auth.handler(
        new Request(new URL(request.url, config.API_URL), {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });
  await app.register(
    async (api) => {
      api.decorateRequest('userId', '');
      api.addHook('preHandler', async (request, reply) => {
        // Domain routes use native bearer sessions only in this milestone. Browser sessions
        // remain confined to Better Auth's origin-checked endpoints until web CSRF is added.
        if (!request.headers.authorization?.startsWith('Bearer '))
          return reply
            .code(401)
            .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
        const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        if (!session)
          return reply
            .code(401)
            .send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
        request.userId = session.user.id;
      });
      api.get('/me', async (request) => ({ data: { id: request.userId } }));
      api.post(
        '/attachments/:id/remove',
        { schema: { security: [{ bearerAuth: [] }] } },
        async (request) => {
          const { id } = z.object({ id: idSchema }).parse(request.params);
          return files().cancel(request.userId, id, request.id, true);
        },
      );
      api.post(
        '/attachments/:id/download',
        { schema: { security: [{ bearerAuth: [] }] } },
        async (request, reply) => {
          const { id } = z.object({ id: idSchema }).parse(request.params);
          const { variant } = z
            .strictObject({ variant: z.enum(['file', 'thumbnail']).default('file') })
            .parse(request.body ?? {});
          reply.header('Cache-Control', 'no-store');
          return files().download(request.userId, id, variant === 'thumbnail');
        },
      );
      api.post(
        '/attachments/uploads',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            body: z.toJSONSchema(attachmentOpenSchema, { target: 'draft-7', io: 'input' }),
          },
        },
        async (request) => {
          const { descriptor } = attachmentOpenSchema.parse(request.body);
          return files().open(request.userId, descriptor, request.id);
        },
      );
      api.post(
        '/attachments/:id/parts',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            body: z.toJSONSchema(attachmentPartRequestSchema, { target: 'draft-7' }),
          },
        },
        async (request) => {
          const { id } = z.object({ id: idSchema }).parse(request.params);
          const { sessionId, number } = attachmentPartRequestSchema.parse(request.body);
          return files().part(request.userId, id, sessionId, number);
        },
      );
      api.post(
        '/attachments/:id/complete',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            body: z.toJSONSchema(attachmentCompleteSchema, { target: 'draft-7' }),
          },
        },
        async (request) => {
          const { id } = z.object({ id: idSchema }).parse(request.params);
          const { sessionId, parts } = attachmentCompleteSchema.parse(request.body);
          return files().complete(request.userId, id, sessionId, parts, request.id);
        },
      );
      api.post(
        '/attachments/:id/cancel',
        { schema: { security: [{ bearerAuth: [] }] } },
        async (request) => {
          const { id } = z.object({ id: idSchema }).parse(request.params);
          return files().cancel(request.userId, id, request.id);
        },
      );
      api.get(
        '/search',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            querystring: z.toJSONSchema(
              searchQuerySchema.omit({ limit: true, offset: true, includeArchived: true }).extend({
                limit: z
                  .string()
                  .regex(/^[0-9]+$/)
                  .optional(),
                offset: z
                  .string()
                  .regex(/^[0-9]+$/)
                  .optional(),
                includeArchived: z.enum(['true', 'false']).optional(),
              }),
              { target: 'draft-7', io: 'input' },
            ),
            response: { 200: z.toJSONSchema(searchResponseSchema, { target: 'draft-7' }) },
          },
        },
        async (request) => {
          const raw = request.query as Record<string, unknown>;
          return createSearchService(deps.db).search(
            request.userId,
            searchQuerySchema.parse({
              ...raw,
              limit: raw.limit === undefined ? undefined : Number(raw.limit),
              offset: raw.offset === undefined ? undefined : Number(raw.offset),
              includeArchived: raw.includeArchived === 'true',
            }),
          );
        },
      );
      api.get(
        '/notes/:id/versions',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            params: z.toJSONSchema(z.object({ id: idSchema }), { target: 'draft-7' }),
            querystring: z.toJSONSchema(
              z.strictObject({
                beforeVersion: z
                  .string()
                  .regex(/^[1-9][0-9]*$/)
                  .optional(),
              }),
              { target: 'draft-7' },
            ),
            response: { 200: z.toJSONSchema(noteHistoryResponseSchema, { target: 'draft-7' }) },
          },
        },
        async (request) => {
          const { id } = z.object({ id: idSchema }).parse(request.params);
          const { beforeVersion } = z
            .object({
              beforeVersion: z.coerce
                .number()
                .int()
                .positive()
                .max(Number.MAX_SAFE_INTEGER)
                .optional(),
            })
            .parse(request.query);
          return noteHistory.list(request.userId, id, beforeVersion);
        },
      );
      api.post(
        '/commands',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            body: z.toJSONSchema(commandSchema, { target: 'draft-7', io: 'input' }),
          },
        },
        async (request) => {
          const key = idSchema.parse(request.headers['idempotency-key']);
          return {
            data: await capture.execute(
              request.userId,
              key,
              commandSchema.parse(request.body),
              request.id,
            ),
          };
        },
      );
      api.post(
        '/sync/push',
        {
          schema: {
            security: [{ bearerAuth: [] }],
            body: z.toJSONSchema(syncPushSchema, { target: 'draft-7', io: 'input' }),
          },
        },
        async (request) => {
          const { mutations } = syncPushSchema.parse(request.body);
          const results: MutationResult[] = [];
          for (const mutation of mutations) {
            try {
              results.push({
                mutationId: mutation.mutationId,
                status: 'applied',
                records: await capture.execute(
                  request.userId,
                  mutation.mutationId,
                  mutation.command,
                  request.id,
                ),
              });
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
              results.push({
                mutationId: mutation.mutationId,
                status: error.code === 'VERSION_CONFLICT' ? 'conflict' : 'rejected',
                code: error.code,
                message: error.message,
              });
            }
          }
          return pushResponseSchema.parse({ results });
        },
      );
      api.get('/sync/pull', { schema: { security: [{ bearerAuth: [] }] } }, async (request) => {
        const { cursor, mode } = z
          .object({
            cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
            mode: z.enum(['incremental', 'full']).default('incremental'),
          })
          .parse(request.query);
        return pullResponseSchema.parse(
          await capture.pull(request.userId, cursor, mode === 'full'),
        );
      });
    },
    { prefix: '/api/v1' },
  );
  return app;
}
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}
