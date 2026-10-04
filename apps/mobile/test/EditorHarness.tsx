import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import NoteEditor from '../src/NoteEditor';
import { plainTextDocument, readDocument } from '@personalspace/editor-schema';

const draft = localStorage.getItem('draft');
function Harness() {
  const [title, setTitle] = useState('Reading notes');
  const [conflicted, setConflicted] = useState(false);
  const [fileRemoved, setFileRemoved] = useState(false);
  useEffect(() => {
    const rename = () => setTitle('Renamed reading notes');
    const conflict = () => setConflicted(true);
    const removeFile = () => setFileRemoved(true);
    window.addEventListener('renameReference', rename);
    window.addEventListener('noteConflict', conflict);
    window.addEventListener('removeFile', removeFile);
    return () => {
      window.removeEventListener('renameReference', rename);
      window.removeEventListener('noteConflict', conflict);
      window.removeEventListener('removeFile', removeFile);
    };
  }, []);
  return (
    <NoteEditor
      attachments={
        fileRemoved
          ? []
          : [
              {
                id: '0199a1b0-0000-7000-8000-000000000011',
                filename: 'Journey notes — यात्रा.pdf',
                detail: '1.20 MB · Kept offline',
                canInsert: true,
                canOpen: true,
              },
              {
                id: '0199a1b0-0000-7000-8000-000000000012',
                filename:
                  'Very-long-document-name-without-spaces-for-a-phone-width-overflow-check.pdf',
                detail: '2.50 MB · Processing',
                canInsert: true,
                canOpen: false,
              },
            ]
      }
      onOpenAttachment={async (id) => {
        if (localStorage.getItem('failOpenFile'))
          return 'Could not open this file. Try again when online.';
        localStorage.setItem('openedFile', id);
        return null;
      }}
      onAddAttachment={async () => {
        localStorage.setItem('pickedFile', 'true');
        return null;
      }}
      conflicted={conflicted}
      onSaveCopy={
        conflicted
          ? async (content) => {
              if (localStorage.getItem('failCopy')) return 'Could not queue your draft copy.';
              localStorage.setItem('copied', JSON.stringify(content));
              return null;
            }
          : undefined
      }
      referenceNotes={[
        {
          id: '0199a1b0-0000-7000-8000-000000000001',
          title,
          context: 'First reference',
          canLink: true,
        },
        {
          id: '0199a1b0-0000-7000-8000-000000000002',
          title: 'Reading notes',
          context: 'Second reference',
          canLink: true,
        },
      ]}
      linkedFrom={[
        {
          id: '0199a1b0-0000-7000-8000-000000000003',
          title: 'Weekly review',
          context: '',
          canLink: true,
        },
      ]}
      onOpenNote={async (id) => {
        localStorage.setItem('openedNote', id);
        return null;
      }}
      initialContent={
        draft
          ? readDocument(JSON.parse(draft))
          : plainTextDocument('A clearer day\nOne small step.')
      }
      recovered={!!draft}
      onCheckpoint={async (content, reason) => {
        if (localStorage.getItem('failCheckpoint')) throw new Error('Queue unavailable');
        const checkpoints = JSON.parse(localStorage.getItem('checkpoints') ?? '[]');
        checkpoints.push({ content, reason });
        localStorage.setItem('checkpoints', JSON.stringify(checkpoints));
      }}
      onDraft={async (content) => {
        if (localStorage.getItem('failDraft')) throw new Error('Storage unavailable');
        localStorage.setItem('draft', JSON.stringify(content));
      }}
      onSave={async (content) => {
        localStorage.setItem('saved', JSON.stringify(content));
        return null;
      }}
      onClose={async () => {
        localStorage.setItem('closed', 'true');
      }}
      onDiscard={async () => {
        localStorage.removeItem('draft');
      }}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
