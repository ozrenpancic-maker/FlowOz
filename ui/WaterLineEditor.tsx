import { useMemo, useRef, useState } from 'react';
import { Image, PanResponder, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Circle, Line as SvgLine, Svg } from 'react-native-svg';

import type { Point2D } from '../domain/ellipse';
import { displayToSource, sourceToDisplay, type FrameGeometry } from '../domain/coordinate-transform';
import { toEndpoints, type WaterLine } from '../domain/water-line';
import { colors, radius, spacing, typography } from './theme';

/**
 * Interactive water-line editor for Camera Level.
 *
 * Replaces the old "tap two points" waterline step with a single line the
 * operator drags and rotates. The depth maths (domain/ellipse.ts) never sees
 * this component — it still gets two endpoints from `toEndpoints`, computed
 * so a WaterLine is geometrically equivalent to the old two-point model (see
 * domain/water-line.ts).
 *
 * All gesture math happens on this file's own state (zoom/pan for the pinch
 * view, and the line's midpoint/angle) and is converted to source pixels
 * through the existing, unchanged domain/coordinate-transform.ts — the pinch
 * zoom is an extra, purely-visual layer on top of that transform, applied and
 * un-applied by this component alone, so a point selected here still maps to
 * the same source pixel the ellipse fit and the exporters use.
 */

const MAX_ZOOM = 4;
const HANDLE_HIT_RADIUS = 26;
const LINE_HIT_DISTANCE = 22;
const HANDLE_RADIUS = 10;

function distanceToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq)) : 0;
  const projX = a.x + t * abx;
  const projY = a.y + t * aby;
  return Math.hypot(p.x - projX, p.y - projY);
}

type GestureMode = 'none' | 'drag-line' | 'rotate' | 'pinch';

