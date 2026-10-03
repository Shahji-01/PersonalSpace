import { useEffect, useRef, useState } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  searchQuerySchema,
  searchableTypes,
  type RecordItem,
  type SearchQuery,
  type SearchResponse,
} from '@personalspace/validation';
import type { createClient } from '@personalspace/api-client';
import { documentText } from '@personalspace/editor-schema';
import { Button, Card, Field, styles } from './components';
import type { LocalStore } from './store';

const labels = { note: 'Notes', task: 'Tasks', project: 'Projects', inbox: 'Inbox', reminder: 'Reminders', learning_resource: 'Learning' };
export function SearchScreen({
  store,
  client,
  records,
  onClose,
  onOpen,
}: {
  store: LocalStore;
  client: ReturnType<typeof createClient>;
  records: RecordItem[];
  onClose: () => void;
  onOpen: (record: RecordItem) => void;
}) {
  const [q, setQ] = useState('');
  const [type, setType] = useState<SearchQuery['type']>();
  const [tag, setTag] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState<SearchQuery['status']>();
  const [projectId, setProjectId] = useState<string>();
  const [folderId, setFolderId] = useState<string>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filters, setFilters] = useState(false);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  useEffect(
    () => setOffset(0),
    [q, type, tag, from, to, status, projectId, folderId, includeArchived],
  );
  const [groups, setGroups] = useState<SearchResponse['groups']>([]);
  const [message, setMessage] = useState('Search your notes, tasks, projects and Inbox.');
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    setSelected(null);
    if (!q.trim()) {
      setGroups([]);
      setMessage('Search your notes, tasks, projects and Inbox.');
      return;
    }
    const parsed = searchQuerySchema.safeParse({
      q,
      type,
      tag: tag.trim() || undefined,
      from: from || undefined,
      to: to || undefined,
      status,
      projectId,
      folderId,
      includeArchived,
      limit: type ? limit : 3,
      offset: type ? offset : 0,
    });
    if (!parsed.success || (from && to && from > to)) {
      setGroups([]);
      setMessage('Check your filters. Dates use YYYY-MM-DD and must be in order.');
      return;
    }
    let active = true;
    const run = async () => {
      try {
        const local = await store.search(parsed.data);
        if (!active || sequence.current !== current) return;
        setGroups(local.groups);
        setMessage('Searching online… Local matches are ready.');
        try {
          const remote = await client.search(parsed.data);
          if (!active || sequence.current !== current) return;
          const safe = await store.cacheSearch(remote);
          const fresh = await store.search(parsed.data);
          if (!active || sequence.current !== current) return;
          setGroups(
            (type ? [type] : searchableTypes).map((groupType) => {
              const a = fresh.groups.find((g) => g.type === groupType);
              const b = safe.groups.find((g) => g.type === groupType);
              const merged = new Map<string, RecordItem>();
              for (const record of [...(b?.records ?? []), ...(a?.records ?? [])])
                merged.set(record.id, record);
              const all = [...merged.values()];
              return {
                type: groupType,
                records: all.slice(0, parsed.data.limit),
                hasMore: !!a?.hasMore || !!b?.hasMore || all.length > parsed.data.limit,
              };
            }),
          );
          setMessage('Local and online results');
        } catch {
          if (active && sequence.current === current)
            setMessage('Offline or server unavailable · showing local matches');
        }
      } catch {
        if (active && sequence.current === current) {
          setGroups([]);
          setMessage('Could not search local storage. Close and try again.');
        }
      }
    };
    const timer = setTimeout(() => void run(), 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    q,
    type,
    tag,
    from,
    to,
    status,
    projectId,
    folderId,
    includeArchived,
    limit,
    offset,
    store,
    client,
  ]);
  const projects = records.filter((r) => r.type === 'project' && !r.deletedAt);
  const folders = records.filter((r) => r.type === 'folder' && !r.deletedAt);
  function clearFilters() {
    setType(undefined);
    setTag('');
    setFrom('');
    setTo('');
    setStatus(undefined);
    setProjectId(undefined);
    setFolderId(undefined);
    setIncludeArchived(false);
    setLimit(20);
  }
  if (selected)
    return (
      <SafeAreaView style={styles.root}>
        <ScrollView contentContainerStyle={styles.page}>
          <Text style={styles.eyebrow}>{labels[selected.type as keyof typeof labels]}</Text>
          <Text selectable style={styles.subtitle}>
            {selected.text}
          </Text>
          {selected.descriptionJson && (
            <Text selectable style={styles.subtitle}>
              {documentText(selected.descriptionJson)}
            </Text>
          )}
          <Button
            label="Open item"
            disabled={selected.version === 0}
            onPress={() => onOpen(selected)}
          />
          <Button secondary label="Back to results" onPress={() => setSelected(null)} />
        </ScrollView>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.row}>
          <Text style={styles.title}>Search</Text>
          <Button secondary label="Close" onPress={onClose} />
        </View>
        <Field
          label="Search your space"
          value={q}
          onChangeText={setQ}
          maxLength={200}
          autoFocus
          returnKeyType="search"
          placeholder="Words, titles or tags"
        />
        <ScrollView horizontal contentContainerStyle={styles.row}>
          <Button
            secondary={!!type}
            label="All"
            onPress={() => {
              setType(undefined);
              setLimit(20);
            }}
          />
          {searchableTypes.map((value) => (
            <Button
              key={value}
              secondary={type !== value}
              label={labels[value]}
              onPress={() => {
                setType(value);
                setLimit(20);
              }}
            />
          ))}
        </ScrollView>
        <View style={styles.row}>
          <Button
            secondary
            label={filters ? 'Hide filters' : 'Filters'}
            onPress={() => setFilters(!filters)}
          />
          <Button secondary label="Clear filters" onPress={clearFilters} />
        </View>
        {filters && (
          <Card>
            <Field
              label="Tag"
              value={tag}
              onChangeText={setTag}
              maxLength={30}
              placeholder="Without #"
            />
            <Field
              label="Created from (UTC date)"
              value={from}
              onChangeText={setFrom}
              placeholder="YYYY-MM-DD"
              maxLength={10}
            />
            <Field
              label="Created through (UTC date)"
              value={to}
              onChangeText={setTo}
              placeholder="YYYY-MM-DD"
              maxLength={10}
            />
            <View style={styles.row}>
              <Text style={styles.label}>Include archived</Text>
              <Switch
                accessibilityLabel="Include archived"
                value={includeArchived}
                onValueChange={setIncludeArchived}
              />
            </View>
            <Text style={styles.label}>Status</Text>
            <ScrollView horizontal contentContainerStyle={styles.row}>
              <Button secondary={!status} label="Any status" onPress={() => setStatus(undefined)} />
              {(
                ['todo', 'in_progress', 'done', 'cancelled', 'active', 'archived', 'new'] as const
              ).map((value) => (
                <Button
                  key={value}
                  secondary={status !== value}
                  label={value.replaceAll('_', ' ')}
                  onPress={() => {
                    setStatus(value);
                    if (value === 'archived') setIncludeArchived(true);
                  }}
                />
              ))}
            </ScrollView>
            <Text style={styles.label}>Project</Text>
            <ScrollView horizontal contentContainerStyle={styles.row}>
              <Button secondary label="Any project" onPress={() => setProjectId(undefined)} />
              {projects.map((p) => (
                <Button
                  key={p.id}
                  secondary={projectId !== p.id}
                  label={p.text}
                  onPress={() => {
                    setProjectId(p.id);
                    setType('task');
                    setFolderId(undefined);
                  }}
                />
              ))}
            </ScrollView>
            <Text style={styles.label}>Folder</Text>
            <ScrollView horizontal contentContainerStyle={styles.row}>
              <Button secondary label="Any folder" onPress={() => setFolderId(undefined)} />
              {folders.map((f) => (
                <Button
                  key={f.id}
                  secondary={folderId !== f.id}
                  label={f.text}
                  onPress={() => {
                    setFolderId(f.id);
                    setType('note');
                    setProjectId(undefined);
                  }}
                />
              ))}
            </ScrollView>
          </Card>
        )}
        <Text accessibilityLiveRegion="polite" style={styles.subtitle}>
          {message}
        </Text>
        {type && offset > 0 && (
          <Button
            secondary
            label="Previous results"
            onPress={() => setOffset(Math.max(0, offset - limit))}
          />
        )}
        {q.trim() && groups.every((g) => g.records.length === 0) && (
          <Text style={styles.subtitle}>
            Nothing matches “{q}”. Try fewer words or clear filters.
          </Text>
        )}
        {groups
          .filter((g) => g.records.length > 0)
          .map((group) => (
            <View key={group.type} style={{ gap: 12 }}>
              <Text style={styles.eyebrow}>{labels[group.type]}</Text>
              {group.records.map((record) => (
                <Card key={record.id}>
                  <Text style={styles.label}>{record.text.slice(0, 160)}</Text>
                  {record.type === 'task' && record.descriptionJson && (
                    <Text numberOfLines={2} style={styles.subtitle}>
                      {documentText(record.descriptionJson).slice(0, 300)}
                    </Text>
                  )}
                  <Text style={styles.subtitle}>
                    {record.status.replaceAll('_', ' ')}
                    {record.tags.length ? ` · ${record.tags.map((t) => `#${t}`).join(' ')}` : ''}
                  </Text>
                  <Button secondary label="View result" onPress={() => setSelected(record)} />
                </Card>
              ))}
              {group.hasMore && (
                <Button
                  secondary
                  label={!type ? `See all ${labels[group.type].toLowerCase()}` : 'Next results'}
                  disabled={offset + limit > 10000}
                  onPress={() => {
                    if (type) setOffset(offset + limit);
                    else {
                      setType(group.type);
                      setLimit(20);
                    }
                  }}
                />
              )}
            </View>
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}
