import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  commandSchema,
  recordSchema,
  type Command,
  type RecordItem,
} from '@personalspace/validation';
import { Button, Card, Field, styles } from './components';
import { newId, type LocalStore } from './store';

const palette = [
  { name: 'Forest', color: '#275D48' },
  { name: 'Blue', color: '#3563A5' },
  { name: 'Plum', color: '#85547C' },
  { name: 'Amber', color: '#996315' },
  { name: 'Coral', color: '#B24E43' },
  { name: 'Slate', color: '#566473' },
];

export function ProjectScreen({
  records,
  pendingIds,
  store,
  task,
  onClose,
  onChanged,
  onViewTasks,
  onViewNotes,
  onViewResources,
}: {
  records: RecordItem[];
  pendingIds: string[];
  store: LocalStore;
  task?: RecordItem | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onViewTasks: (id: string) => void;
  onViewNotes: (project: RecordItem) => void;
  onViewResources: (project: RecordItem) => void;
}) {
  const projects = records
    .filter((r) => r.type === 'project' && !r.deletedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(palette[0]!.color);
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = projects.find((r) => r.id === editingId);
  const pending = (r: RecordItem) => r.version === 0 || pendingIds.includes(r.id);
  const visible = projects.filter((r) => (r.status === 'archived') === archived);

  async function enqueue(command: Command, optimistic?: RecordItem, previous?: RecordItem) {
    if (saving) return;
    const parsed = commandSchema.safeParse(command);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check your project.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await store.enqueue({ mutationId: newId(), command: parsed.data }, optimistic, previous);
      setEditingId(null);
      setName('');
      await onChanged();
      if (task) onClose();
    } catch {
      setError('Could not save this change. Wait for pending changes to sync and try again.');
    } finally {
      setSaving(false);
    }
  }

  function assign(projectId: string | null) {
    if (task)
      void enqueue(
        { op: 'task.setProject', id: task.id, projectId, baseVersion: task.version },
        { ...task, projectId },
        task,
      );
  }

  function save() {
    if (editing)
      void enqueue(
        { op: 'project.update', id: editing.id, name, color, baseVersion: editing.version },
        { ...editing, text: name.trim(), color },
        editing,
      );
    else {
      const id = newId();
      const now = new Date().toISOString();
      void enqueue(
        { op: 'project.create', id, name, color },
        recordSchema.parse({
          id,
          type: 'project',
          text: name.trim(),
          color,
          sortOrder: (projects.at(-1)?.sortOrder ?? -1) + 1,
          status: 'active',
          plannedDate: null,
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
      );
    }
  }

  function move(project: RecordItem, beforeId: string | null) {
    const others = projects.filter((p) => p.id !== project.id);
    const index = beforeId === null ? others.length : others.findIndex((p) => p.id === beforeId);
    const before = others[index];
    const previous = others[index - 1];
    const sortOrder = before
      ? ((previous?.sortOrder ?? before.sortOrder - 2) + before.sortOrder) / 2
      : (previous?.sortOrder ?? -1) + 1;
    void enqueue(
      { op: 'project.move', id: project.id, beforeId, baseVersion: project.version },
      { ...project, sortOrder },
      project,
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={styles.eyebrow}>PROJECTS</Text>
        <Text style={styles.title}>{task ? 'Give it a home.' : 'Work toward something.'}</Text>
        <Text style={styles.subtitle}>
          {task
            ? 'Your task and its subtasks stay together in one project.'
            : 'A place for tasks that belong together.'}
        </Text>
        <Button secondary label="Close" disabled={saving} onPress={onClose} />
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {task ? (
          <Card>
            <Button
              secondary
              label="No project"
              disabled={saving || pending(task)}
              onPress={() => assign(null)}
            />
            {projects
              .filter((p) => p.status === 'active')
              .map((p) => (
                <Button
                  key={p.id}
                  secondary={task.projectId !== p.id}
                  label={p.text}
                  disabled={saving || pending(task) || pending(p)}
                  onPress={() => assign(p.id)}
                />
              ))}
            {!projects.some((p) => p.status === 'active') && (
              <Text style={styles.subtitle}>
                Create a project from the task view to group your tasks.
              </Text>
            )}
          </Card>
        ) : (
          <>
            <Card>
              <Field
                label={editing ? 'Project name' : 'New project name'}
                maxLength={100}
                value={name}
                onChangeText={setName}
              />
              <Text style={styles.label}>Color</Text>
              <View style={styles.row}>
                {palette.map((option) => (
                  <Pressable
                    key={option.color}
                    accessibilityRole="button"
                    accessibilityLabel={option.name}
                    accessibilityState={{ selected: color === option.color }}
                    onPress={() => setColor(option.color)}
                    style={{
                      backgroundColor: option.color,
                      borderRadius: 12,
                      padding: 12,
                      minWidth: 48,
                      minHeight: 48,
                      borderWidth: 3,
                      borderColor: color === option.color ? '#17251E' : 'transparent',
                    }}
                  >
                    <Text style={{ color: 'white', fontWeight: '600' }}>{option.name}</Text>
                  </Pressable>
                ))}
              </View>
              <Button
                label={editing ? 'Save project' : 'Create project'}
                disabled={saving || !name.trim() || (!!editing && pending(editing))}
                onPress={save}
              />
              {editing && (
                <Button
                  secondary
                  label="Cancel edit"
                  onPress={() => {
                    setEditingId(null);
                    setName('');
                  }}
                />
              )}
            </Card>
            <View style={styles.row}>
              <Button secondary={archived} label="Active" onPress={() => setArchived(false)} />
              <Button secondary={!archived} label="Archived" onPress={() => setArchived(true)} />
            </View>
            {!visible.length && (
              <Text style={styles.subtitle}>
                {archived ? 'No archived projects.' : 'Start with one project. Small steps add up.'}
              </Text>
            )}
            {visible.map((project, index) => {
              const tasks = records.filter(
                (r) =>
                  r.type === 'task' && r.projectId === project.id && !r.parentId && !r.deletedAt,
              );
              const done = tasks.filter((r) => r.status === 'done').length;
              const closed = tasks.filter((r) => r.status === 'cancelled').length;
              return (
                <Card key={project.id}>
                  <View style={styles.row}>
                    <View
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 7,
                        backgroundColor: project.color ?? palette[0]!.color,
                      }}
                    />
                    <Text style={[styles.label, { flex: 1 }]}>{project.text}</Text>
                  </View>
                  <Text style={styles.subtitle}>
                    {done} of {tasks.length - closed} tasks done
                    {closed ? ` · ${closed} cancelled` : ''}
                    {pending(project) ? ' · Sync pending' : ''}
                  </Text>
                  <View style={styles.row}>
                    <Button secondary label="View tasks" onPress={() => onViewTasks(project.id)} />
                    <Button
                      secondary
                      label={`Related notes (${project.relatedNoteIds.length})`}
                      disabled={saving}
                      onPress={() => onViewNotes(project)}
                    />
                    <Button
                      secondary
                      label={`Related resources (${project.relatedResourceIds.length})`}
                      disabled={saving}
                      onPress={() => onViewResources(project)}
                    />
                    <Button
                      secondary
                      label="Edit project"
                      disabled={saving || pending(project)}
                      onPress={() => {
                        setEditingId(project.id);
                        setName(project.text);
                        setColor(project.color ?? palette[0]!.color);
                      }}
                    />
                    <Button
                      secondary
                      label={archived ? 'Unarchive' : 'Archive'}
                      disabled={saving || pending(project)}
                      onPress={() =>
                        void enqueue(
                          {
                            op: 'project.setArchived',
                            id: project.id,
                            archived: !archived,
                            baseVersion: project.version,
                          },
                          { ...project, status: archived ? 'active' : 'archived' },
                          project,
                        )
                      }
                    />
                    <Button
                      secondary
                      label="Move up"
                      disabled={saving || index === 0 || projects.some(pending)}
                      onPress={() => move(project, visible[index - 1]!.id)}
                    />
                    <Button
                      secondary
                      label="Move down"
                      disabled={saving || index === visible.length - 1 || projects.some(pending)}
                      onPress={() => move(project, visible[index + 2]?.id ?? null)}
                    />
                  </View>
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
