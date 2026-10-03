import { describe, expect, it } from 'vitest';
import {
  documentMarkdown,
  documentText,
  hasFormatting,
  isSafeNoteLink,
  MAX_NOTE_CHARACTERS,
  noteDocumentSchema,
  plainTextDocument,
  readDocument,
  noteReferenceIds,
} from './index';

describe('canonical note documents', () => {
  it('preserves stable reference IDs, deduplicates links and rejects malformed reference attributes', () => {
    const id = '0199a1b0-0000-7000-8000-000000000001';
    const ref = { type: 'noteReference' as const, attrs: { noteId: id } };
    const doc = readDocument({
      type: 'doc',
      content: [{ type: 'paragraph', content: [ref, ref] }],
    });
    expect(noteReferenceIds(doc)).toEqual([id]);
    expect(hasFormatting(doc)).toBe(true);
    expect(documentText(doc)).toBe('[[Note]][[Note]]');
    expect(documentMarkdown(doc)).toBe(`[[note:${id}]][[note:${id}]]`);
    for (const attrs of [
      { noteId: 'not-a-uuid' },
      { noteId: id, title: 'Untrusted title' },
      { noteId: id, href: 'https://example.test' },
    ])
      expect(
        noteDocumentSchema.safeParse({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ ...ref, attrs }] }],
        }).success,
      ).toBe(false);
  });
  it('accepts the nullable title attribute emitted by the installed link extension', () => {
    const doc = plainTextDocument('Link');
    doc.content = [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: 'Link',
            marks: [
              {
                type: 'link',
                attrs: {
                  href: 'https://example.test',
                  title: null,
                  target: '_blank',
                  rel: 'noopener noreferrer nofollow',
                  class: null,
                },
              },
            ],
          },
        ],
      },
    ];
    expect(readDocument(doc)).toEqual(doc);
  });
  it('reads legacy paragraphs without losing blank lines or Hindi text', () => {
    const text = 'मेरी नोटबुक\n\nA little space.\n';
    const document = readDocument(plainTextDocument(text));
    expect(documentText(document)).toBe(text);
    expect(hasFormatting(document)).toBe(false);
    expect(() => readDocument(document, 2)).toThrow('Update the app');
  });
  it('retains headings, marks, lists, checklists and code while deriving text', () => {
    const document = readDocument({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Read', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'Rest' },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3, type: null },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Walk' }] }],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: null },
          content: [{ type: 'text', text: 'const value = 1;' }],
        },
      ],
    });
    expect(documentText(document)).toBe('Plan\nRead\nRest\nWalk\nDone\nconst value = 1;');
    expect(documentMarkdown(document)).toContain('## Plan');
    expect(documentMarkdown(document)).toContain('3. Walk');
    expect(documentMarkdown(document)).toContain('- [x] Done');
    expect(hasFormatting(document)).toBe(true);
  });
  it('rejects executable links, unknown attributes and malformed list structure', () => {
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.test',
      'https://a.test\n',
    ])
      expect(isSafeNoteLink(href)).toBe(false);
    for (const href of ['https://example.test/path', 'mailto:hello@example.test'])
      expect(isSafeNoteLink(href)).toBe(true);
    expect(
      noteDocumentSchema.safeParse({ ...plainTextDocument('hi'), onload: 'bad' }).success,
    ).toBe(false);
    expect(
      noteDocumentSchema.safeParse({
        type: 'doc',
        content: [{ type: 'bulletList', content: [{ type: 'paragraph' }] }],
      }).success,
    ).toBe(false);
    expect(
      noteDocumentSchema.safeParse({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'link',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('bounds untrusted trees before recursion and supports a 5000-word note', () => {
    expect(noteDocumentSchema.safeParse(plainTextDocument('hello '.repeat(5000))).success).toBe(
      true,
    );
    expect(
      noteDocumentSchema.safeParse(plainTextDocument('x'.repeat(MAX_NOTE_CHARACTERS + 1))).success,
    ).toBe(false);
    let node: unknown = { type: 'paragraph' };
    for (let i = 0; i < 1000; i++) node = { type: 'blockquote', content: [node] };
    expect(noteDocumentSchema.safeParse({ type: 'doc', content: [node] }).success).toBe(false);
  });
  it('exports literal HTML as escaped text and fences embedded backticks', () => {
    expect(documentMarkdown(plainTextDocument('<script>alert(1)</script>'))).toBe(
      '\\<script\\>alert(1)\\</script\\>',
    );
    const document = readDocument({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: '```' }] }],
    });
    expect(documentMarkdown(document)).toBe('````\n```\n````');
  });
});
