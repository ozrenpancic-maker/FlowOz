import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Circle, Svg } from 'react-native-svg';

import { sourceToDisplay, type FitMode } from '../domain/coordinate-transform';
import type { SsivAnalysis } from '../video/types';

/**
 * Draws the camera-stabilisation background anchors over the same video
 * preview the ROI was drawn on, so the operator can see where the pipeline
 * assumed the surroundings were stationary rather than trust that assumption
 * blindly. A green dot fed the pair's reported motion; a red dot was offered
 * but not trusted (lost track, hit the search edge, or was voted out by the
 * majority, or the whole pair was reported unstable).
 *
 * One pair's anchors are shown, not every pair's — anchors are placed by a
 * fixed geometric grid so their positions barely move pair to pair, and
 * overlaying all of them would just repaint the same dots. The first pair
 * reported stable is the representative: it is the one whose anchors
 * actually earned trust, which is the more informative picture when most of
 * the clip stabilised fine. Falling back to the first pair keeps something
 * on screen for a clip where none did.
 */
const USED_COLOR = 'rgba(61, 224, 213, 0.9)';
const UNUSED_COLOR = 'rgba(220, 90, 90, 0.75)';

export function AnchorOverlay({
  analysis,
  fit = 'cover',
}: {
  analysis: Pick<SsivAnalysis, 'stabilisation' | 'frameWidth' | 'frameHeight' | 'sourceWidth' | 'sourceHeight'>;
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

  const pair = analysis.stabilisation.find((candidate) => candidate.stable) ?? analysis.stabilisation[0];
  // A measurement stored before this overlay existed has stabilisation entries
  // with no anchors recorded at all, and reopening one must show the rest of
  // its result rather than take the screen down with it.
  const anchors = pair?.anchors ?? [];

  // Anchors are placed in the working (downscaled) resolution — scale up to
  // the video's own source pixels before going through the same display
  // transform the ROI overlay uses, so a dot lands on the same physical
  // point the stabilisation search actually read.
  const scaleX = analysis.frameWidth > 0 ? analysis.sourceWidth / analysis.frameWidth : 1;
  const scaleY = analysis.frameHeight > 0 ? analysis.sourceHeight / analysis.frameHeight : 1;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={onLayout}>
      {geometry && anchors.length > 0
        ? (
            <Svg width={size.width} height={size.height} style={StyleSheet.absoluteFill}>
              {anchors.map((anchor, index) => {
                const point = sourceToDisplay({ x: anchor.x * scaleX, y: anchor.y * scaleY }, geometry);
                if (!point) return null;
                return (
                  <Circle
                    key={`a-${index}`}
                    cx={point.x}
                    cy={point.y}
                    r={4}
                    fill={anchor.used ? USED_COLOR : UNUSED_COLOR}
                  />
                );
              })}
            </Svg>
          )
        : null}
    </View>
  );
}
