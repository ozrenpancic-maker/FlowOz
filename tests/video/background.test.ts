import {
  MIN_BACKGROUND_FRAMES,
  backgroundCorrelation,
  framePairCorrelation,
  staticBackground,
  suppressStaticBackground,
} from '../../video/background';
import type { FramePair } from '../../video/types';
import { makeClip, makeTexture } from './synthetic';

const WIDTH = 24;
const HEIGHT = 16;
const PIXELS = WIDTH * HEIGHT;

/** A fixed scene plus a per-frame moving blob, the shape real footage has. */
function sceneFrames(count: number): { frames: Float32Array[]; scene: Float32Array } {
  const texture = makeTexture(WIDTH, HEIGHT, 7);
  const scene = new Float32Array(PIXELS);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) scene[y * WIDTH + x] = texture(x, y);
  }

  const frames: Float32Array[] = [];
  for (let f = 0; f < count; f += 1) {
    const frame = Float32Array.from(scene);
    // A bright blob at a different place in every frame: present in each one,
    // never in the same pixel twice, so a median must reject it.
    const blobX = 2 + ((f * 5) % (WIDTH - 4));
    for (let y = 4; y < 8; y += 1) {
      for (let x = blobX; x < blobX + 3; x += 1) frame[y * WIDTH + x] = 255;
    }
    frames.push(frame);
  }
  return { frames, scene };
}

function pairsFrom(frames: Float32Array[]): FramePair[] {
  const pairs: FramePair[] = [];
  for (let i = 0; i + 1 < frames.length; i += 2) {
    pairs.push({
      index: pairs.length,
      first: frames[i] as Float32Array,
      second: frames[i + 1] as Float32Array,
      width: WIDTH,
      height: HEIGHT,
      frameDeltaS: 0.1,
    });
  }
  return pairs;
}

describe('staticBackground', () => {
  it('recovers the scene that never moved, rejecting a blob that did', () => {
    const { frames, scene } = sceneFrames(12);
    const background = staticBackground(frames, PIXELS);
    expect(background).not.toBeNull();
    if (!background) return;
    for (let i = 0; i < PIXELS; i += 1) {
      expect(background[i] as number).toBeCloseTo(scene[i] as number, 4);
    }
  });

  it('refuses to estimate from too few frames', () => {
    const { frames } = sceneFrames(MIN_BACKGROUND_FRAMES - 1);
    expect(staticBackground(frames, PIXELS)).toBeNull();
  });

  it('refuses frames whose size does not match', () => {
    const { frames } = sceneFrames(8);
    frames[3] = new Float32Array(PIXELS - 1);
    expect(staticBackground(frames, PIXELS)).toBeNull();
  });
});

describe('backgroundCorrelation', () => {
  it('is 1 for a frame that is the background', () => {
    const { frames, scene } = sceneFrames(8);
    expect(backgroundCorrelation(scene, scene, WIDTH)).toBeCloseTo(1, 9);
    // A frame is the scene plus its own blob, so it clears the floor the
    // suppression decides on without reaching 1.
    expect(backgroundCorrelation(frames[0] as Float32Array, scene, WIDTH)).toBeGreaterThan(0.55);
  });

  it('is near zero for a frame unrelated to the background', () => {
    const { scene } = sceneFrames(8);
    const other = new Float32Array(PIXELS);
    const texture = makeTexture(WIDTH, HEIGHT, 999);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) other[y * WIDTH + x] = texture(x, y);
    }
    expect(Math.abs(backgroundCorrelation(other, scene, WIDTH))).toBeLessThan(0.55);
  });

  it('reports NaN for a flat background with no variance to correlate against', () => {
    const flat = new Float32Array(PIXELS).fill(100);
    expect(Number.isNaN(backgroundCorrelation(flat, flat, WIDTH))).toBe(true);
  });
});

