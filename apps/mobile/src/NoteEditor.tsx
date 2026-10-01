'use dom';

import { useEffect, useRef, useState } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {
  isSafeNoteLink,
  noteDocumentSchema,
  type NoteDocument,
} from '@personalspace/editor-schema';
import './note-editor.css';

type Props = {
  initialContent: NoteDocument;
  recovered: boolean;
  onDraft: (content: NoteDocument) => Promise<void>;
  onSave: (content: NoteDocument) => Promise<string | null>;
  onClose: () => Promise<void>;
  onDiscard: () => Promise<void>;
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
      : 'Your draft stays on this device until you save.',
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const revision = useRef(0);

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
      ],
      content: initial,
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-label': 'Note content',
          'aria-multiline': 'true',
          spellcheck: 'true',
        },
        handleDOMEvents: {
          click: (_view, event) => {
            // Tapping a link must never navigate the editor away from an unsaved draft.
            if ((event.target as HTMLElement).closest('a')) event.preventDefault();
            return false;
          },
        },
      },
      onTransaction: () => redraw((value) => value + 1),
      onUpdate: ({ editor: current }) => {
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

  async function finish(save: boolean) {
    if (!instance.current || busy) return;
    const parsed = noteDocumentSchema.safeParse(instance.current.getJSON());
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check your note.');
      return;
    }
    setBusy(true);
    instance.current.setEditable(false);
    try {
      await callbacks.current.onDraft(parsed.data);
      if (save) {
        const failure = await callbacks.current.onSave(parsed.data);
        if (failure) setError(failure);
      } else await callbacks.current.onClose();
    } catch {
      setError('Your changes are still here. Could not save; please try again.');
    } finally {
      setBusy(false);
      instance.current?.setEditable(true);
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
      <div className="toolbar" role="toolbar" aria-label="Note formatting">
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
      {linkOpen && (
        <form
          className="link-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!isSafeNoteLink(link.trim())) {
              setError('Enter a full https, http, or mailto link.');
              return;
            }
            editor?.chain().focus().extendMarkRange('link').setLink({ href: link.trim() }).run();
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
      <div className="editor-scroll">
        <div ref={host} />
      </div>
      <footer>
        <p role="status">{status}</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="actions">
          <button className="primary" disabled={!editor || busy} onClick={() => void finish(true)}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button disabled={busy} onClick={() => void props.onDiscard()}>
            Discard draft
          </button>
        </div>
      </footer>
    </main>
  );
}
