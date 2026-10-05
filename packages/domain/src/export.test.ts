import { describe, expect, it } from 'vitest';
import { v7 } from 'uuid';
import { plainTextDocument } from '@personalspace/editor-schema';
import { exportToCsv, exportToMarkdown, type ExportData } from './export';

const base: ExportData = { exportedAt: '2026-10-05T00:00:00.000Z', scope: 'everything' };
describe('portable export formats', () => {
  it('exports all selected CSV groups, preserves nested splits/content, escapes cells and protects formulas', () => {
    const files = exportToCsv({
      ...base,
      notes: [
        {
          id: v7(),
          title: '=HYPERLINK("private")',
          contentJson: plainTextDocument('नमस्ते,\r\n"quoted"'),
        },
      ],
      tasks: [
        { id: 'first', text: 'one' },
        { id: 'second', text: 'two', extra: 'later column' },
      ],
      learningResources: [{ id: v7(), title: ' +formula', createdAt: new Date(base.exportedAt) }],
      transactions: [
        { id: v7(), amountMinor: -125, splits: [{ amountMinor: 125, categoryId: 'food' }] },
      ],
      categories: [{ id: v7(), name: 'Food' }],
      projects: [{ id: v7(), name: 'Home' }],
    });
    expect(files['notes.csv']).toContain("'=HYPERLINK");
    expect(files['notes.csv']).toContain('नमस्ते');
    expect(files['notes.csv']).toContain('""type"":""doc""');
    expect(files['tasks.csv']).toContain('"extra","id","text"\r\n');
    expect(files['tasks.csv']).toContain('"later column"');
    expect(files['learningResources.csv']).toContain("' +formula");
    expect(files['learningResources.csv']).toContain(base.exportedAt);
    expect(files['transactions.csv']).toContain('"-125"');
    expect(files['transactions.csv']).toContain('""categoryId"":""food""');
    expect(files['categories.csv']).toContain('Food');
    expect(files['projects.csv']).toContain('Home');
  });
  it('renders canonical Markdown into stable folder paths without title collisions or traversal', () => {
    const folder = v7(),
      child = v7(),
      first = v7(),
      second = v7();
    const files = exportToMarkdown({
      ...base,
      folders: [
        { id: folder, name: '../Private' },
        { id: child, parentId: folder, name: 'यात्रा' },
      ],
      notes: [
        {
          id: first,
          folderId: child,
          title: '../../CON',
          contentJson: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Strong thought', marks: [{ type: 'bold' }] }],
              },
            ],
          },
        },
        {
          id: second,
          folderId: child,
          title: '../../CON',
          contentJson: plainTextDocument('Other note'),
        },
      ],
    });
    const prefix = `notes/folder-${folder}/folder-${child}/`;
    expect(files[`${prefix}note-${first}.md`]).toContain('**Strong thought**');
    expect(files[`${prefix}note-${second}.md`]).toContain('Other note');
    expect(files[`${prefix}README.md`]).toContain('यात्रा');
    expect(Object.keys(files).every((path) => !path.includes('..') && !path.includes('CON'))).toBe(
      true,
    );
    expect(() => exportToMarkdown({ ...base, notes: [{ id: '../escape' }] })).toThrow();
    expect(() =>
      exportToMarkdown({
        ...base,
        folders: [
          { id: folder, parentId: child },
          { id: child, parentId: folder },
        ],
      }),
    ).toThrow('hierarchy');
  });
});
