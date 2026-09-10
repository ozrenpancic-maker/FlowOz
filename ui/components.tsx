import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { MIN_TOUCH_SIZE, colors, radius, spacing, toneColor, typography, type QualityTone } from './theme';

/** Screen scaffold: dark ground, safe padding, scrolling content. */
export function Screen({
  children,
  scroll = true,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  if (!scroll) {
    return <View style={[styles.screen, contentStyle]}>{children}</View>;
  }
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.scrollContent, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function Card({
  children,
  style,
  tone,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: QualityTone;
}) {
  return (
    <View
      style={[styles.card, tone ? { borderColor: toneColor(tone) } : null, style]}
    >
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  hint,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  hint?: string;
}) {
  const isDisabled = disabled || busy;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy }}
        onPress={onPress}
        disabled={isDisabled}
        style={({ pressed }) => [
          styles.button,
          variant === 'primary' && styles.buttonPrimary,
          variant === 'secondary' && styles.buttonSecondary,
          variant === 'danger' && styles.buttonDanger,
          isDisabled && styles.buttonDisabled,
          pressed && !isDisabled && styles.buttonPressed,
        ]}
      >
        {busy ? <ActivityIndicator color={colors.background} size="small" /> : null}
        <Text
          style={[
            styles.buttonLabel,
            variant === 'primary' && styles.buttonLabelPrimary,
            variant === 'danger' && styles.buttonLabelDanger,
            isDisabled && styles.buttonLabelDisabled,
          ]}
        >
          {label}
        </Text>
      </Pressable>
      {hint ? <Text style={styles.buttonHint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * One labelled value with its source and quality. Provenance, quality and the
 * value itself are always shown as text, never as colour alone.
 */
export function ValueRow({
  label,
  value,
  unit,
  provenance,
  tone,
  withheld = false,
  detail,
}: {
  label: string;
  value: string;
  unit?: string;
  provenance?: string;
  tone?: QualityTone;
  withheld?: boolean;
  detail?: string;
}) {
  return (
    <View style={styles.valueRow}>
      <View style={styles.valueRowMain}>
        <Text style={styles.valueLabel}>{label}</Text>
        <Text
          style={[
            styles.valueText,
            withheld && { color: colors.withheld },
            tone && !withheld ? { color: toneColor(tone) } : null,
          ]}
        >
          {value}
          {unit ? <Text style={styles.valueUnit}> {unit}</Text> : null}
        </Text>
      </View>
      {provenance || detail ? (
        <Text style={styles.valueMeta}>
          {[provenance, detail].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
    </View>
  );
}

export function Badge({ label, tone = 'neutral' }: { label: string; tone?: QualityTone }) {
  const color = toneColor(tone);
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

/**
 * Explicit failure block. Every failure in FLOWVISION reaches the operator
 * through one of these: a headline, what to do about it, and the raw technical
 * detail. Nothing is swallowed.
 */
export function ErrorBlock({
  title,
  action,
  detail,
  detailLabel,
  tone = 'error',
  children,
}: {
  title: string;
  action?: string;
  detail?: string;
  detailLabel?: string;
  tone?: QualityTone;
  children?: ReactNode;
}) {
  const color = toneColor(tone);
  return (
    <View style={[styles.errorBlock, { borderColor: color }]}>
      <Text style={[styles.errorTitle, { color }]}>{title}</Text>
      {action ? <Text style={styles.errorAction}>{action}</Text> : null}
      {detail ? (
        <Text style={styles.errorDetail}>
          {detailLabel ? `${detailLabel}: ` : ''}
          {detail}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = 'decimal-pad',
  unit,
  hint,
  invalid = false,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  keyboardType?: 'decimal-pad' | 'default' | 'numeric';
  unit?: string;
  hint?: string;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.fieldInputRow, invalid && { borderColor: colors.error }]}>
        <TextInput
          style={styles.fieldInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textFaint}
          keyboardType={keyboardType}
          autoFocus={autoFocus}
          accessibilityLabel={label}
        />
        {unit ? <Text style={styles.fieldUnit}>{unit}</Text> : null}
      </View>
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <View style={styles.choiceRow}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={[styles.choice, selected && styles.choiceSelected]}
            >
              <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Toggle({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  hint?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      onPress={() => onChange(!value)}
      style={styles.toggleRow}
    >
      <View style={[styles.toggleBox, value && styles.toggleBoxOn]}>
        {value ? <Text style={styles.toggleMark}>✓</Text> : null}
      </View>
      <View style={styles.toggleTextWrap}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: QualityTone }) {
  return <Text style={[styles.note, { color: toneColor(tone) }]}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.keyValueKey}>{label}</Text>
      <Text style={styles.keyValueValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xxl * 2, gap: spacing.md },
  sectionTitle: {
    ...typography.sectionTitle,
    color: colors.accent,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  button: {
    minHeight: MIN_TOUCH_SIZE,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
  },
  buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surfaceRaised, borderColor: colors.borderStrong },
  buttonDanger: { backgroundColor: 'transparent', borderColor: colors.error },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.8 },
  buttonLabel: {
    ...typography.sectionTitle,
    color: colors.text,
    textAlign: 'center',
  },
  buttonLabelPrimary: { color: colors.background },
  buttonLabelDanger: { color: colors.error },
  buttonLabelDisabled: { color: colors.textFaint },
  buttonHint: { ...typography.small, color: colors.textFaint, marginTop: spacing.xs },
  valueRow: { paddingVertical: spacing.xs, gap: 2 },
  valueRowMain: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: spacing.sm },
  valueLabel: { ...typography.small, color: colors.textMuted, flexShrink: 1 },
  valueText: { ...typography.mono, color: colors.text, fontWeight: '700', textAlign: 'right' },
  valueUnit: { color: colors.textMuted, fontWeight: '400' },
  valueMeta: { ...typography.small, color: colors.textFaint, textAlign: 'right' },
  badge: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 10, letterSpacing: 1.2, fontWeight: '700' },
  errorBlock: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    gap: spacing.xs,
  },
  errorTitle: { ...typography.sectionTitle },
  errorAction: { ...typography.body, color: colors.text },
  errorDetail: { ...typography.small, color: colors.textFaint, fontStyle: 'italic' },
  field: { gap: spacing.xs },
  fieldLabel: { ...typography.small, color: colors.textMuted, letterSpacing: 0.6 },
  fieldInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    minHeight: MIN_TOUCH_SIZE,
  },
  fieldInput: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: spacing.sm },
  fieldUnit: { ...typography.small, color: colors.textMuted, marginLeft: spacing.sm },
  fieldHint: { ...typography.small, color: colors.textFaint },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    minHeight: MIN_TOUCH_SIZE - 8,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  choiceSelected: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  choiceText: { ...typography.small, color: colors.textMuted, fontWeight: '600' },
  choiceTextSelected: { color: colors.text },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: MIN_TOUCH_SIZE },
  toggleBox: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleBoxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleMark: { color: colors.background, fontWeight: '700' },
  toggleTextWrap: { flex: 1, gap: 2 },
  toggleLabel: { ...typography.body, color: colors.text },
  note: { ...typography.small },
  muted: { ...typography.small, color: colors.textMuted },
  keyValue: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  keyValueKey: { ...typography.small, color: colors.textMuted, flexShrink: 1 },
  keyValueValue: { ...typography.mono, color: colors.text },
});
