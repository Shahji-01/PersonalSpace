import { Text, View, type TextStyle } from 'react-native';
import type { BlockNode, InlineNode, NoteDocument } from '@personalspace/editor-schema';
import { colors } from '@personalspace/ui';
import type { RecordItem } from '@personalspace/validation';

function inline(nodes: InlineNode[] = [], records: RecordItem[] = []) {
  return nodes.slice(0, 100).map((node, index) => {
    if (node.type === 'hardBreak') return '\n';
    const style: TextStyle = {};
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') style.fontWeight = '700';
      if (mark.type === 'italic') style.fontStyle = 'italic';
      if (mark.type === 'code') {
        style.fontFamily = 'monospace';
        style.backgroundColor = '#EDF0E8';
      }
      if (mark.type === 'link') {
        style.color = colors.primary;
        style.textDecorationLine = 'underline';
      }
    }
    if (node.type === 'noteReference') {
      const target = records.find(
        (record) => record.id === node.attrs.noteId && record.type === 'note' && !record.deletedAt,
      );
      return (
        <Text key={index} style={[style, { color: colors.primary }]}>
          [[{target?.text.split('\n')[0] || 'Unavailable note'}]]
        </Text>
      );
    }
    if (node.type === 'attachmentReference') {
      const file = records.find(
        (record) =>
          record.id === node.attrs.attachmentId &&
          record.type === 'attachment' &&
          !record.deletedAt,
      );
      const parent = records.find(
        (record) => record.id === file?.parentId && record.type === 'note' && !record.deletedAt,
      );
      return (
        <Text key={index} style={[style, { color: colors.primary }]}>
          [File: {parent && file?.attachment ? file.attachment.filename : 'Unavailable file'}]
        </Text>
      );
    }
    return (
      <Text key={index} style={style}>
        {node.text.slice(0, 600)}
      </Text>
    );
  });
}

function block(
  node: BlockNode,
  key: number,
  depth = 0,
  records: RecordItem[] = [],
): React.ReactNode {
  if (depth > 3) return <Text key={key}>…</Text>;
  if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
    return (
      <View key={key} style={{ gap: 4 }}>
        {node.content.slice(0, 4).map((item, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
            <Text style={{ color: colors.primary }}>
              {node.type === 'taskList'
                ? node.content[i]!.attrs.checked
                  ? '☑'
                  : '☐'
                : node.type === 'orderedList'
                  ? `${(node.attrs?.start ?? 1) + i}.`
                  : '•'}
            </Text>
            <View style={{ flex: 1 }}>
              {item.content.slice(0, 3).map((child, j) => block(child, j, depth + 1, records))}
            </View>
          </View>
        ))}
      </View>
    );
  }
  if (node.type === 'blockquote')
    return (
      <View
        key={key}
        style={{ paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: colors.primary }}
      >
        {node.content.slice(0, 3).map((child, j) => block(child, j, depth + 1, records))}
      </View>
    );
  return (
    <Text
      key={key}
      numberOfLines={4}
      style={{
        color: colors.text,
        fontSize: node.type === 'heading' ? 25 - node.attrs.level * 2 : 16,
        lineHeight: node.type === 'heading' ? 29 : 24,
        fontWeight: node.type === 'heading' ? '700' : '400',
        ...(node.type === 'codeBlock'
          ? { fontFamily: 'monospace', backgroundColor: '#EDF0E8', padding: 8 }
          : {}),
      }}
    >
      {inline(node.content, records)}
    </Text>
  );
}

export function NotePreview({
  document,
  records = [],
}: {
  document: NoteDocument;
  records?: RecordItem[];
}) {
  return (
    <View style={{ gap: 8 }}>
      {document.content.slice(0, 4).map((node, i) => block(node, i, 0, records))}
      {document.content.length > 4 && <Text style={{ color: colors.muted }}>…</Text>}
    </View>
  );
}
