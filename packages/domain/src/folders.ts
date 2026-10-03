import { and, eq, isNull } from 'drizzle-orm';
import { entities, noteFolders, notes, type Transaction } from '@personalspace/db';
import { folderPlacementIssue, type Command } from '@personalspace/validation';
import { DomainError } from './errors';

type FolderCommand = Extract<
  Command,
  { op: 'folder.create' | 'folder.rename' | 'folder.move' | 'folder.delete' }
>;

export async function requireFolder(tx: Transaction, userId: string, id: string) {
  const [folder] = await tx
    .select()
    .from(noteFolders)
    .where(
      and(eq(noteFolders.id, id), eq(noteFolders.userId, userId), isNull(noteFolders.deletedAt)),
    );
  if (!folder) throw new DomainError('FOLDER_NOT_FOUND', 'This folder was not found.', 404);
  return folder;
}

async function checkPlacement(
  tx: Transaction,
  userId: string,
  id: string,
  parentId: string | null,
) {
  const folders = await tx
    .select({ id: noteFolders.id, parentId: noteFolders.parentId })
    .from(noteFolders)
    .where(eq(noteFolders.userId, userId));
  const issue = folderPlacementIssue(folders, id, parentId);
  if (issue)
    throw new DomainError(
      issue,
      {
        FOLDER_CYCLE: 'A folder cannot be placed inside itself.',
        FOLDER_DEPTH: 'Folders can be nested up to three levels.',
        FOLDER_NOT_FOUND: 'This folder was not found.',
      }[issue],
      issue === 'FOLDER_NOT_FOUND' ? 404 : 422,
    );
}

export async function applyFolderCommand(
  tx: Transaction,
  userId: string,
  version: number,
  command: FolderCommand,
) {
  if (command.op === 'folder.create') {
    await checkPlacement(tx, userId, command.id, command.parentId);
    const inserted = await tx
      .insert(entities)
      .values({ id: command.id, userId, type: 'folder', version })
      .onConflictDoNothing()
      .returning({ id: entities.id });
    if (!inserted.length) throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
    await tx
      .insert(noteFolders)
      .values({ id: command.id, userId, version, name: command.name, parentId: command.parentId });
    return;
  }
  const folder = await requireFolder(tx, userId, command.id);
  if (folder.version !== command.baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This folder changed on another device. Refresh and try again.',
    );
  if (command.op === 'folder.delete') {
    const [child] = await tx
      .select({ id: noteFolders.id })
      .from(noteFolders)
      .where(and(eq(noteFolders.userId, userId), eq(noteFolders.parentId, folder.id)))
      .limit(1);
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.userId, userId), eq(notes.folderId, folder.id)))
      .limit(1);
    if (child || note)
      throw new DomainError(
        'FOLDER_NOT_EMPTY',
        'Move notes (including archived or trashed notes) and subfolders out before deleting this folder.',
        422,
      );
    return; // The shared purge path removes the row and emits a deletion marker.
  }
  if (command.op === 'folder.move') await checkPlacement(tx, userId, folder.id, command.parentId);
  await tx
    .update(noteFolders)
    .set({
      ...(command.op === 'folder.rename' ? { name: command.name } : { parentId: command.parentId }),
      version,
      updatedAt: new Date(),
    })
    .where(and(eq(noteFolders.id, folder.id), eq(noteFolders.userId, userId)));
}