describe('suppressStaticBackground', () => {
  it('subtracts the shared scene away, leaving what moved', () => {
    const { frames } = sceneFrames(12);
    const result = suppressStaticBackground(pairsFrom(frames));
    expect(result.applied).toBe(true);
    expect(result.roiCorrelation).toBeGreaterThan(0.55);

    // Away from the blob, every frame was the same scene: the residual is ~0.
    const residual = result.pairs[0]?.first as Float32Array;
    expect(residual[(12 * WIDTH) + 12] as number).toBeCloseTo(0, 4);
    // The blob itself survives as a large residual somewhere in its own row.
    let peak = 0;
    for (let x = 0; x < WIDTH; x += 1) peak = Math.max(peak, Math.abs(residual[5 * WIDTH + x] as number));
    expect(peak).toBeGreaterThan(50);
  });

  it('leaves the frames untouched when they share no static content', () => {
    // The default synthetic clip re-seeds its texture every pair, so there is
    // no scenery in common to remove — subtracting a meaningless estimate
    // would inject its own negation into every frame instead.
    const clip = makeClip();
    const result = suppressStaticBackground(clip.pairs);
    expect(result.applied).toBe(false);
    expect(result.pairs[0]?.first).toBe(clip.pairs[0]?.first);
  });

  it('applies to a clip shot from a tripod over a visible bed', () => {
    const clip = makeClip({ visibleBed: { movingAmplitude: 0.3 } });
    const result = suppressStaticBackground(clip.pairs);
    expect(result.applied).toBe(true);
    expect(result.roiCorrelation).toBeGreaterThan(0.55);
  });

  it('judges the ROI on its own, not on how much of the frame happens to be water', () => {
    // Half the frame is scenery that never moves, half is water that changes
    // every frame. A whole-frame number would land near the middle whatever
    // the estimate is worth; measured per region, the two halves separate.
    // Full working resolution: on a frame small enough to hold only a handful
    // of independent texture cells, two unrelated fields correlate strongly by
    // chance alone and the measurement means nothing.
    const width = 240;
    const height = 135;
    const pixels = width * height;
    const bank = makeTexture(width, height, 3);
    const roiRegion = { x0: width / 2, y0: 0, x1: width, y1: height };

    const frames: Float32Array[] = [];
    for (let f = 0; f < 12; f += 1) {
      const water = makeTexture(width, height, 500 + f * 31);
      const frame = new Float32Array(pixels);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          frame[y * width + x] = x < width / 2 ? bank(x, y) : water(x, y);
        }
      }
      frames.push(frame);
    }

    const a = frames[0] as Float32Array;
    const b = frames[6] as Float32Array;
    // The bank is identical in every frame; the water shares nothing.
    expect(framePairCorrelation(a, b, width, roiRegion, false)).toBeGreaterThan(0.9);
    expect(framePairCorrelation(a, b, width, roiRegion, true)).toBeLessThan(0.55);
  });

  it('does not credit a frame for appearing in the median built from it', () => {
    // A median of these frames contains every one of them, so a frame scores
    // well against it even where the scene shares nothing — the self-inclusion
    // alone reads as a half-decent match and would wave through an estimate
    // worth nothing. Two frames compared with each other cannot do that.
    const width = 240;
    const height = 135;
    const pixels = width * height;
    const frames: Float32Array[] = [];
    for (let f = 0; f < 12; f += 1) {
      const water = makeTexture(width, height, 900 + f * 37);
      const frame = new Float32Array(pixels);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) frame[y * width + x] = water(x, y);
      }
      frames.push(frame);
    }

    const background = staticBackground(frames, pixels);
    expect(background).not.toBeNull();
    if (!background) return;

    const againstMedian = backgroundCorrelation(frames[0] as Float32Array, background, width);
    const againstAnother = framePairCorrelation(
      frames[0] as Float32Array,
      frames[6] as Float32Array,
      width
    );
    expect(againstMedian).toBeGreaterThan(againstAnother + 0.2);
    expect(Math.abs(againstAnother)).toBeLessThan(0.55);
  });

  it('does nothing with too few pairs to estimate a background', () => {
    const clip = makeClip({ visibleBed: { movingAmplitude: 0.3 }, pairs: 2 });
    const result = suppressStaticBackground(clip.pairs);
    expect(result.applied).toBe(false);
    expect(Number.isNaN(result.roiCorrelation)).toBe(true);
  });
});
