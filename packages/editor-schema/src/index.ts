import { z } from 'zod';

export const CONTENT_SCHEMA_VERSION = 1;
export const MAX_NOTE_CHARACTERS = 100000;
export type Mark =
  | { type: 'bold' | 'italic' | 'code' }
  | {
      type: 'link';
      attrs: {
        href: string;
        target?: string | null;
        rel?: string | null;
        class?: null;
        title?: string | null;
      };
    };
export type InlineNode =
  | { type: 'text'; text: string; marks?: Mark[] }
  | { type: 'hardBreak' }
  | { type: 'noteReference'; attrs: { noteId: string }; marks?: Mark[] };
export type BlockNode =
  | { type: 'paragraph'; content?: InlineNode[] }
  | { type: 'heading'; attrs: { level: 1 | 2 | 3 }; content?: InlineNode[] }
  | {
      type: 'codeBlock';
      attrs?: { language?: string | null };
      content?: { type: 'text'; text: string }[];
    }
  | { type: 'blockquote'; content: BlockNode[] }
  | { type: 'bulletList'; content: ListItem[] }
  | { type: 'orderedList'; attrs?: { start?: number; type?: null }; content: ListItem[] }
  | { type: 'taskList'; content: TaskItem[] };
export type ListItem = { type: 'listItem'; content: BlockNode[] };
export type TaskItem = { type: 'taskItem'; attrs: { checked: boolean }; content: BlockNode[] };
export type NoteDocument = { type: 'doc'; content: BlockNode[] };
export type DocumentNode = NoteDocument | BlockNode | ListItem | TaskItem | InlineNode;

export function isSafeNoteLink(href: string): boolean {
  if (
    !href ||
    /\s/u.test(href) ||
    [...href].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return false;
  try {
    const url = new URL(href);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

const mark: z.ZodType<Mark> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  z.strictObject({ type: z.literal('code') }),
  z.strictObject({
    type: z.literal('link'),
    attrs: z.strictObject({
      href: z.string().max(2048).refine(isSafeNoteLink, 'Use an https, http, or mailto link.'),
      target: z.enum(['_blank', '_self']).nullable().optional(),
      rel: z.string().max(100).nullable().optional(),
      class: z.null().optional(),
      title: z.string().max(500).nullable().optional(),
    }),
  }),
]);
const textNode = z.strictObject({ type: z.literal('text'), text: z.string().min(1) });
const inline: z.ZodType<InlineNode> = z.discriminatedUnion('type', [
  textNode.extend({ marks: z.array(mark).max(4).optional() }),
  z.strictObject({ type: z.literal('hardBreak') }),
  z.strictObject({
    type: z.literal('noteReference'),
    attrs: z.strictObject({ noteId: z.uuid({ version: 'v7' }) }),
    marks: z.array(mark).max(4).optional(),
  }),
]);
const paragraph = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(inline).optional(),
});
const listContent = () =>
  z
    .array(block)
    .min(1)
    .refine((nodes) => nodes[0]?.type === 'paragraph', 'List items must start with a paragraph.');
const block: z.ZodType<BlockNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    paragraph,
    z.strictObject({
      type: z.literal('heading'),
      attrs: z.strictObject({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
      content: z.array(inline).optional(),
    }),
    z.strictObject({
      type: z.literal('codeBlock'),
      attrs: z.strictObject({ language: z.string().max(40).nullable().optional() }).optional(),
      content: z.array(textNode).optional(),
    }),
    z.strictObject({ type: z.literal('blockquote'), content: z.array(block).min(1) }),
    z.strictObject({
      type: z.literal('bulletList'),
      content: z
        .array(z.strictObject({ type: z.literal('listItem'), content: listContent() }))
        .min(1),
    }),
    z.strictObject({
      type: z.literal('orderedList'),
      attrs: z
        .strictObject({
          start: z.number().int().min(1).max(999999).optional(),
          type: z.null().optional(),
        })
        .optional(),
      content: z
        .array(z.strictObject({ type: z.literal('listItem'), content: listContent() }))
        .min(1),
    }),
    z.strictObject({
      type: z.literal('taskList'),
      content: z
        .array(
          z.strictObject({
            type: z.literal('taskItem'),
            attrs: z.strictObject({ checked: z.boolean() }),
            content: listContent(),
          }),
        )
        .min(1),
    }),
  ]),
);