export function WaterLineEditor({
  photoUri,
  sourceSize,
  waterLine,
  onChange,
  onGestureStart,
  aspectRatio = 3 / 4,
  rimPoints,
}: {
  photoUri: string;
  sourceSize: { width: number; height: number };
  waterLine: WaterLine;
  onChange: (next: WaterLine) => void;
  /** Fired once, at the start of a drag or rotate gesture — the caller's cue
   * to snapshot the pre-gesture line for Undo. */
  onGestureStart?: () => void;
  aspectRatio?: number;
  /** Rim points, shown as read-only context markers. */
  rimPoints?: Point2D[];
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  const frameGeometry: FrameGeometry | null =
    sourceSize.width > 0 && sourceSize.height > 0 && size.width > 0 && size.height > 0
      ? {
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          displayWidth: size.width,
          displayHeight: size.height,
          fit: 'cover',
        }
      : null;

  const clampPan = (nextPan: Point2D, nextZoom: number): Point2D => {
    const minX = size.width * (1 - nextZoom);
    const minY = size.height * (1 - nextZoom);
    return { x: Math.min(0, Math.max(minX, nextPan.x)), y: Math.min(0, Math.max(minY, nextPan.y)) };
  };

  // Outer (untransformed, gesture-responder) box pixels <-> source pixels,
  // going through the same display-space the cover-fit transform expects.
  const outerToSource = (point: Point2D): Point2D | null => {
    if (!frameGeometry) return null;
    const display = { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom };
    return displayToSource(display, frameGeometry);
  };
  const sourceToOuter = (point: Point2D): Point2D | null => {
    if (!frameGeometry) return null;
    const display = sourceToDisplay(point, frameGeometry);
    if (!display) return null;
    return { x: pan.x + zoom * display.x, y: pan.y + zoom * display.y };
  };

  const [endpointA, endpointB] = toEndpoints(waterLine);

  // Gesture bookkeeping lives in a ref: PanResponder callbacks close over a
  // stale `pan`/`zoom` otherwise, since they are created once per render but
  // React state updates are asynchronous.
  const gesture = useRef<{
    mode: GestureMode;
    startTouch: Point2D;
    startMidpointY: number;
    startTouchSourceY: number;
    startDistance: number;
    startFocal: Point2D;
    startZoom: number;
    startPan: Point2D;
  }>({
    mode: 'none',
    startTouch: { x: 0, y: 0 },
    startMidpointY: 0,
    startTouchSourceY: 0,
    startDistance: 0,
    startFocal: { x: 0, y: 0 },
    startZoom: 1,
    startPan: { x: 0, y: 0 },
  });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => {
          const touches = event.nativeEvent.touches;
          if (touches.length >= 2) {
            const [a, b] = touches;
            if (!a || !b) return;
            gesture.current.mode = 'pinch';
            gesture.current.startDistance = Math.hypot(a.locationX - b.locationX, a.locationY - b.locationY) || 1;
            gesture.current.startFocal = { x: (a.locationX + b.locationX) / 2, y: (a.locationY + b.locationY) / 2 };
            gesture.current.startZoom = zoom;
            gesture.current.startPan = pan;
            return;
          }

          const touch = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
          const handleOuter = sourceToOuter(endpointB);
          const onHandle = handleOuter ? Math.hypot(touch.x - handleOuter.x, touch.y - handleOuter.y) <= HANDLE_HIT_RADIUS : false;
          if (onHandle) {
            gesture.current.mode = 'rotate';
            onGestureStart?.();
            return;
          }

          const outerA = sourceToOuter(endpointA);
          const outerB = sourceToOuter(endpointB);
          const onLine = outerA && outerB ? distanceToSegment(touch, outerA, outerB) <= LINE_HIT_DISTANCE : false;
          if (onLine) {
            const sourcePoint = outerToSource(touch);
            gesture.current.mode = 'drag-line';
            gesture.current.startTouch = touch;
            gesture.current.startMidpointY = waterLine.midpoint.y;
            gesture.current.startTouchSourceY = sourcePoint ? sourcePoint.y : waterLine.midpoint.y;
            onGestureStart?.();
            return;
          }

          gesture.current.mode = 'none';
        },
        onPanResponderMove: (event) => {
          const touches = event.nativeEvent.touches;
          // A second finger landing mid-gesture (the common way a pinch
          // actually starts) switches into pinch mode here rather than only
          // at grant, which only sees the touches present at finger-down.
          if (touches.length >= 2 && gesture.current.mode !== 'pinch') {
            const [first, second] = touches;
            if (first && second) {
              gesture.current.mode = 'pinch';
              gesture.current.startDistance =
                Math.hypot(first.locationX - second.locationX, first.locationY - second.locationY) || 1;
              gesture.current.startFocal = {
                x: (first.locationX + second.locationX) / 2,
                y: (first.locationY + second.locationY) / 2,
              };
              gesture.current.startZoom = zoom;
              gesture.current.startPan = pan;
            }
          }

          const mode = gesture.current.mode;
          if (mode === 'pinch') {
            if (touches.length < 2) return;
            const [a, b] = touches;
            if (!a || !b) return;
            const distance = Math.hypot(a.locationX - b.locationX, a.locationY - b.locationY) || 1;
            const focal = { x: (a.locationX + b.locationX) / 2, y: (a.locationY + b.locationY) / 2 };
            const nextZoom = Math.min(MAX_ZOOM, Math.max(1, gesture.current.startZoom * (distance / gesture.current.startDistance)));
            const localAtStart = {
              x: (gesture.current.startFocal.x - gesture.current.startPan.x) / gesture.current.startZoom,
              y: (gesture.current.startFocal.y - gesture.current.startPan.y) / gesture.current.startZoom,
            };
            const nextPan = { x: focal.x - nextZoom * localAtStart.x, y: focal.y - nextZoom * localAtStart.y };
            setZoom(nextZoom);
            setPan(clampPan(nextPan, nextZoom));
            return;
          }

          if (mode === 'rotate') {
            const touch = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
            const sourcePoint = outerToSource(touch);
            if (!sourcePoint) return;
            const angleRad = Math.atan2(sourcePoint.y - waterLine.midpoint.y, sourcePoint.x - waterLine.midpoint.x);
            onChange({ ...waterLine, angleRad });
            return;
          }

          if (mode === 'drag-line') {
            const touch = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
            const sourcePoint = outerToSource(touch);
            if (!sourcePoint) return;
            const deltaY = sourcePoint.y - gesture.current.startTouchSourceY;
            const nextY = Math.min(sourceSize.height, Math.max(0, gesture.current.startMidpointY + deltaY));
            onChange({ ...waterLine, midpoint: { ...waterLine.midpoint, y: nextY } });
          }
        },
        onPanResponderRelease: () => {
          gesture.current.mode = 'none';
        },
        onPanResponderTerminate: () => {
          gesture.current.mode = 'none';
        },
      }),
    // Re-created whenever the gesture math's own inputs change, so every
    // callback closes over the current geometry rather than a stale one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom, pan, waterLine, frameGeometry, sourceSize.height]
  );

  const nudge = (deltaSourcePx: number) => {
    const nextY = Math.min(sourceSize.height, Math.max(0, waterLine.midpoint.y + deltaSourcePx));
    onGestureStart?.();
    onChange({ ...waterLine, midpoint: { ...waterLine.midpoint, y: nextY } });
  };
  const nudgeStep = Math.max(1, sourceSize.height * 0.003);

  const zoomBy = (factor: number) => {
    const nextZoom = Math.min(MAX_ZOOM, Math.max(1, zoom * factor));
    setZoom(nextZoom);
    setPan((current) => clampPan(current, nextZoom));
  };

  const displayA = frameGeometry ? sourceToDisplay(endpointA, frameGeometry) : null;
  const displayB = frameGeometry ? sourceToDisplay(endpointB, frameGeometry) : null;

  return (
    <View style={styles.wrapper}>
      <View style={[styles.frame, { aspectRatio }]} onLayout={onLayout}>
        <View
          style={{
            width: size.width,
            height: size.height,
            transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: zoom }],
            transformOrigin: '0 0',
          }}
        >
          <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          {size.width > 0 && size.height > 0 ? (
            <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
              {(rimPoints ?? []).map((point, index) => {
                const display = frameGeometry ? sourceToDisplay(point, frameGeometry) : null;
                if (!display) return null;
                return <Circle key={`rim-${index}`} cx={display.x} cy={display.y} r={5} fill={colors.accent} opacity={0.6} />;
              })}
              {displayA && displayB ? (
                <>
                  <SvgLine
                    x1={displayA.x}
                    y1={displayA.y}
                    x2={displayB.x}
                    y2={displayB.y}
                    stroke={colors.warning}
                    strokeWidth={3 / Math.max(zoom, 1)}
                  />
                  <Circle cx={displayA.x} cy={displayA.y} r={HANDLE_RADIUS / Math.max(zoom, 1)} fill={colors.warning} opacity={0.5} />
                  <Circle
                    cx={displayB.x}
                    cy={displayB.y}
                    r={HANDLE_RADIUS / Math.max(zoom, 1)}
                    fill={colors.warning}
                    stroke={colors.background}
                    strokeWidth={2 / Math.max(zoom, 1)}
                  />
                </>
              ) : null}
            </Svg>
          ) : null}
        </View>
        <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers} />
      </View>

      <View style={styles.controlsRow}>
        <Pressable style={styles.controlButton} onPress={() => nudge(-nudgeStep)}>
          <Text style={styles.controlText}>▲ fine</Text>
        </Pressable>
        <Pressable style={styles.controlButton} onPress={() => nudge(nudgeStep)}>
          <Text style={styles.controlText}>▼ fine</Text>
        </Pressable>
        <Pressable style={styles.controlButton} onPress={() => zoomBy(1.4)}>
          <Text style={styles.controlText}>zoom +</Text>
        </Pressable>
        <Pressable style={styles.controlButton} onPress={() => zoomBy(1 / 1.4)}>
          <Text style={styles.controlText}>zoom −</Text>
        </Pressable>
      </View>
    </View>
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
  controlsRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  controlButton: {
    flexGrow: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: spacing.sm,
  },
  controlText: { ...typography.small, color: colors.text, fontWeight: '600' },
});
