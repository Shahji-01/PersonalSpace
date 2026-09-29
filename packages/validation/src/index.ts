import { z } from 'zod';

export const idSchema = z.uuidv7();
export const dateSchema = z.iso.date();
export const captureTypeSchema = z.enum(['inbox', 'note', 'task']);
export const captureSchema = z
  .strictObject({
    id: idSchema,
    type: captureTypeSchema.default('inbox'),
    text: z.string().trim().min(1).max(20000),
    plannedDate: dateSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'task' && value.text.length > 500)
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'Task titles must be 500 characters or fewer.',
      });
    if (value.type !== 'task' && value.plannedDate !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['plannedDate'],
        message: 'Only tasks have a planned date.',
      });
  });
export const commandSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('capture'), payload: captureSchema }),
  z.strictObject({
    op: z.literal('task.complete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.reopen'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('inbox.convert'),
    id: idSchema,
    targetId: idSchema,
    targetType: z.enum(['note', 'task']),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.edit'),
    id: idSchema,
    text: z.string().trim().min(1).max(20000),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.restore'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.purge'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.reschedule'),
    id: idSchema,
    plannedDate: dateSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.addSubtask'),
    id: idSchema,
    parentId: idSchema,
    text: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    op: z.literal('task.rename'),
    id: idSchema,
    text: z.string().trim().min(1).max(500),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.restore'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.purge'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
]);
export const syncPushSchema = z.strictObject({
  mutations: z
    .array(z.strictObject({ mutationId: idSchema, command: commandSchema }))
    .min(1)
    .max(50),
});
export const recordSchema = z.strictObject({
  id: idSchema,
  type: captureTypeSchema,
  text: z.string(),
  status: z.enum(['new', 'converted', 'todo', 'done', 'active']),
  plannedDate: dateSchema.nullable(),
  parentId: idSchema.nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export const pullResponseSchema = z.strictObject({
  changes: z.array(recordSchema),
  nextCursor: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export const mutationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    mutationId: idSchema,
    status: z.literal('applied'),
    records: z.array(recordSchema),
  }),
  z.strictObject({
    mutationId: idSchema,
    status: z.enum(['rejected', 'conflict']),
    code: z.string(),
    message: z.string(),
  }),
]);
export const pushResponseSchema = z.strictObject({ results: z.array(mutationResultSchema) });
export const signupSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
  ageConfirmed: z.literal(true),
  termsAccepted: z.literal(true),
});
export type Capture = z.infer<typeof captureSchema>;
export type Command = z.infer<typeof commandSchema>;
export type RecordItem = z.infer<typeof recordSchema>;
export type Mutation = z.infer<typeof syncPushSchema>['mutations'][number];
export type MutationResult = z.infer<typeof mutationResultSchema>;