// Check resource bounds before recursive parsing. Untrusted documents cannot overflow the stack.
const bounded = z.unknown().superRefine((value, ctx) => {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let characters = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (++nodes > 10000 || entry.depth > 16 || characters > MAX_NOTE_CHARACTERS) {
      ctx.addIssue({ code: 'custom', message: 'This note is too large or too deeply nested.' });
      return;
    }
    if (!entry.value || typeof entry.value !== 'object') continue;
    const node = entry.value as { text?: unknown; content?: unknown };
    if (typeof node.text === 'string') characters += node.text.length;
    if (Array.isArray(node.content)) {
      if (node.content.length > 10000) {
        ctx.addIssue({ code: 'custom', message: 'This note has too many blocks.' });
        return;
      }
      for (const child of node.content) stack.push({ value: child, depth: entry.depth + 1 });
    }
  }
  if (characters > MAX_NOTE_CHARACTERS)
    ctx.addIssue({
      code: 'custom',
      message: `Notes can contain up to ${MAX_NOTE_CHARACTERS} characters.`,
    });
});
export const noteDocumentSchema = bounded.pipe(
  z.strictObject({
    type: z.literal('doc'),
    content: z.array(block).min(1),
  }),
);

export function plainTextDocument(text: string): NoteDocument {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}

export function documentText(node: DocumentNode): string {
  if (node.type === 'noteReference') return '[[Note]]';
  if (node.type === 'text') return node.text;
  if (node.type === 'hardBreak') return '\n';
  const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n';
  return (node.content ?? []).map(documentText).join(separator);
}

// Existing plain-text notes already use the v1 paragraph subset. Future migrations belong here;
// unknown versions must never be flattened or silently rewritten by an older client.
export function readDocument(value: unknown, version = CONTENT_SCHEMA_VERSION): NoteDocument {
  if (version !== CONTENT_SCHEMA_VERSION)
    throw new Error('Update the app to open this note format.');
  return noteDocumentSchema.parse(value);
}

export function hasFormatting(document: NoteDocument): boolean {
  return document.content.some(
    (node) =>
      node.type !== 'paragraph' ||
      node.content?.some((child) => child.type !== 'text' || !!child.marks?.length),
  );
}

export function documentMarkdown(node: DocumentNode): string {
  if (node.type === 'noteReference') return `[[note:${node.attrs.noteId}]]`;
  if (node.type === 'hardBreak') return '  \n';
  if (node.type === 'text') {
    let result = node.text.replace(/([\\`*_{}[\]<>#!|])/g, '\\$1');
    if (node.marks?.some((m) => m.type === 'code')) {
      const fence = '`'.repeat(
        Math.max(0, ...(node.text.match(/`+/g) ?? []).map((s) => s.length)) + 1,
      );
      result = `${fence} ${node.text} ${fence}`;
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') result = `**${result}**`;
      if (mark.type === 'italic') result = `*${result}*`;
      if (mark.type === 'link')
        result = `[${result}](<${mark.attrs.href.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
    }
    return result;
  }
  const children = (node.content ?? []).map(documentMarkdown);
  if (node.type === 'paragraph') return children.join('');
  if (node.type === 'heading') return `${'#'.repeat(node.attrs.level)} ${children.join('')}`;
  if (node.type === 'codeBlock') {
    const text = documentText(node);
    const fence = '`'.repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length)) + 1);
    return `${fence}\n${text}\n${fence}`;
  }
  if (node.type === 'blockquote')
    return children
      .join('\n\n')
      .split('\n')
      .map((s) => `> ${s}`)
      .join('\n');
  if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
    return children
      .map((text, i) => {
        const prefix =
          node.type === 'orderedList'
            ? `${(node.attrs?.start ?? 1) + i}. `
            : node.type === 'taskList'
              ? `- [${node.content[i]!.attrs.checked ? 'x' : ' '}] `
              : '- ';
        return prefix + text.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
      })
      .join('\n');
  }
  return children.join('\n\n');
}

// References store only stable IDs. Display titles are resolved from the current
// account's records, so renames never rewrite another note or its history.
export function noteReferenceIds(node: DocumentNode): string[] {
  const ids = new Set<string>();
  function visit(current: DocumentNode) {
    if (current.type === 'noteReference') ids.add(current.attrs.noteId);
    else if ('content' in current) for (const child of current.content ?? []) visit(child);
  }
  visit(node);
  return [...ids].sort();
}
