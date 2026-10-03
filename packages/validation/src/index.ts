import { z } from 'zod';
export {
  attachmentLimits,
  attachmentMimeSchema,
  attachmentDescriptorSchema,
  attachmentTransferSchema,
  attachmentUploadStateSchema,
  uploadedPartSchema,
  type AttachmentDescriptor,
  type AttachmentTransfer,
  type AttachmentUploadState,
  type UploadedPart,
} from './attachments';
import { noteDocumentSchema, noteReferenceIds } from '@personalspace/editor-schema';
export { folderPlacementIssue } from './folders';
export { searchQuerySchema, searchTokens, searchableTypes, type SearchQuery } from './search';
import { searchableTypeSchema } from './search';
import { deadlineSchema, timeZoneSchema, wallTimeSchema } from './time';
import { recurrenceSetupSchema, recurrenceRecordSchema } from './recurrence';
export {
  recurrenceSetupSchema,
  recurrenceRRule,
  firstOccurrence,
  nextOccurrence,
  shiftCalendarDate,
  calendarDayOffset,
  recurringInstant,
  taskEditOperations,
  type RecurrenceSetup,
} from './recurrence';
export {
  deadlineSchema,
  fixedDeadlineInstant,
  deadlineInstant,
  deadlineLocalDate,
  deadlineLabel,
  currentTimeZone,
  DeadlineTimeError,
  reminderTimeSchema,
  computeFireAt,
  computeSnoozeUntil,
  type Deadline,
  type ReminderTime,
} from './time';

export const idSchema = z.uuidv7();
export const dateSchema = z.iso.date();
export const captureTypeSchema = z.enum(['inbox', 'note', 'task']);
export const projectColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Choose a six-digit hex color.');
// Tags are normalized to lowercase, trimmed, de-duplicated, and order-preserving so the same
// label is never stored twice and the request hash is stable regardless of client input order.
export const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(30)
      .regex(/^[^\s]+(?: [^\s]+)*$/, 'Tags cannot start or end with spaces.'),
  )
  .max(20)
  .transform((values) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
      const normalized = value.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
    return result;
  });
