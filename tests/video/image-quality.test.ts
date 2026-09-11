import {
  computeImageQuality,
  cropFrame,
  gradeContrast,
  gradeExposure,
  gradeGlare,
  gradeSharpness,
  refuseOnImageQuality,
  type ImageQualityMetrics,
} from '../../video/image-quality';
import { makeTexture } from './synthetic';

const WIDTH = 64;
const HEIGHT = 48;

function uniformFrame(value: number, width = WIDTH, height = HEIGHT): Float32Array {
  return new Float32Array(width * height).fill(value);
}

function texturedFrame(width = WIDTH, height = HEIGHT): Float32Array {
  const texture = makeTexture(width, height, 7);
  const frame = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      frame[y * width + x] = texture(x, y);
    }
  }
  return frame;
}

describe('computeImageQuality', () => {
  it('reads a uniform frame as flat: near-zero contrast and blur, no dark/saturated/glare pixels', () => {
    const metrics = computeImageQuality(uniformFrame(128), WIDTH, HEIGHT);
    expect(metrics.meanLuminance).toBeCloseTo(128, 6);
    expect(metrics.darkPixelFraction).toBe(0);
    expect(metrics.saturatedPixelFraction).toBe(0);
    expect(metrics.localContrast).toBeCloseTo(0, 6);
    expect(metrics.blurScore).toBeCloseTo(0, 6);
    expect(metrics.glareScore).toBe(0);
  });

  it('reads a genuinely textured frame as having real contrast and sharpness', () => {
    const metrics = computeImageQuality(texturedFrame(), WIDTH, HEIGHT);
    expect(metrics.localContrast).toBeGreaterThan(5);
    expect(metrics.blurScore).toBeGreaterThan(10);
    expect(refuseOnImageQuality(metrics)).toBeNull();
  });

  it('flags a dark frame as underexposed', () => {
    const frame = uniformFrame(3);
    // A little texture so this isn't also caught by the blur/contrast floors —
    // underexposure should be checked first regardless.
    for (let i = 0; i < frame.length; i += 2) frame[i] = 8;
    const metrics = computeImageQuality(frame, WIDTH, HEIGHT);
    expect(metrics.meanLuminance).toBeLessThan(10);
    expect(refuseOnImageQuality(metrics)).toBe('UNDEREXPOSED_VIDEO');
  });

  it('flags a mostly-flat, saturated frame as excessive glare', () => {
    const frame = texturedFrame();
    // Force a large bright, flat patch — a specular highlight, not real texture.
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < Math.floor(WIDTH * 0.6); x += 1) {
        frame[y * WIDTH + x] = 253;
      }
    }
    const metrics = computeImageQuality(frame, WIDTH, HEIGHT);
    expect(metrics.glareScore).toBeGreaterThan(0.35);
    expect(refuseOnImageQuality(metrics)).toBe('EXCESSIVE_GLARE');
  });

  it('flags a flat, textureless frame as insufficient contrast, not motion blur', () => {
    const metrics = computeImageQuality(uniformFrame(150), WIDTH, HEIGHT);
    // Both blurScore and localContrast are ~0 for a perfectly uniform frame,
    // but contrast is checked first: a sharp photo of glass-flat water has no
    // edges to begin with, which is a texture problem, not a focus problem.
    expect(refuseOnImageQuality(metrics)).toBe('INSUFFICIENT_SURFACE_CONTRAST');
  });

  it('never refuses a healthy textured frame', () => {
    const metrics = computeImageQuality(texturedFrame(128, 96), 128, 96);
    expect(refuseOnImageQuality(metrics)).toBeNull();
  });
});

describe('cropFrame', () => {
  it('extracts exactly the requested region, row by row', () => {
    // 4x3 frame, values = row*10+col, so the crop's contents are checkable by hand.
    const frame = new Float32Array([
      0, 1, 2, 3, //
      10, 11, 12, 13, //
      20, 21, 22, 23,
    ]);
    const cropped = cropFrame(frame, 4, 3, { x0: 1, y0: 0, x1: 3, y1: 2 });
    expect(cropped.width).toBe(2);
    expect(cropped.height).toBe(2);
    expect(Array.from(cropped.data)).toEqual([1, 2, 11, 12]);
  });

  it('clamps a region that overshoots the frame instead of reading out of bounds', () => {
    const frame = new Float32Array(4 * 3).fill(5);
    const cropped = cropFrame(frame, 4, 3, { x0: -10, y0: -10, x1: 100, y1: 100 });
    expect(cropped.width).toBe(4);
    expect(cropped.height).toBe(3);
  });
});

describe('quality bands', () => {
  const base: ImageQualityMetrics = {
    meanLuminance: 128,
    darkPixelFraction: 0,
    saturatedPixelFraction: 0,
    localContrast: 10,
    blurScore: 30,
    glareScore: 0,
    sampleWidth: WIDTH,
    sampleHeight: HEIGHT,
  };

  it('grades exposure by dark-pixel fraction', () => {
    expect(gradeExposure({ ...base, darkPixelFraction: 0.05 })).toBe('GOOD');
    expect(gradeExposure({ ...base, darkPixelFraction: 0.25 })).toBe('ACCEPTABLE');
    expect(gradeExposure({ ...base, darkPixelFraction: 0.6 })).toBe('POOR');
  });

  it('grades contrast by the block-median standard deviation', () => {
    expect(gradeContrast({ ...base, localContrast: 8 })).toBe('GOOD');
    expect(gradeContrast({ ...base, localContrast: 4 })).toBe('ACCEPTABLE');
    expect(gradeContrast({ ...base, localContrast: 1 })).toBe('POOR');
  });

  it('grades sharpness by the Laplacian variance', () => {
    expect(gradeSharpness({ ...base, blurScore: 25 })).toBe('GOOD');
    expect(gradeSharpness({ ...base, blurScore: 10 })).toBe('ACCEPTABLE');
    expect(gradeSharpness({ ...base, blurScore: 2 })).toBe('POOR');
  });

  it('grades glare by the flat-bright pixel fraction', () => {
    expect(gradeGlare({ ...base, glareScore: 0.01 })).toBe('LOW');
    expect(gradeGlare({ ...base, glareScore: 0.1 })).toBe('MODERATE');
    expect(gradeGlare({ ...base, glareScore: 0.3 })).toBe('HIGH');
  });
});
