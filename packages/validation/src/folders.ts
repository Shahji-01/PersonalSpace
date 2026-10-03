type FolderNode = { id: string; parentId: string | null };
export type FolderPlacementIssue = 'FOLDER_CYCLE' | 'FOLDER_DEPTH' | 'FOLDER_NOT_FOUND';

// Shared by the offline picker and authoritative service. The server supplies only
// the current user's folders and serializes mutations before checking this graph.
export function folderPlacementIssue(
  folders: FolderNode[],
  id: string,
  parentId: string | null,
): FolderPlacementIssue | null {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string, string[]>();
  for (const folder of folders)
    if (folder.parentId) {
      const siblings = children.get(folder.parentId) ?? [];
      siblings.push(folder.id);
      children.set(folder.parentId, siblings);
    }
  let parent = parentId;
  let depth = 1;
  const seen = new Set([id]);
  while (parent) {
    if (seen.has(parent)) return 'FOLDER_CYCLE';
    seen.add(parent);
    const folder = byId.get(parent);
    if (!folder) return 'FOLDER_NOT_FOUND';
    depth++;
    parent = folder.parentId;
  }
  const descendants = [{ id, depth }];
  for (let i = 0; i < descendants.length; i++) {
    const current = descendants[i]!;
    if (current.depth > 3) return 'FOLDER_DEPTH';
    for (const child of children.get(current.id) ?? [])
      descendants.push({ id: child, depth: current.depth + 1 });
  }
  return null;
}
