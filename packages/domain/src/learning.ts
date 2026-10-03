import { createHash } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { learningCollections, learningResources, type Transaction } from '@personalspace/db';
import { DomainError } from './errors';

// --- Collection helpers ---

export async function collectionFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(learningCollections)
      .where(
        and(
          eq(learningCollections.id, id),
          eq(learningCollections.userId, userId),
          isNull(learningCollections.deletedAt),
        ),
      )
  )[0];
}

export async function requireCollection(tx: Transaction, userId: string, id: string) {
  const collection = await collectionFor(tx, userId, id);
  if (!collection)
    throw new DomainError('COLLECTION_NOT_FOUND', 'This collection was not found.', 404);
  return collection;
}

/** Validate parent depth doesn't exceed max depth of 3. */
async function validateCollectionDepth(
  tx: Transaction,
  userId: string,
  parentId: string | null,
  selfId: string,
) {
  if (!parentId) return;
  let depth = 1;
  let current = parentId;
  while (current) {
    if (current === selfId)
      throw new DomainError('COLLECTION_CYCLE', 'Moving here would create a loop.', 422);
    depth++;
    if (depth > 3)
      throw new DomainError('COLLECTION_TOO_DEEP', 'Collections can be nested up to 3 levels.', 422);
    const parent = await collectionFor(tx, userId, current);
    if (!parent) break;
    current = parent.parentId!;
  }
}

export async function createCollection(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  name: string,
  parentId: string | null,
): Promise<string[]> {
  if (parentId) {
    await requireCollection(tx, userId, parentId);
    await validateCollectionDepth(tx, userId, parentId, id);
  }
  await tx.insert(learningCollections).values({
    id,
    userId,
    version,
    name,
    parentId,
  });
  return [id];
}

export async function renameCollection(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  name: string,
): Promise<string[]> {
  const collection = await requireCollection(tx, userId, id);
  if (collection.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This collection changed on another device. Refresh and try again.',
    );
  await tx
    .update(learningCollections)
    .set({ name, version, updatedAt: new Date() })
    .where(and(eq(learningCollections.id, id), eq(learningCollections.userId, userId)));
  return [id];
}

export async function moveCollection(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  parentId: string | null,
): Promise<string[]> {
  const collection = await requireCollection(tx, userId, id);
  if (collection.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This collection changed on another device. Refresh and try again.',
    );
  if (parentId) {
    await requireCollection(tx, userId, parentId);
    await validateCollectionDepth(tx, userId, parentId, id);
  }
  await tx
    .update(learningCollections)
    .set({ parentId, version, updatedAt: new Date() })
    .where(and(eq(learningCollections.id, id), eq(learningCollections.userId, userId)));
  return [id];
}

// --- Resource helpers ---

export async function resourceFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(learningResources)
      .where(
        and(
          eq(learningResources.id, id),
          eq(learningResources.userId, userId),
          isNull(learningResources.deletedAt),
        ),
      )
  )[0];
}

export async function trashedResourceFor(tx: Transaction, userId: string, id: string) {
  return (
    await tx
      .select()
      .from(learningResources)
      .where(
        and(
          eq(learningResources.id, id),
          eq(learningResources.userId, userId),
          isNotNull(learningResources.deletedAt),
        ),
      )
  )[0];
}

/** Compute a stable hash for URL deduplication. */
function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

