import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Circle, Line, Path, Svg, Text as SvgText } from 'react-native-svg';

import type { GeometryKind } from '../domain/types';
import { MIN_TOUCH_SIZE, colors, radius, spacing, typography } from './theme';

/**
 * Cross-section drawings for the geometry picker.
 *
 * The operator is standing at a manhole deciding what they are looking at, so
 * the choice is made from the shape rather than from a word. Each drawing shows
 * the section with water in it and the dimension the next step will ask for,
 * which is also what makes the three options distinguishable at a glance.
 *
 * The shapes are schematic, not to scale: they identify a section, they do not
 * report one.
 */

const VIEW = 100;
const WATER = 'rgba(61, 224, 213, 0.22)';

function Label({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <SvgText
      x={x}
      y={y}
      fill={colors.textMuted}
      fontSize={13}
      fontWeight="600"
      textAnchor="middle"
    >
      {children}
    </SvgText>
  );
}

export function CrossSection({
  kind,
  size = 76,
  active = false,
}: {
  kind: GeometryKind;
  size?: number;
  active?: boolean;
}) {
  const stroke = active ? colors.accent : colors.borderStrong;
  const guide = active ? colors.accentDim : colors.border;

  return (
    <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`}>
      {kind === 'circular' ? (
        <>
          {/* Water fills the pipe to a level, which is the h/D the app needs.
              Sweep-flag 0 takes the arc under the chord, not over it. */}
          <Path d="M 12.9 58 A 38 38 0 0 0 87.1 58 Z" fill={WATER} />
          <Circle cx={50} cy={50} r={38} stroke={stroke} strokeWidth={4} fill="none" />
          <Line x1={12} y1={58} x2={88} y2={58} stroke={colors.accent} strokeWidth={2.5} />
          <Line
            x1={12}
            y1={50}
            x2={88}
            y2={50}
            stroke={guide}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <Label x={50} y={45}>
            D
          </Label>
        </>
      ) : null}

      {kind === 'rectangular' ? (
        <>
          <Path d="M 14 52 H 86 V 88 H 14 Z" fill={WATER} />
          <Path d="M 14 12 V 88 H 86 V 12" stroke={stroke} strokeWidth={4} fill="none" />
          <Line x1={14} y1={52} x2={86} y2={52} stroke={colors.accent} strokeWidth={2.5} />
          <Line
            x1={14}
            y1={80}
            x2={86}
            y2={80}
            stroke={guide}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <Label x={50} y={76}>
            b
          </Label>
        </>
      ) : null}

      {kind === 'trapezoidal' ? (
        <>
          <Path d="M 26 52 H 74 L 66 88 H 34 Z" fill={WATER} />
          <Path d="M 12 12 L 34 88 H 66 L 88 12" stroke={stroke} strokeWidth={4} fill="none" />
          <Line x1={26} y1={52} x2={74} y2={52} stroke={colors.accent} strokeWidth={2.5} />
          <Line
            x1={34}
            y1={82}
            x2={66}
            y2={82}
            stroke={guide}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <Label x={50} y={78}>
            b
          </Label>
        </>
      ) : null}
    </Svg>
  );
}

/**
 * Geometry chooser: the three sections side by side, picked by shape. The name
 * stays under each drawing — a schematic is quicker to recognise but only a
 * word is unambiguous, so neither carries the meaning alone.
 */
export function GeometryPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: GeometryKind;
  options: { value: GeometryKind; label: string }[];
  onChange: (next: GeometryKind) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              onPress={() => onChange(option.value)}
              style={[styles.card, selected && styles.cardSelected]}
            >
              <CrossSection kind={option.value} active={selected} />
              <Text style={[styles.cardLabel, selected && styles.cardLabelSelected]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.sm },
  label: { ...typography.small, color: colors.textMuted, fontWeight: '600' },
  row: { flexDirection: 'row', gap: spacing.sm },
  card: {
    flex: 1,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  cardSelected: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  cardLabel: { ...typography.small, color: colors.textMuted, textAlign: 'center' },
  cardLabelSelected: { color: colors.text, fontWeight: '700' },
});
