import type { WaterRoi } from '../../domain/types';
import type { DecodedClip, FramePair } from '../../video/types';

/**
 * Synthetic clip generator for the SSIV tests.
 *
 * A deterministic value-noise texture stands in for a water surface. A chosen
 * rectangular region is translated by a known displacement between the two
 * frames of each pair while the rest of the frame stays put, which is exactly
 * what the pipeline is supposed to see: stationary background for the camera
 * compensation, moving texture inside the ROI.
 */

/** Small deterministic PRNG, so every run of the suite sees the same frames. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bilinearly interpolated lattice noise: smooth, non-periodic, trackable. */
export function makeTexture(width: number, height: number, seed = 42, cell = 7) {
  const random = mulberry32(seed);
  const cols = Math.ceil(width / cell) + 3;
  const rows = Math.ceil(height / cell) + 3;
  const lattice = new Float32Array(cols * rows);
  for (let i = 0; i < lattice.length; i += 1) lattice[i] = random() * 255;

  return (x: number, y: number): number => {
    const gx = x / cell + 1;
    const gy = y / cell + 1;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const at = (cx: number, cy: number) => {
      const col = Math.min(cols - 1, Math.max(0, cx));
      const row = Math.min(rows - 1, Math.max(0, cy));
      return lattice[row * cols + col] as number;
    };
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  };
}

export interface SyntheticOptions {
  width?: number;
  height?: number;
  /** Displacement of the moving region between the two frames [px]. */
  shiftX?: number;
  shiftY?: number;
  frameDeltaS?: number;
  pairs?: number;
  /** Bounds of the moving region in pixels. */
  moving?: { x0: number; x1: number; y0: number; y1: number };
  /** Standard deviation of additive noise, in grey levels. */
  noise?: number;
  /** Flat frames: no trackable texture anywhere. */
  flat?: boolean;
  /** Featureless water inside the moving region, textured bank around it. */
  flatWater?: boolean;
  /** Non-rigid warp: every part of the frame moves differently, as under heavy
   * shake or rolling shutter, so no single global shift describes the pair. */
  shakyBackground?: boolean;
  seed?: number;
}

export function makeClip(options: SyntheticOptions = {}): DecodedClip {
  const width = options.width ?? 240;
  const height = options.height ?? 135;
  const shiftX = options.shiftX ?? 0;
  const shiftY = options.shiftY ?? 3;
  const frameDeltaS = options.frameDeltaS ?? 0.1;
  const pairCount = options.pairs ?? 6;
  const moving = options.moving ?? { x0: 52, x1: 188, y0: 7, y1: 128 };
  const noiseSigma = options.noise ?? 0;

  const pairs: FramePair[] = [];

  for (let index = 0; index < pairCount; index += 1) {
    const texture = makeTexture(width, height, (options.seed ?? 1000) + index * 17);
    const alternate = makeTexture(width, height, (options.seed ?? 1000) + index * 17 + 9973);
    const noise = mulberry32(7 + index);

    const first = new Float32Array(width * height);
    const second = new Float32Array(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (options.flat) {
          first[i] = 128;
          second[i] = 128;
          continue;
        }

        const jitter = () => (noiseSigma > 0 ? (noise() - 0.5) * 2 * noiseSigma : 0);
        first[i] = texture(x, y) + jitter();

        if (options.shakyBackground) {
          // A smoothly varying but large displacement field: each region is
          // still trackable on its own, yet no rigid shift fits them all.
          const wobbleX = 8 * Math.sin((x / 37) * 1.7 + index) * Math.cos(y / 23);
          const wobbleY = 8 * Math.cos((y / 29) * 1.3 - index) * Math.sin(x / 31);
          second[i] = texture(x + wobbleX, y + wobbleY) + jitter();
          continue;
        }

        const insideMoving = x >= moving.x0 && x <= moving.x1 && y >= moving.y0 && y <= moving.y1;
        if (options.flatWater && insideMoving) {
          // Glassy water: the bank is sharp, the surface carries nothing.
          first[i] = 128 + jitter();
          second[i] = 128 + jitter();
          continue;
        }
        second[i] = insideMoving ? texture(x - shiftX, y - shiftY) + jitter() : texture(x, y) + jitter();
      }
    }

    pairs.push({ index, first, second, width, height, frameDeltaS });
  }

  return {
    sourceWidth: width * 4,
    sourceHeight: height * 4,
    width,
    height,
    durationS: 5,
    pairs,
  };
}

/** ROI well inside the moving region, clear of the background anchors. */
export const TEST_ROI: WaterRoi = {
  topLeft: { x: 0.3, y: 0.2 },
  topRight: { x: 0.7, y: 0.2 },
  bottomRight: { x: 0.7, y: 0.8 },
  bottomLeft: { x: 0.3, y: 0.8 },
};

/** 2 m across the flow, 3 m along it. */
export const TEST_DIMENSIONS = { widthM: 2, lengthM: 3 };
