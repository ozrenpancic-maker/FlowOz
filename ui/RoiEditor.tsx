import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import type { NormalizedPoint, WaterRoi } from '../domain/types';
import { ROI_POINT_ORDER, type RoiPointKey } from '../video/roi';
import { colors, radius, spacing, typography } from './theme';

/**
 * Four-point ROI editor.
 *
 * Points are numbered 1–4 and stored in normalised (0–1) coordinates so the ROI
 * survives any preview size. The operator selects a point and taps the frame to
 * move it; flow runs from edge 1–2 towards edge 4–3.
 */
export function RoiEditor({
  roi,
  onChange,
  children,
  aspectRatio = 16 / 9,
  pointLabel,
}: {
  roi: WaterRoi;
  onChange: (next: WaterRoi) => void;
  /** Frame preview rendered underneath the overlay. */
  children?: React.ReactNode;
  aspectRatio?: number;
  pointLabel: string;
}) {
  const [active, setActive] = useState<RoiPointKey>('topLeft');
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  const movePoint = (x: number, y: number) => {
    if (size.width <= 0 || size.height <= 0) return;
    const next: NormalizedPoint = {
      x: clamp01(x / size.width),
      y: clamp01(y / size.height),
    };
    onChange({ ...roi, [active]: next });
  };

  return (
    <View style={styles.wrapper}>
      <View style={[styles.frame, { aspectRatio }]} onLayout={onLayout}>
        {children}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={(event) => movePoint(event.nativeEvent.locationX, event.nativeEvent.locationY)}
        >
          <View style={StyleSheet.absoluteFill}>
            {ROI_POINT_ORDER.map((key, index) => {
              const point = roi[key];
              const isActive = key === active;
              return (
                <View
                  key={key}
                  style={[
                    styles.handle,
                    isActive && styles.handleActive,
                    {
                      left: point.x * size.width - HANDLE / 2,
                      top: point.y * size.height - HANDLE / 2,
                    },
                  ]}
                >
                  <Text style={[styles.handleText, isActive && styles.handleTextActive]}>
                    {index + 1}
                  </Text>
                </View>
              );
            })}
            {edges(roi, size).map((edge) => (
              <View key={edge.key} style={[styles.edge, edge.style]} />
            ))}
          </View>
        </Pressable>
      </View>

      <View style={styles.picker}>
        {ROI_POINT_ORDER.map((key, index) => {
          const selected = key === active;
          return (
            <Pressable
              key={key}
              onPress={() => setActive(key)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={[styles.pickerItem, selected && styles.pickerItemSelected]}
            >
              <Text style={[styles.pickerText, selected && styles.pickerTextSelected]}>
                {pointLabel} {index + 1}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const HANDLE = 30;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Straight segments between consecutive ROI points, drawn as rotated views. */
function edges(roi: WaterRoi, size: { width: number; height: number }) {
  const points = ROI_POINT_ORDER.map((key) => roi[key]);
  return points.map((point, index) => {
    const next = points[(index + 1) % points.length] as NormalizedPoint;
    const x1 = point.x * size.width;
    const y1 = point.y * size.height;
    const x2 = next.x * size.width;
    const y2 = next.y * size.height;
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    return {
      key: `edge-${index}`,
      style: {
        left: x1,
        top: y1,
        width: length,
        transform: [{ rotate: `${angle}deg` }],
      },
    };
  });
}

const styles = StyleSheet.create({
  wrapper: { gap: spacing.sm },
  frame: {
    width: '100%',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    borderRadius: HANDLE / 2,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: 'rgba(5, 11, 14, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  handleActive: { backgroundColor: colors.accent },
  handleText: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  handleTextActive: { color: colors.background },
  edge: {
    position: 'absolute',
    height: 2,
    backgroundColor: colors.accent,
    opacity: 0.75,
    transformOrigin: 'left center',
  },
  picker: { flexDirection: 'row', gap: spacing.sm },
  pickerItem: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  pickerItemSelected: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  pickerText: { ...typography.small, color: colors.textMuted, fontWeight: '600' },
  pickerTextSelected: { color: colors.text },
});
