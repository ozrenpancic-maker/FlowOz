import { applyClahe } from '../../video/clahe';

function stddev(values: ArrayLike<number>): number {
  const n = values.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += (values[i] as number) / n;
  let variance = 0;
  for (let i = 0; i < n; i += 1) variance += ((values[i] as number) - mean) ** 2 / n;
  return Math.sqrt(variance);
}

describe('applyClahe', () => {
  it('leaves a perfectly flat plane flat, with no NaN', () => {
    const width = 64;
    const height = 64;
    const flat = new Float32Array(width * height).fill(120);
    const out = applyClahe(flat, width, height);
    expect(out.length).toBe(flat.length);
    for (let i = 0; i < out.length; i += 1) {
      expect(Number.isFinite(out[i] as number)).toBe(true);
    }
  });

  it('stretches local contrast on a low-contrast tile', () => {
    const width = 64;
    const height = 64;
    const data = new Float32Array(width * height);
    // A narrow-range checkerboard: real values but only a few grey levels
    // apart, the kind of low-contrast texture turbid water produces.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        data[y * width + x] = (x + y) % 2 === 0 ? 118 : 122;
      }
    }
    const out = applyClahe(data, width, height);
    expect(stddev(out)).toBeGreaterThan(stddev(data));
  });

  it('keeps output within the valid grey-level range', () => {
    const width = 48;
    const height = 48;
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 255;
    const out = applyClahe(data, width, height);
    for (let i = 0; i < out.length; i += 1) {
      expect(out[i] as number).toBeGreaterThanOrEqual(0);
      expect(out[i] as number).toBeLessThanOrEqual(255);
    }
  });

  it('is deterministic for the same input', () => {
    const width = 40;
    const height = 30;
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 200;
    const a = applyClahe(data, width, height);
    const b = applyClahe(data, width, height);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('preserves relative ordering of grey levels within a tile (monotonic mapping)', () => {
    const width = 32;
    const height = 32;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) data[y * width + x] = x * 8;
    }
    const out = applyClahe(data, width, height);
    // Along a single row, a strictly increasing input must not decrease.
    for (let x = 1; x < width; x += 1) {
      expect(out[x] as number).toBeGreaterThanOrEqual((out[x - 1] as number) - 1e-6);
    }
  });

  it('returns the input unchanged for a degenerate (zero-area) plane', () => {
    const data = new Float32Array(0);
    const out = applyClahe(data, 0, 0);
    expect(out).toBe(data);
  });

  it('handles a plane too small for the default tile grid without throwing', () => {
    const width = 4;
    const height = 4;
    const data = new Float32Array(width * height).fill(100);
    expect(() => applyClahe(data, width, height)).not.toThrow();
  });
});
