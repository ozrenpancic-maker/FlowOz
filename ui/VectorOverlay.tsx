import { Fragment, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Circle, Line as SvgLine, Polygon, Svg } from 'react-native-svg';

import { sourceToDisplay, type FitMode } from '../domain/coordinate-transform';
import type { SsivAnalysis } from '../video/types';
import { colors } from './theme';

/**
 * Draws the ensemble's detected motion — one arrow per interrogation grid
 * node — over the same video preview the ROI was drawn on, so the operator
 * can see what the analysis actually tracked instead of only reading numbers.
 *
 * Arrow lengths are exaggerated by `arrowScale`: a real per-pair displacement
 * is a handful of pixels, invisible at natural scale on a phone screen. This
 * is a diagnostic aid, not a to-scale flow-field plot — the note under the
 * legend says so explicitly.
 */
const ARROW_SCALE = 10;
const REJECTED_COLOR = 'rgba(220, 90, 90, 0.65)';

export function VectorOverlay({
  analysis,
  fit = 'cover',
}: {
  analysis: Pick<SsivAnalysis, 'ensemble' | 'frameWidth' | 'frameHeight' | 'sourceWidth' | 'sourceHeight'>;
  /** Must match the same preview's own contentFit — see RoiEditor/WaterLineEditor. */
  fit?: FitMode;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  const geometry =
    size.width > 0 && size.height > 0
      ? {
          sourceWidth: analysis.sourceWidth,
          sourceHeight: analysis.sourceHeight,
          displayWidth: size.width,
          displayHeight: size.height,
          fit,
        }
      : null;

  // Vectors are measured in the working (downscaled) resolution — scale up to
  // the video's own source pixels before going through the same display
  // transform the ROI overlay uses, so an arrow lands on the same physical
  // point the analysis actually read.
  const scaleX = analysis.frameWidth > 0 ? analysis.sourceWidth / analysis.frameWidth : 1;
  const scaleY = analysis.frameHeight > 0 ? analysis.sourceHeight / analysis.frameHeight : 1;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={onLayout}>
      {geometry ? (
        <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
          {analysis.ensemble.map((vector, index) => {
            const startSource = { x: vector.x * scaleX, y: vector.y * scaleY };
            const dx = Number.isFinite(vector.dxPx) ? vector.dxPx : 0;
            const dy = Number.isFinite(vector.dyPx) ? vector.dyPx : 0;
            const endSource = {
              x: startSource.x + dx * scaleX * ARROW_SCALE,
              y: startSource.y + dy * scaleY * ARROW_SCALE,
            };
            const start = sourceToDisplay(startSource, geometry);
            const end = sourceToDisplay(endSource, geometry);
            if (!start || !end) return null;
            const color = vector.accepted ? colors.accent : REJECTED_COLOR;
            if (!vector.accepted) {
              // A rejected node is marked as a dot, not a misleading arrow —
              // its direction was never trusted enough to report.
              return <Circle key={`v-${index}`} cx={start.x} cy={start.y} r={3} fill={color} />;
            }
            const length = Math.hypot(end.x - start.x, end.y - start.y);
            if (length < 1) return <Circle key={`v-${index}`} cx={start.x} cy={start.y} r={3} fill={color} />;
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const headLength = Math.min(8, length * 0.5);
            const headWidth = headLength * 0.7;
            const backX = end.x - headLength * Math.cos(angle);
            const backY = end.y - headLength * Math.sin(angle);
            const leftX = backX + (headWidth / 2) * Math.sin(angle);
            const leftY = backY - (headWidth / 2) * Math.cos(angle);
            const rightX = backX - (headWidth / 2) * Math.sin(angle);
            const rightY = backY + (headWidth / 2) * Math.cos(angle);
            return (
              <Fragment key={`v-${index}`}>
                <SvgLine x1={start.x} y1={start.y} x2={backX} y2={backY} stroke={color} strokeWidth={2} />
                <Polygon points={`${end.x},${end.y} ${leftX},${leftY} ${rightX},${rightY}`} fill={color} />
              </Fragment>
            );
          })}
        </Svg>
      ) : null}
    </View>
  );
}
