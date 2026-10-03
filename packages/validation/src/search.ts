import { z } from 'zod';

export const searchableTypeSchema = z.enum([
  'note', 'task', 'project', 'inbox', 'reminder', 'learning_resource',
  'person', 'transaction', 'category', 'account', 'debt',
]);
export const searchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  type: searchableTypeSchema.optional(),
  tag: z.string().trim().min(1).max(30).optional(),
  projectId: z.uuidv7().optional(),
  folderId: z.uuidv7().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z
    .enum([
      'todo', 'in_progress', 'done', 'cancelled', 'active', 'archived', 'new',
      'posted', 'pending', 'void', 'open', 'written_off', 'saved',
    ])
    .optional(),
  includeArchived: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(3),
  offset: z.number().int().min(0).max(10000).default(0),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export const searchableTypes = searchableTypeSchema.options;

// Treat user text as words, never as SQL/FTS operators. Marks are retained for Hindi.
export function searchTokens(value: string): string[] {
  return (
    value
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []
  ).slice(0, 20);
}
