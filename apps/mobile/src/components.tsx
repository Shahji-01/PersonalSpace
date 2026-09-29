import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors } from '@personalspace/ui';
import type { PropsWithChildren } from 'react';

export function Button({
  label,
  onPress,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, secondary && styles.secondary, disabled && { opacity: 0.45 }]}
    >
      <Text style={[styles.buttonText, secondary && { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={styles.input}
        {...props}
      />
    </View>
  );
}
export function Card({ children }: PropsWithChildren) {
  return <View style={styles.card}>{children}</View>;
}
export const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  page: { padding: 24, paddingBottom: 40, gap: 20 },
  eyebrow: { fontSize: 12, fontWeight: '700', letterSpacing: 2, color: colors.primary },
  title: { fontSize: 34, fontWeight: '700', color: colors.text, letterSpacing: -1 },
  subtitle: { fontSize: 16, lineHeight: 25, color: colors.muted },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: colors.text,
    minHeight: 52,
  },
  button: {
    backgroundColor: colors.primary,
    minHeight: 48,
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondary: { backgroundColor: '#E8EDE4' },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  error: { color: colors.danger, fontSize: 14, lineHeight: 22 },
  nav: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: 'row',
    gap: 8,
    borderTopWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
});
