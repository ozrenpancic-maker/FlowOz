import { correlateAt, extractPatch, findPeak, prepareGrid, type Grid } from '../../video/ncc';

/** A single soft blob on a plain ground, at a chosen position. */
function blob(width: number, height: number, bx: number, by: number): Grid {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const r2 = (x - bx) ** 2 + (y - by) ** 2;
      data[y * width + x] = 128 + 90 * Math.exp(-r2 / 18);
    }
  }
  return { data, width, height };
}

/** Vertical stripes: a pattern that genuinely repeats, so matches are ambiguous. */
function stripes(width: number, height: number, period: number, shift = 0): Grid {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] =
        128 +
        100 * Math.sin((2 * Math.PI * (x - shift)) / period) +
        18 * Math.sin((2 * Math.PI * y) / 17);
    }
  }
  return { data, width, height };
}

describe('correlation peak', () => {
  it('finds a known displacement to sub-pixel accuracy', () => {
    const first = blob(120, 80, 60, 40);
    const second = blob(120, 80, 63.4, 41.7);
    const patch = extractPatch(first, 60, 40, 24);
    expect(patch).not.toBeNull();
    if (!patch) return;

    const peak = findPeak(patch, prepareGrid(second), 60, 40, 12);
    expect(peak).not.toBeNull();
    if (!peak) return;
    expect(peak.subDx).toBeCloseTo(3.4, 0);
    expect(peak.subDy).toBeCloseTo(1.7, 0);
    expect(peak.correlation).toBeGreaterThan(0.9);
  });

  it('treats an anti-correlated runner-up as no competitor at all', () => {
    // Two mirrored blobs put a strong negative lobe on the correlation surface
    // while nothing else comes near the true peak. Scoring the peak against the
    // magnitude of that lobe would read as a close contest and reject a match
    // that is in fact unambiguous.
    const width = 90;
    const height = 60;
    const first = blob(width, height, 45, 30);
    const second = blob(width, height, 48, 30);
    const patch = extractPatch(first, 45, 30, 24);
    expect(patch).not.toBeNull();
    if (!patch) return;

    const prepared = prepareGrid(second);
    const peak = findPeak(patch, prepared, 45, 30, 12);
    expect(peak).not.toBeNull();
    if (!peak) return;

    let mostNegative = Infinity;
    for (let dy = -12; dy <= 12; dy += 1) {
      for (let dx = -12; dx <= 12; dx += 1) {
        const value = correlateAt(patch, prepared, 45 + dx, 30 + dy);
        if (Number.isFinite(value) && value < mostNegative) mostNegative = value;
      }
    }

    expect(mostNegative).toBeLessThan(0);
    // Scored against the best positive competitor, so a negative lobe — however
    // deep — can never push the ratio below the acceptance floor.
    expect(peak.peakRatio).toBeGreaterThan(1);
  });

  it('still reports a weak ratio when the pattern really is ambiguous', () => {
    const period = 16;
    const patch = extractPatch(stripes(120, 80, period, 0), 60, 40, 24);
    expect(patch).not.toBeNull();
    if (!patch) return;

    const peak = findPeak(patch, prepareGrid(stripes(120, 80, period, 3)), 60, 40, 12);
    expect(peak).not.toBeNull();
    if (!peak) return;
    // A repeating pattern offers a near-equal match one period away, and that
    // is a real competitor: the ratio has to stay close to 1.
    expect(peak.peakRatio).toBeLessThan(1.1);
  });

  it('flags a match sitting on the edge of the search window', () => {
    const patch = extractPatch(blob(120, 80, 60, 40), 60, 40, 24);
    expect(patch).not.toBeNull();
    if (!patch) return;

    const peak = findPeak(patch, prepareGrid(blob(120, 80, 74, 40)), 60, 40, 12);
    expect(peak).not.toBeNull();
    if (!peak) return;
    expect(peak.atSearchEdge).toBe(true);
  });

  it('refuses a flat patch, which carries nothing to track', () => {
    const flat: Grid = { data: new Float32Array(120 * 80).fill(128), width: 120, height: 80 };
    expect(extractPatch(flat, 60, 40, 24)).toBeNull();
  });
});