export const captureSchema = z
  .strictObject({
    id: idSchema,
    type: captureTypeSchema.default('inbox'),
    text: z.string().trim().min(1).max(20000),
    plannedDate: dateSchema.nullable().default(null),
    dueDate: dateSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type !== 'task' && value.dueDate != null)
      ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Only tasks have a deadline.' });
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
export const snoozeDurationSchema = z.enum(['10min', '1h', 'evening', 'tomorrow_morning']);
export type SnoozeDuration = z.infer<typeof snoozeDurationSchema>;
export const resourceTypeSchema = z.enum([
  'youtube_video', 'youtube_playlist', 'article', 'website', 'documentation',
  'course', 'pdf', 'book', 'podcast', 'other',
]);
export type ResourceType = z.infer<typeof resourceTypeSchema>;
export const resourceSourceSchema = z.enum(['youtube', 'web', 'pdf', 'book', 'share', 'manual']);
export const learningStatusSchema = z.enum([
  'saved', 'want_to_learn', 'in_progress', 'completed', 'paused', 'archived',
]);
export type LearningStatus = z.infer<typeof learningStatusSchema>;
export const progressModeSchema = z.enum(['auto', 'manual']);
export const metadataStatusSchema = z.enum(['pending', 'ok', 'failed']);
export const commandSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('reminder.create'),
    id: idSchema,
    entityId: idSchema.nullable().default(null),
    title: z.string().trim().min(1).max(500),
    remindDate: dateSchema,
    remindTime: wallTimeSchema,
    timeMode: z.enum(['floating', 'fixed']),
    timezone: timeZoneSchema,
  }),
  z.strictObject({
    op: z.literal('reminder.update'),
    id: idSchema,
    title: z.string().trim().min(1).max(500).optional(),
    remindDate: dateSchema.optional(),
    remindTime: wallTimeSchema.optional(),
    timeMode: z.enum(['floating', 'fixed']).optional(),
    timezone: timeZoneSchema.optional(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.snooze'),
    id: idSchema,
    duration: snoozeDurationSchema,
    currentTimezone: timeZoneSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.dismiss'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.done'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.cancel'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.restore'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('reminder.purge'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  // --- Learning collection commands ---
  z.strictObject({
    op: z.literal('collection.create'),
    id: idSchema,
    name: z.string().trim().min(1).max(200),
    parentId: idSchema.nullable().default(null),
  }),
  z.strictObject({
    op: z.literal('collection.rename'),
    id: idSchema,
    name: z.string().trim().min(1).max(200),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('collection.move'),
    id: idSchema,
    parentId: idSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('collection.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  // --- Learning resource commands ---
  z.strictObject({
    op: z.literal('resource.save'),
    id: idSchema,
    url: z.string().url().max(2048).nullable().default(null),
    title: z.string().trim().min(1).max(500),
    resourceType: resourceTypeSchema,
    source: resourceSourceSchema.default('manual'),
    collectionId: idSchema.nullable().default(null),
    externalId: z.string().max(200).nullable().default(null),
  }),
  z.strictObject({
    op: z.literal('resource.update'),
    id: idSchema,
    title: z.string().trim().min(1).max(500).optional(),
    author: z.string().trim().max(300).nullable().optional(),
    description: z.string().trim().max(10000).nullable().optional(),
    resourceType: resourceTypeSchema.optional(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('resource.setStatus'),
    id: idSchema,
    status: learningStatusSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('resource.setProgress'),
    id: idSchema,
    progressPercent: z.number().int().min(0).max(100),
    progressSeconds: z.number().int().min(0).nullable().default(null),
    progressMode: progressModeSchema.default('manual'),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('resource.setCollection'),
    id: idSchema,
    collectionId: idSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('resource.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('resource.restore'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('resource.purge'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.copyDraft'),
    id: idSchema,
    sourceId: idSchema,
    sourceBaseVersion: z.number().int().nonnegative(),
    contentJson: noteDocumentSchema,
    contentSchemaVersion: z.literal(1),
  }),
  z.strictObject({
    op: z.literal('task.setRecurrence'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
    recurrence: recurrenceSetupSchema.nullable(),
  }),
  z.strictObject({ op: z.literal('capture'), payload: captureSchema }),
  z.strictObject({
    op: z.literal('task.setDeadline'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    deadline: deadlineSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.openDaily'),
    id: idSchema,
    date: dateSchema,
  }),
  z.strictObject({
    op: z.literal('task.updateDescription'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    contentJson: noteDocumentSchema.refine(
      (content) => noteReferenceIds(content).length === 0,
      'Note references are supported in notes only.',
    ),
    contentSchemaVersion: z.literal(1),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.setEstimate'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    estimatedMinutes: z.number().int().min(1).max(525600).nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.setArchived'),
    id: idSchema,
    archived: z.boolean(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('project.create'),
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    color: projectColorSchema,
  }),
  z.strictObject({
    op: z.literal('project.setNotes'),
    id: idSchema,
    noteIds: z
      .array(idSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each note only once.'),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('project.update'),
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    color: projectColorSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('project.setArchived'),
    id: idSchema,
    archived: z.boolean(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('project.move'),
    id: idSchema,
    beforeId: idSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.setProject'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    projectId: idSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('folder.create'),
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    parentId: idSchema.nullable(),
  }),
  z.strictObject({
    op: z.literal('folder.rename'),
    id: idSchema,
    name: z.string().trim().min(1).max(100),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('folder.move'),
    id: idSchema,
    parentId: idSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('folder.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.setFolder'),
    id: idSchema,
    folderId: idSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.complete'),
    currentTimezone: timeZoneSchema.optional(),
    occurredAt: z.iso.datetime().optional(),
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
    op: z.literal('note.updateContent'),
    id: idSchema,
    contentJson: noteDocumentSchema,
    contentSchemaVersion: z.literal(1),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.checkpoint'),
    id: idSchema,
    contentJson: noteDocumentSchema,
    contentSchemaVersion: z.literal(1),
    baseVersion: z.number().int().nonnegative(),
    reason: z.enum(['interval', 'session_end']),
  }),
  z.strictObject({
    op: z.literal('note.restoreVersion'),
    id: idSchema,
    versionId: idSchema,
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
    scope: z.enum(['occurrence', 'future']).optional(),
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
    scope: z.enum(['occurrence', 'future']).optional(),
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
  z.strictObject({
    op: z.literal('item.setTags'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    tags: tagsSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('inbox.delete'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('inbox.restore'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('inbox.purge'),
    id: idSchema,
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.setPriority'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    priority: z.number().int().min(0).max(4),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.setDueDate'),
    scope: z.enum(['occurrence', 'future']).optional(),
    id: idSchema,
    dueDate: dateSchema.nullable(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.setPinned'),
    id: idSchema,
    pinned: z.boolean(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.setFavorite'),
    id: idSchema,
    favorite: z.boolean(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('note.setArchived'),
    id: idSchema,
    archived: z.boolean(),
    baseVersion: z.number().int().nonnegative(),
  }),
  z.strictObject({
    op: z.literal('task.setStatus'),
    currentTimezone: timeZoneSchema.optional(),
    occurredAt: z.iso.datetime().optional(),
    id: idSchema,
    status: z.enum(['todo', 'in_progress', 'done', 'cancelled']),
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
  recurrence: recurrenceRecordSchema.nullable().default(null),
  type: z.enum(['inbox', 'note', 'task', 'folder', 'project', 'reminder', 'collection', 'learning_resource']),
  text: z.string(),
  contentJson: noteDocumentSchema.nullable().optional(),
  contentSchemaVersion: z.literal(1).optional(),
  status: z.enum([
    'new',
    'converted',
    'todo',
    'in_progress',
    'done',
    'cancelled',
    'active',
    'archived',
    'scheduled',
    'fired',
    'snoozed',
    'dismissed',
    'want_to_learn',
    'completed',
    'paused',
  ]),
  plannedDate: dateSchema.nullable(),
  dueDate: dateSchema.nullable().default(null),
  dueTime: wallTimeSchema.nullable().default(null),
  timeMode: z.enum(['floating', 'fixed']).default('floating'),
  timezone: timeZoneSchema.nullable().default(null),
  dueAt: z.iso.datetime().nullable().default(null),
  priority: z.number().int().min(0).max(4).default(0),
  parentId: idSchema.nullable().default(null),
  folderId: idSchema.nullable().default(null),
  kind: z.enum(['note', 'checklist', 'daily', 'voice']).default('note'),
  dailyDate: dateSchema.nullable().default(null),
  recoveredFromId: idSchema.nullable().default(null),
  projectId: idSchema.nullable().default(null),
  relatedNoteIds: z.array(idSchema).default([]),
  color: projectColorSchema.nullable().default(null),
  // Fractional positions are used only by the offline optimistic ordering; the
  // authoritative project command compacts positions to integers in PostgreSQL.
  sortOrder: z.number().default(0),
  completedAt: z.iso.datetime().nullable().default(null),
  descriptionJson: noteDocumentSchema.nullable().default(null),
  descriptionSchemaVersion: z.literal(1).default(1),
  estimatedMinutes: z.number().int().min(1).max(525600).nullable().default(null),
  pinned: z.boolean().default(false),
  favorite: z.boolean().default(false),
  archivedAt: z.iso.datetime().nullable().default(null),
  tags: z.array(z.string()).default([]),
  entityId: idSchema.nullable().default(null),
  remindDate: dateSchema.nullable().default(null),
  remindTime: wallTimeSchema.nullable().default(null),
  fireAt: z.iso.datetime().nullable().default(null),
  snoozedUntil: z.iso.datetime().nullable().default(null),
  lastFiredAt: z.iso.datetime().nullable().default(null),
  // --- Learning fields ---
  collectionId: idSchema.nullable().default(null),
  url: z.string().nullable().default(null),
  resourceType: resourceTypeSchema.nullable().default(null),
  resourceSource: resourceSourceSchema.nullable().default(null),
  externalId: z.string().nullable().default(null),
  parentResourceId: idSchema.nullable().default(null),
  positionInParent: z.number().int().nullable().default(null),
  author: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  thumbnailUrl: z.string().nullable().default(null),
  durationSeconds: z.number().int().nullable().default(null),
  progressPercent: z.number().int().min(0).max(100).default(0),
  progressSeconds: z.number().int().nullable().default(null),
  progressMode: progressModeSchema.nullable().default(null),
  metadataStatus: metadataStatusSchema.nullable().default(null),
  lastOpenedAt: z.iso.datetime().nullable().default(null),
  version: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export const tombstoneSchema = z.strictObject({
  id: idSchema,
  version: z.number().int().positive(),
  purgedAt: z.iso.datetime(),
});
export const searchResponseSchema = z.strictObject({
  groups: z.array(
    z.strictObject({
      type: searchableTypeSchema,
      records: z.array(recordSchema),
      hasMore: z.boolean(),
    }),
  ),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
export type Tombstone = z.infer<typeof tombstoneSchema>;
export const noteVersionSchema = z.strictObject({
  id: idSchema,
  noteId: idSchema,
  version: z.number().int().positive(),
  title: z.string(),
  contentJson: noteDocumentSchema,
  contentSchemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  reason: z.enum(['session_end', 'interval', 'restore']),
});
export type NoteVersion = z.infer<typeof noteVersionSchema>;
export const noteHistoryResponseSchema = z.strictObject({
  versions: z.array(noteVersionSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export const pullResponseSchema = z.strictObject({
  changes: z.array(recordSchema),
  tombstones: z.array(tombstoneSchema).default([]),
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
