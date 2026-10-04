'use dom';

import { useEffect, useRef, useState } from 'react';
import { Editor, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {
  isSafeNoteLink,
  noteDocumentSchema,
  type NoteDocument,
} from '@personalspace/editor-schema';
import './note-editor.css';
import type { ReferenceNote } from './note-links';
import type { NoteAttachment } from './note-attachments';

type Props = {
  label?: string;
  initialContent: NoteDocument;
  recovered: boolean;
  onDraft: (content: NoteDocument) => Promise<void>;
  onSave: (content: NoteDocument) => Promise<string | null>;
  onSaveCopy?: (content: NoteDocument) => Promise<string | null>;
  conflicted?: boolean;
  recoveredFromId?: string | null;
  onClose: () => Promise<void>;
  onDiscard: () => Promise<void>;
  closeRequest?: number;
  onCheckpoint?: (content: NoteDocument, reason: 'interval' | 'session_end') => Promise<void>;
  referenceNotes?: ReferenceNote[];
  linkedFrom?: ReferenceNote[];
  onOpenNote?: (id: string) => Promise<string | null>;
  attachments?: NoteAttachment[];
  onOpenAttachment?: (id: string) => Promise<string | null>;
  onAddAttachment?: () => Promise<string | null>;
  dom?: import('expo/dom').DOMProps;
};

export default function NoteEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<Editor | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [, redraw] = useState(0);
  const [status, setStatus] = useState(
    props.recovered
      ? 'Recovered your draft on this device.'
      : props.onCheckpoint
        ? 'Drafts stay local; history checkpoints sync every 10 minutes and on close.'
        : 'Your draft stays on this device until you save.',
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const linkSelection = useRef<{ from: number; to: number } | null>(null);
  const revision = useRef(0);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const referenceSelection = useRef<{ from: number; to: number } | null>(null);
  const navigate = useRef<(id: string) => void>(() => {});
  const openAttachment = useRef<(id: string) => void>(() => {});
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState('');
  const attachmentSelection = useRef<{ from: number; to: number } | null>(null);
  const previousCloseRequest = useRef(props.closeRequest);
  useEffect(() => {
    if (previousCloseRequest.current === props.closeRequest) return;
    previousCloseRequest.current = props.closeRequest;
    void finish(false);
  }, [props.closeRequest]);
  const lastCheckpoint = useRef(props.recovered ? '' : JSON.stringify(props.initialContent));
  const checkpointWork = useRef<Promise<void>>(Promise.resolve());
  const intervalCheckpoint = useRef<() => void>(() => {});
  async function checkpoint(content: NoteDocument, reason: 'interval' | 'session_end') {
    if (!callbacks.current.onCheckpoint) return;
    const work = checkpointWork.current.then(async () => {
      const serialized = JSON.stringify(content);
      if (lastCheckpoint.current === serialized) return;
      await callbacks.current.onCheckpoint!(content, reason);
      lastCheckpoint.current = serialized;
    });
    checkpointWork.current = work.catch(() => {});
    await work;
  }
  intervalCheckpoint.current = () => {
    if (
      busy ||
      !instance.current ||
      document.visibilityState === 'hidden' ||
      !callbacks.current.onCheckpoint
    )
      return;
    const parsed = noteDocumentSchema.safeParse(instance.current.getJSON());
    if (!parsed.success) return;
    if (JSON.stringify(parsed.data) === lastCheckpoint.current) return;
    const currentRevision = revision.current;
    void callbacks.current
      .onDraft(parsed.data)
      .then(() => checkpoint(parsed.data, 'interval'))
      .then(() => {
        if (currentRevision === revision.current)
          setStatus('Draft saved. History checkpoint queued for sync.');
      })
      .catch(() =>
        setError(
          'Could not queue a history checkpoint. Your draft is preserved; try Save changes.',
        ),
      );
  };
  useEffect(() => {
    const timer = setInterval(() => intervalCheckpoint.current(), 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  function refreshReferenceTitles() {
    for (const element of Array.from(
      host.current?.querySelectorAll<HTMLElement>('[data-note-reference]') ?? [],
    )) {
      const id = element.dataset.noteReference;
      const target = callbacks.current.referenceNotes?.find((note) => note.id === id);
      element.textContent = target ? `[[${target.title}]]` : '[[Unavailable note]]';
      element.setAttribute(
        'aria-label',
        target ? `Open note: ${target.title}` : 'Unavailable note',
      );
    }
  }

  useEffect(refreshReferenceTitles, [props.referenceNotes]);
  function refreshAttachmentLabels() {
    for (const element of Array.from(
      host.current?.querySelectorAll<HTMLElement>('[data-attachment-reference]') ?? [],
    )) {
      const file = callbacks.current.attachments?.find(
        (item) => item.id === element.dataset.attachmentReference,
      );
      const name = element.querySelector('.file-name'),
        detail = element.querySelector('.file-detail');
      if (name) name.textContent = file?.filename ?? 'Unavailable file';
      if (detail) detail.textContent = file?.detail ?? 'Removed or not synced to this device';
      element.setAttribute(
        'aria-label',
        file ? `Open file: ${file.filename}. ${file.detail}` : 'Unavailable file',
      );
      element.setAttribute('aria-disabled', String(!file?.canOpen));
    }
  }
  useEffect(refreshAttachmentLabels, [props.attachments]);

  useEffect(() => {
    const initial = callbacks.current.initialContent;
    const next = new Editor({
      element: host.current!,
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          horizontalRule: false,
          strike: false,
          underline: false,
          link: {
            openOnClick: false,
            autolink: false,
            linkOnPaste: false,
            isAllowedUri: isSafeNoteLink,
          },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Node.create({
          name: 'attachmentReference',
          group: 'inline',
          inline: true,
          atom: true,
          addAttributes: () => ({
            attachmentId: {
              default: null,
              parseHTML: (element) => element.getAttribute('data-attachment-reference'),
              renderHTML: (attributes) => ({
                'data-attachment-reference': attributes.attachmentId,
              }),
            },
          }),
          parseHTML: () => [{ tag: 'span[data-attachment-reference]' }],
          renderHTML: ({ node }) => {
            const file = callbacks.current.attachments?.find(
              (item) => item.id === node.attrs.attachmentId,
            );
            return [
              'span',
              {
                'data-attachment-reference': node.attrs.attachmentId,
                role: 'button',
                tabindex: '0',
                class: 'attachment-reference',
                'aria-disabled': String(!file?.canOpen),
                'aria-label': file
                  ? `Open file: ${file.filename}. ${file.detail}`
                  : 'Unavailable file',
              },
              ['span', { class: 'file-icon', 'aria-hidden': 'true' }, '↗'],
              [
                'span',
                { class: 'file-caption' },
                ['span', { class: 'file-name' }, file?.filename ?? 'Unavailable file'],
                [
                  'span',
                  { class: 'file-detail' },
                  file?.detail ?? 'Removed or not synced to this device',
                ],
              ],
            ];
          },
          renderText: () => '[[File]]',
        }),
        Node.create({
          name: 'noteReference',
          group: 'inline',
          inline: true,
          atom: true,
          addAttributes: () => ({
            noteId: {
              default: null,
              parseHTML: (element) => element.getAttribute('data-note-reference'),
              renderHTML: (attributes) => ({ 'data-note-reference': attributes.noteId }),
            },
          }),
          parseHTML: () => [{ tag: 'span[data-note-reference]' }],
          renderHTML: ({ node }) => [
            'span',
            {
              'data-note-reference': node.attrs.noteId,
              role: 'link',
              tabindex: '0',
              class: 'note-reference',
            },
            `[[${callbacks.current.referenceNotes?.find((note) => note.id === node.attrs.noteId)?.title ?? 'Unavailable note'}]]`,
          ],
          renderText: () => '[[Note]]',
        }),
      ],
      content: initial,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': `${callbacks.current.label ?? 'Note'} content`,
          'aria-multiline': 'true',
          spellcheck: 'true',
        },
        handleDOMEvents: {
          click: (_view, event) => {
            const file = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-attachment-reference]',
            );
            if (file?.dataset.attachmentReference) {
              event.preventDefault();
              openAttachment.current(file.dataset.attachmentReference);
              return true;
            }
            const reference = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-note-reference]',
            );
            if (reference?.dataset.noteReference) {
              event.preventDefault();
              navigate.current(reference.dataset.noteReference);
              return true;
            }
            // Tapping a link must never navigate the editor away from an unsaved draft.
            if ((event.target as HTMLElement).closest('a')) event.preventDefault();
            return false;
          },
          keydown: (_view, event) => {
            const file = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-attachment-reference]',
            );
            if (file?.dataset.attachmentReference && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              openAttachment.current(file.dataset.attachmentReference);
              return true;
            }
            const reference = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-note-reference]',
            );
            if (reference?.dataset.noteReference && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              navigate.current(reference.dataset.noteReference);
              return true;
            }
            return false;
          },
        },
      },
      onTransaction: () => redraw((value) => value + 1),
      onUpdate: ({ editor: current }) => {
        if (
          callbacks.current.referenceNotes &&
          !current.isActive('codeBlock') &&
          !current.isActive('code')
        ) {
          const { $from, empty, from } = current.state.selection;
          const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
          const match = empty && before.match(/\[\[([^\]\n\u005B]*)(?:\]\])?$/);
          if (match) {
            referenceSelection.current = { from: from - match[0].length, to: from };
            setReferenceQuery(match[1] ?? '');
            setReferenceOpen(true);
          } else setReferenceOpen(false);
        }
        const thisRevision = ++revision.current;
        const parsed = noteDocumentSchema.safeParse(current.getJSON());
        if (!parsed.success) {
          setError(parsed.error.issues[0]?.message ?? 'This formatting is not supported.');
          return;
        }
        setError('');
        setStatus('Saving draft…');
        void callbacks.current
          .onDraft(parsed.data)
          .then(() => {
            if (thisRevision === revision.current) setStatus('Draft saved on this device.');
          })
          .catch(() => {
            if (thisRevision === revision.current)
              setError('Could not save this draft. Keep this screen open and try Save changes.');
          });
      },
    });
    instance.current = next;
    setEditor(next);
    return () => {
      instance.current = null;
      next.destroy();
    };
  }, []);

  async function finish(save: boolean, openId?: string, copy = false) {
    if (!instance.current || busy) return;
    const parsed = noteDocumentSchema.safeParse(instance.current.getJSON());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check your note.');
      return;
    }
    setBusy(true);
    ++revision.current;
    instance.current.setEditable(false, false);
    try {
      await callbacks.current.onDraft(parsed.data);
      await checkpointWork.current;
      if (!save) await checkpoint(parsed.data, 'session_end');
      setError('');
      setStatus('Draft saved on this device.');
      if (openId) {
        const failure = await callbacks.current.onOpenNote?.(openId);
        if (failure) setError(failure);
      } else if (save) {
        const failure = await (copy
          ? callbacks.current.onSaveCopy?.(parsed.data)
          : callbacks.current.onSave(parsed.data));
        if (failure) setError(failure);
      } else await callbacks.current.onClose();
    } catch {
      setError('Your changes are still here. Could not save; please try again.');
    } finally {
      setBusy(false);
      instance.current?.setEditable(true, false);
    }
  }
  navigate.current = (id) => {
    void finish(false, id);
  };
  openAttachment.current = (id) => {
    if (!instance.current || busy) return;
    const file = callbacks.current.attachments?.find((item) => item.id === id);
    if (!file?.canOpen) {
      setError(
        file
          ? 'This file is not ready to open yet.'
          : 'This file is unavailable. Its label stays in your note.',
      );
      return;
    }
    const parsed = noteDocumentSchema.safeParse(instance.current.getJSON());
    if (!parsed.success) {
      setError('Check your note before opening the file.');
      return;
    }
    setBusy(true);
    ++revision.current;
    instance.current.setEditable(false, false);
    void (async () => {
      try {
        await callbacks.current.onDraft(parsed.data);
        setError('');
        setStatus('Draft saved on this device.');
        const failure = await callbacks.current.onOpenAttachment?.(id);
        if (failure) setError(failure);
      } catch {
        setError('Your changes are still here. Could not save; please try again.');
      } finally {
        setBusy(false);
        instance.current?.setEditable(true, false);
      }
    })();
  };
  async function addAttachment() {
    if (!instance.current || busy || !callbacks.current.onAddAttachment) return;
    const parsed = noteDocumentSchema.safeParse(instance.current.getJSON());
    if (!parsed.success) {
      setError('Check your note before adding a file.');
      return;
    }
    setBusy(true);
    ++revision.current;
    instance.current.setEditable(false, false);
    try {
      await callbacks.current.onDraft(parsed.data);
      setStatus('Draft saved on this device.');
      setError('');
      const failure = await callbacks.current.onAddAttachment();
      if (failure) setError(failure);
    } catch {
      setError('Your changes are still here. Could not save; please try again.');
    } finally {
      setBusy(false);
      instance.current?.setEditable(true, false);
    }
  }

  const tools = editor
    ? [
        {
          label: 'Bold',
          text: 'B',
          active: editor.isActive('bold'),
          run: () => editor.chain().focus().toggleBold().run(),
        },
        {
          label: 'Italic',
          text: 'I',
          active: editor.isActive('italic'),
          run: () => editor.chain().focus().toggleItalic().run(),
        },
        ...([1, 2, 3] as const).map((level) => ({
          label: `Heading ${level}`,
          text: `H${level}`,
          active: editor.isActive('heading', { level }),
          run: () => editor.chain().focus().toggleHeading({ level }).run(),
        })),
        {
          label: 'Bullet list',
          text: '• List',
          active: editor.isActive('bulletList'),
          run: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          label: 'Numbered list',
          text: '1. List',
          active: editor.isActive('orderedList'),
          run: () => editor.chain().focus().toggleOrderedList().run(),
        },
        {
          label: 'Checklist',
          text: '☑ List',
          active: editor.isActive('taskList'),
          run: () => editor.chain().focus().toggleTaskList().run(),
        },
        {
          label: 'Quote',
          text: '“ Quote',
          active: editor.isActive('blockquote'),
          run: () => editor.chain().focus().toggleBlockquote().run(),
        },
        {
          label: 'Inline code',
          text: '</>',
          active: editor.isActive('code'),
          run: () => editor.chain().focus().toggleCode().run(),
        },
        {
          label: 'Code block',
          text: '{ }',
          active: editor.isActive('codeBlock'),
          run: () => editor.chain().focus().toggleCodeBlock().run(),
        },
        {
          label: 'Link',
          text: 'Link',
          active: editor.isActive('link'),
          run: () => {
            linkSelection.current = {
              from: editor.state.selection.from,
              to: editor.state.selection.to,
            };
            setLink(String(editor.getAttributes('link').href ?? 'https://'));
            setLinkOpen(true);
            return true;
          },
        },
        {
          label: 'Undo',
          text: '↶',
          disabled: !editor.can().undo(),
          run: () => editor.chain().focus().undo().run(),
        },
        {
          label: 'Redo',
          text: '↷',
          disabled: !editor.can().redo(),
          run: () => editor.chain().focus().redo().run(),
        },
      ]
    : [];
  if (editor && props.referenceNotes)
    tools.splice(tools.length - 2, 0, {
      label: 'Link note',
      text: '[[ Note ]]',
      disabled: false,
      run: () => {
        referenceSelection.current = {
          from: editor.state.selection.from,
          to: editor.state.selection.to,
        };
        setReferenceQuery('');
        setReferenceOpen(true);
        return true;
      },
    });

  return (
    <main className="note-editor">
      <header>
        <div>
          <p className="eyebrow">YOUR NOTE</p>
          <h1>Make it yours.</h1>
        </div>
        <button disabled={busy} onClick={() => void finish(false)}>
          Close
        </button>
      </header>
      <div className="toolbar" role="toolbar" aria-label={`${props.label ?? 'Note'} formatting`}>
        {tools.map((tool) => (
          <button
            key={tool.label}
            aria-label={tool.label}
            aria-pressed={tool.active}
            disabled={busy || tool.disabled}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => tool.run()}
          >
            {tool.text}
          </button>
        ))}
      </div>
      {props.attachments && (
        <div className="attachment-tools">
          <button
            disabled={busy || !editor || editor.isActive('codeBlock') || editor.isActive('code')}
            aria-expanded={attachmentOpen}
            aria-controls="attachment-picker"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (!editor) return;
              attachmentSelection.current = {
                from: editor.state.selection.from,
                to: editor.state.selection.to,
              };
              setAttachmentQuery('');
              setAttachmentOpen(!attachmentOpen);
              setReferenceOpen(false);
              setLinkOpen(false);
            }}
          >
            Insert file
          </button>
          <span>Files stay linked to their original upload.</span>
        </div>
      )}
      {attachmentOpen && (
        <section
          id="attachment-picker"
          className="reference-picker attachment-picker"
          aria-label="Choose a file"
        >
          <label htmlFor="attachment-search">Files attached to this note</label>
          <input
            id="attachment-search"
            autoFocus
            value={attachmentQuery}
            placeholder="Find a file by name"
            onChange={(event) => setAttachmentQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setAttachmentOpen(false);
                editor?.commands.focus();
              }
            }}
          />
          <div className="reference-results">
            {(props.attachments ?? [])
              .filter(
                (file) =>
                  file.canInsert &&
                  file.filename
                    .toLocaleLowerCase()
                    .includes(attachmentQuery.trim().toLocaleLowerCase()),
              )
              .slice(0, 50)
              .map((file) => (
                <button
                  key={file.id}
                  disabled={busy}
                  onClick={() => {
                    if (!editor || !attachmentSelection.current) return;
                    const inserted = editor
                      .chain()
                      .focus()
                      .insertContentAt(attachmentSelection.current, {
                        type: 'attachmentReference',
                        attrs: { attachmentId: file.id },
                      })
                      .run();
                    if (!inserted) {
                      setError('Place the cursor in a paragraph to insert a file.');
                      return;
                    }
                    setAttachmentOpen(false);
                  }}
                >
                  {file.filename}
                  <small>{file.detail}</small>
                </button>
              ))}
          </div>
          {!(props.attachments ?? []).some(
            (file) =>
              file.canInsert &&
              file.filename
                .toLocaleLowerCase()
                .includes(attachmentQuery.trim().toLocaleLowerCase()),
          ) && (
            <p className="picker-empty">
              {attachmentQuery.trim()
                ? 'No matching files. Try another name.'
                : props.onAddAttachment
                  ? 'No files here yet. Add a file below; it will appear when it syncs.'
                  : 'No files to insert yet. Choose Files on this note in Library to add an upload.'}
            </p>
          )}
          <p className="picker-hint">
            Removing a file label from your text keeps the uploaded file. Manage uploads in Files.
          </p>
          <div className="actions">
            {props.onAddAttachment && (
              <button className="primary" disabled={busy} onClick={() => void addAttachment()}>
                {busy ? 'Working…' : 'Add file'}
              </button>
            )}
            <button
              onClick={() => {
                setAttachmentOpen(false);
                editor?.commands.focus();
              }}
            >
              Done
            </button>
          </div>
        </section>
      )}
      {linkOpen && (
        <form
          className="link-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isSafeNoteLink(link.trim())) {
              setError('Enter a full https, http, or mailto link.');
              return;
            }
            if (editor && linkSelection.current) {
              const { from, to } = linkSelection.current;
              const chain = editor
                .chain()
                .focus()
                .setTextSelection({ from, to })
                .extendMarkRange('link');
              if (from === to && !editor.isActive('link'))
                chain
                  .insertContent({
                    type: 'text',
                    text: link.trim(),
                    marks: [{ type: 'link', attrs: { href: link.trim() } }],
                  })
                  .run();
              else chain.setLink({ href: link.trim() }).run();
            }
            setError('');
            setLinkOpen(false);
          }}
        >
          <label htmlFor="note-link">Link address</label>
          <input
            id="note-link"
            type="url"
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
          <div className="actions">
            <button type="submit">Apply link</button>
            <button
              type="button"
              onClick={() => {
                editor?.chain().focus().unsetLink().run();
                setLinkOpen(false);
              }}
            >
              Remove link
            </button>
            <button type="button" onClick={() => setLinkOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {referenceOpen && (
        <section className="reference-picker" aria-label="Choose a note">
          <label htmlFor="reference-search">Find a note to link</label>
          <input
            id="reference-search"
            value={referenceQuery}
            disabled={busy}
            onChange={(event) => setReferenceQuery(event.target.value)}
          />
          <div className="reference-results">
            {(props.referenceNotes ?? [])
              .filter(
                (note) =>
                  note.canLink &&
                  note.title
                    .toLocaleLowerCase()
                    .includes(referenceQuery.trim().toLocaleLowerCase()),
              )
              .slice(0, 30)
              .map((note) => (
                <button
                  key={note.id}
                  disabled={busy}
                  onClick={() => {
                    if (editor && referenceSelection.current)
                      editor
                        .chain()
                        .focus()
                        .insertContentAt(referenceSelection.current, {
                          type: 'noteReference',
                          attrs: { noteId: note.id },
                        })
                        .run();
                    setReferenceOpen(false);
                  }}
                >
                  <strong>{note.title}</strong>
                  <small>{note.context}</small>
                </button>
              ))}
            {!(props.referenceNotes ?? []).some(
              (note) =>
                note.canLink &&
                note.title.toLocaleLowerCase().includes(referenceQuery.trim().toLocaleLowerCase()),
            ) && <p>No matching synced notes. Create a note and sync it first.</p>}
          </div>
          <button
            disabled={busy}
            onClick={() => {
              setReferenceOpen(false);
              editor?.commands.focus();
            }}
          >
            Cancel note link
          </button>
        </section>
      )}
      <div className="editor-scroll">
        <div ref={host} />
        {props.recoveredFromId && (
          <section className="linked-from" aria-label="Recovered draft">
            <h2>Recovered draft copy</h2>
            <button disabled={busy} onClick={() => void finish(false, props.recoveredFromId!)}>
              Open original note
            </button>
          </section>
        )}
        {props.linkedFrom && (
          <section className="linked-from" aria-label="Linked from">
            <h2>Linked from</h2>
            {!props.linkedFrom.length && <p>No notes link here yet.</p>}
            {props.linkedFrom.map((note) => (
              <button
                key={note.id}
                disabled={busy || !note.canLink}
                onClick={() => void finish(false, note.id)}
              >
                {note.title}
              </button>
            ))}
          </section>
        )}
      </div>
      <footer>
        {props.conflicted && (
          <p role="alert">
            This note changed elsewhere. Your draft is preserved
            {props.onSaveCopy ? '; save it as a separate note to keep both versions.' : '.'}
          </p>
        )}
        {props.onCheckpoint && (
          <p>History checkpoints sync automatically. Save changes updates the note.</p>
        )}
        <p role="status">{status}</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button
            className="primary"
            disabled={!editor || busy || props.conflicted}
            onClick={() => void finish(true)}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {props.onSaveCopy && (
            <button
              className="primary"
              disabled={!editor || busy}
              onClick={() => void finish(true, undefined, true)}
            >
              Save as separate note
            </button>
          )}
          <button disabled={busy} onClick={() => void props.onDiscard()}>
            Discard draft
          </button>
        </div>
      </footer>
    </main>
  );
}
