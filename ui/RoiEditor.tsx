import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Polygon, Line as SvgLine, Svg } from 'react-native-svg';

import type { FlowDirection, NormalizedPoint, WaterRoi } from '../domain/types';
import { normalizedDisplayToSource, normalizedSourceToDisplay, type FitMode } from '../domain/coordinate-transform';
import { ROI_POINT_ORDER, type RoiPointKey } from '../video/roi';
import { colors, radius, spacing, typography } from './theme';

/**
 * Four-point ROI editor.
 *
 * Points are numbered 1–4 and stored normalised (0–1) to the *source*
 * video's own frame, not to this preview box — see domain/coordinate-
 * transform.ts for why those are not the same thing whenever `contentFit`
 * crops or letterboxes the preview relative to the source's own aspect
 * ratio. When `sourceSize` is supplied, every tap and every drawn handle
 * goes through that transform; without it, points are stored relative to
 * the preview box itself, which is only correct if the caller has already
 * forced the box to the source's exact aspect ratio.
 */
export function RoiEditor({
  roi,
  onChange,
  children,
  aspectRatio = 16 / 9,
  pointLabel,
  sourceSize,
  fit = 'cover',
  flowDirection = 'FORWARD',
}: {
  roi: WaterRoi;
  onChange: (next: WaterRoi) => void;
  /** Frame preview rendered underneath the overlay. */
  children?: React.ReactNode;
  aspectRatio?: number;
  pointLabel: string;
  /** Real pixel size of the video behind the preview. */
  sourceSize?: { width: number; height: number };
  /** How `children`'s preview fits the box — must match its own contentFit. */
  fit?: FitMode;
  /** Which way the ROI's own edges (1-2 towards 4-3, or reversed) is taken
   * as downstream — drawn as an arrow through the ROI so the direction is
   * never just a sentence to re-derive from the point numbering. */
  flowDirection?: FlowDirection;
}) {
  const [active, setActive] = useState<RoiPointKey>('topLeft');
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  const toSource = (point: NormalizedPoint): NormalizedPoint | null => {
    if (!sourceSize) return point;
    if (size.width <= 0 || size.height <= 0) return null;
    return normalizedDisplayToSource(point, {
      sourceWidth: sourceSize.width,
      sourceHeight: sourceSize.height,
      displayWidth: size.width,
      displayHeight: size.height,
      fit,
    });
  };

  const toDisplay = (point: NormalizedPoint): NormalizedPoint => {
    if (!sourceSize || size.width <= 0 || size.height <= 0) return point;
    return (
      normalizedSourceToDisplay(point, {
        sourceWidth: sourceSize.width,
        sourceHeight: sourceSize.height,
        displayWidth: size.width,
        displayHeight: size.height,
        fit,
      }) ?? point
    );
  };

  const movePoint = (x: number, y: number) => {
    if (size.width <= 0 || size.height <= 0) return;
    const displayPoint = { x: x / size.width, y: y / size.height };
    const sourcePoint = toSource(displayPoint);
    // A tap outside the visible content (the letterbox bar in "contain") has
    // no corresponding source pixel — ignored rather than guessed.
    if (!sourcePoint) return;
    const next: NormalizedPoint = { x: clamp01(sourcePoint.x), y: clamp01(sourcePoint.y) };
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
              const point = toDisplay(roi[key]);
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
            {edges(roi, size, toDisplay).map((edge) => (
              <View key={edge.key} style={[styles.edge, edge.style]} />
            ))}
          </View>
        </Pressable>
        {size.width > 0 && size.height > 0 ? (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <FlowArrow roi={roi} size={size} toDisplay={toDisplay} flowDirection={flowDirection} />
          </View>
        ) : null}
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
function edges(
  roi: WaterRoi,
  size: { width: number; height: number },
  toDisplay: (point: NormalizedPoint) => NormalizedPoint
) {
  const points = ROI_POINT_ORDER.map((key) => toDisplay(roi[key]));
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

/**
 * A visible arrow through the ROI's centre, pointing the way the ROI's own
 * edges (1-2 towards 4-3, or the reverse) are currently taken as downstream —
 * so the operator can see the effective flow direction at a glance instead of
 * re-deriving it from the point numbering and the FlowDirection setting.
 */
function FlowArrow({
  roi,
  size,
  toDisplay,
  flowDirection,
}: {
  roi: WaterRoi;
  size: { width: number; height: number };
  toDisplay: (point: NormalizedPoint) => NormalizedPoint;
  flowDirection: FlowDirection;
}) {
  const midpoint = (a: NormalizedPoint, b: NormalizedPoint): NormalizedPoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const mid12 = toDisplay(midpoint(roi.topLeft, roi.topRight));
  const mid43 = toDisplay(midpoint(roi.bottomLeft, roi.bottomRight));

  const [from, to] = flowDirection === 'REVERSED' ? [mid43, mid12] : [mid12, mid43];
  const x1 = from.x * size.width;
  const y1 = from.y * size.height;
  const x2 = to.x * size.width;
  const y2 = to.y * size.height;

  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length < 1) return null;

  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLength = Math.min(16, length * 0.4);
  const headWidth = headLength * 0.7;
  const backX = x2 - headLength * Math.cos(angle);
  const backY = y2 - headLength * Math.sin(angle);
  const leftX = backX + (headWidth / 2) * Math.sin(angle);
  const leftY = backY - (headWidth / 2) * Math.cos(angle);
  const rightX = backX - (headWidth / 2) * Math.sin(angle);
  const rightY = backY + (headWidth / 2) * Math.cos(angle);

  return (
    <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
      <SvgLine x1={x1} y1={y1} x2={backX} y2={backY} stroke={colors.warning} strokeWidth={3} />
      <Polygon points={`${x2},${y2} ${leftX},${leftY} ${rightX},${rightY}`} fill={colors.warning} />
    </Svg>
  );
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