export async function saveResource(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  input: {
    url: string | null;
    title: string;
    resourceType: string;
    source: string;
    collectionId: string | null;
    externalId: string | null;
  },
): Promise<string[]> {
  if (input.collectionId) await requireCollection(tx, userId, input.collectionId);

  // URL deduplication: check if same canonical URL already saved.
  const hash = input.url ? urlHash(input.url) : null;
  if (hash) {
    const [existing] = await tx
      .select({ id: learningResources.id })
      .from(learningResources)
      .where(
        and(
          eq(learningResources.userId, userId),
          eq(learningResources.urlHash, hash),
          isNull(learningResources.deletedAt),
          isNull(learningResources.parentResourceId),
        ),
      );
    if (existing)
      throw new DomainError(
        'URL_ALREADY_SAVED',
        'You have already saved this URL. Open the existing resource instead.',
        409,
      );
  }

  await tx.insert(learningResources).values({
    id,
    userId,
    version,
    url: input.url,
    canonicalUrl: input.url,
    urlHash: hash,
    title: input.title,
    resourceType: input.resourceType,
    source: input.source,
    collectionId: input.collectionId,
    externalId: input.externalId,
    status: 'saved',
    progressPercent: 0,
    progressMode: 'manual',
    metadataStatus: input.url ? 'pending' : 'ok',
  });
  return [id];
}

export async function updateResource(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  input: {
    title?: string;
    author?: string | null;
    description?: string | null;
    resourceType?: string;
  },
): Promise<string[]> {
  const resource = await resourceFor(tx, userId, id);
  if (!resource)
    throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not found.', 404);
  if (resource.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This resource changed on another device. Refresh and try again.',
    );

  const patch: Record<string, unknown> = { version, updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.author !== undefined) patch.author = input.author;
  if (input.description !== undefined) patch.description = input.description;
  if (input.resourceType !== undefined) patch.resourceType = input.resourceType;

  await tx
    .update(learningResources)
    .set(patch)
    .where(and(eq(learningResources.id, id), eq(learningResources.userId, userId)));
  return [id];
}

export async function setResourceStatus(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  status: string,
): Promise<string[]> {
  const resource = await resourceFor(tx, userId, id);
  if (!resource)
    throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not found.', 404);
  if (resource.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This resource changed on another device. Refresh and try again.',
    );

  const patch: Record<string, unknown> = { status, version, updatedAt: new Date() };
  if (status === 'completed') {
    patch.completedAt = new Date();
    patch.progressPercent = 100;
  }

  await tx
    .update(learningResources)
    .set(patch)
    .where(and(eq(learningResources.id, id), eq(learningResources.userId, userId)));
  return [id];
}

export async function setResourceProgress(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  progressPercent: number,
  progressSeconds: number | null,
  progressMode: string,
): Promise<string[]> {
  const resource = await resourceFor(tx, userId, id);
  if (!resource)
    throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not found.', 404);
  if (resource.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This resource changed on another device. Refresh and try again.',
    );

  const patch: Record<string, unknown> = {
    progressPercent,
    progressSeconds,
    progressMode,
    version,
    updatedAt: new Date(),
  };

  // Auto-complete at >= 90% for video resources.
  if (
    progressPercent >= 90 &&
    (resource.resourceType === 'youtube_video') &&
    resource.status !== 'completed'
  ) {
    patch.status = 'completed';
    patch.completedAt = new Date();
    patch.progressPercent = 100;
  }
  // If user manually set to in_progress status on first progress
  if (resource.status === 'saved' || resource.status === 'want_to_learn') {
    patch.status = 'in_progress';
  }

  await tx
    .update(learningResources)
    .set(patch)
    .where(and(eq(learningResources.id, id), eq(learningResources.userId, userId)));
  return [id];
}

export async function setResourceCollection(
  tx: Transaction,
  userId: string,
  id: string,
  version: number,
  baseVersion: number,
  collectionId: string | null,
): Promise<string[]> {
  const resource = await resourceFor(tx, userId, id);
  if (!resource)
    throw new DomainError('RESOURCE_NOT_FOUND', 'This resource was not found.', 404);
  if (resource.version !== baseVersion)
    throw new DomainError(
      'VERSION_CONFLICT',
      'This resource changed on another device. Refresh and try again.',
    );
  if (collectionId) await requireCollection(tx, userId, collectionId);

  await tx
    .update(learningResources)
    .set({ collectionId, version, updatedAt: new Date() })
    .where(and(eq(learningResources.id, id), eq(learningResources.userId, userId)));
  return [id];
}
