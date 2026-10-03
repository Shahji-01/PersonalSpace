import { and, asc, eq, inArray } from 'drizzle-orm';
import { v7 } from 'uuid';
import { entities, projects, notes, entityLinks, type Transaction } from '@personalspace/db';
import type { Command } from '@personalspace/validation';
import { DomainError } from './errors';

type ProjectCommand = Extract<
  Command,
  {
    op:
      | 'project.create'
      | 'project.update'
      | 'project.setArchived'
      | 'project.move'
      | 'project.setNotes';
  }
>;

export async function requireProject(tx: Transaction, userId: string, id: string) {
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)));
  if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'This project was not found.', 404);
  return project;
}

export async function applyProjectCommand(
  tx: Transaction,
  userId: string,
  version: number,
  command: ProjectCommand,
): Promise<string[]> {
  const ordered = await tx
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(asc(projects.sortOrder), asc(projects.id));
  if (command.op === 'project.create') {
    const inserted = await tx
      .insert(entities)
      .values({ id: command.id, userId, type: 'project', version })
      .onConflictDoNothing()
      .returning({ id: entities.id });
    if (!inserted.length) throw new DomainError('ID_UNAVAILABLE', 'This item ID is unavailable.');
    await tx.insert(projects).values({
      id: command.id,
      userId,
      version,
      name: command.name,
      color: command.color,
      sortOrder: (ordered.at(-1)?.sortOrder ?? -1) + 1,
    });
    return [command.id];
  }
  const project = await requireProject(tx, userId, command.id);
  if (project.version !== command.baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This project changed on another device. Refresh and try again.',
    );
  if (command.op === 'project.setNotes') {
    const existing = await tx
      .select({ targetId: entityLinks.targetId })
      .from(entityLinks)
      .where(
        and(
          eq(entityLinks.userId, userId),
          eq(entityLinks.sourceId, project.id),
          eq(entityLinks.relation, 'related'),
        ),
      );
    const existingIds = new Set(existing.map((row) => row.targetId));
    const selected = command.noteIds.length
      ? await tx
          .select({ id: notes.id, deletedAt: notes.deletedAt })
          .from(notes)
          .where(and(eq(notes.userId, userId), inArray(notes.id, command.noteIds)))
      : [];
    if (
      selected.length !== command.noteIds.length ||
      selected.some((note) => note.deletedAt && !existingIds.has(note.id))
    )
      throw new DomainError(
        'NOTE_NOT_FOUND',
        'One of the selected notes is unavailable. Refresh and try again.',
        404,
      );
    await tx
      .delete(entityLinks)
      .where(
        and(
          eq(entityLinks.userId, userId),
          eq(entityLinks.sourceId, project.id),
          eq(entityLinks.relation, 'related'),
        ),
      );
    if (command.noteIds.length)
      await tx.insert(entityLinks).values(
        command.noteIds.map((targetId) => ({
          id: v7(),
          userId,
          sourceId: project.id,
          targetId,
          relation: 'related',
          version,
        })),
      );
    await tx
      .update(projects)
      .set({ version, updatedAt: new Date() })
      .where(and(eq(projects.id, project.id), eq(projects.userId, userId)));
    return [project.id];
  }
  if (command.op === 'project.move') {
    if (command.beforeId === command.id)
      throw new DomainError('INVALID_PROJECT_ORDER', 'Choose a different position.', 422);
    const next = ordered.filter((p) => p.id !== project.id);
    const index =
      command.beforeId === null ? next.length : next.findIndex((p) => p.id === command.beforeId);
    if (index < 0)
      throw new DomainError('PROJECT_NOT_FOUND', 'The destination project was not found.', 404);
    next.splice(index, 0, project);
    const changed: string[] = [];
    for (const [sortOrder, row] of next.entries())
      if (row.sortOrder !== sortOrder || row.id === project.id) {
        await tx
          .update(projects)
          .set({ sortOrder, version, updatedAt: new Date() })
          .where(and(eq(projects.id, row.id), eq(projects.userId, userId)));
        changed.push(row.id);
      }
    return changed;
  }
  await tx
    .update(projects)
    .set({
      ...(command.op === 'project.update'
        ? { name: command.name, color: command.color }
        : { status: command.archived ? 'archived' : 'active' }),
      version,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, project.id), eq(projects.userId, userId)));
  return [project.id];
}
