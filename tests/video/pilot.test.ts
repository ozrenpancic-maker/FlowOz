import { suppressStaticBackground } from '../../video/background';
import { planPilotPairs, pilotSpacings } from '../../video/frame-plan';
import {
  chooseSpacing,
  describeSpacingProbes,
  probeLadder,
  probeSpacing,
  TARGET_DISPLACEMENT_PX,
  type SpacingProbe,
} from '../../video/pilot';
import { analyse } from '../../video/ssiv-core';
import { SSIV_THRESHOLDS } from '../../video/types';
import { makeClip, TEST_DIMENSIONS, TEST_ROI } from './synthetic';

/** Metres of real channel one working pixel covers on the synthetic ROI. */
const METRES_PER_PIXEL = TEST_DIMENSIONS.lengthM / 81;

function probe(overrides: Partial<SpacingProbe>): SpacingProbe {
  return {
    frameDeltaS: 0.1,
    medianDisplacementPx: TARGET_DISPLACEMENT_PX,
    medianCorrelation: 0.9,
    usableVectors: 20,
    atSearchEdge: 0,
    stabilised: true,
    ...overrides,
  };
}

describe('pilot spacing ladder', () => {
  it('doubles each rung and stops at the ceiling', () => {
    const spacings = pilotSpacings(60);
    expect(spacings[0]).toBeCloseTo(SSIV_THRESHOLDS.minFrameDeltaS, 6);
    for (let i = 1; i < spacings.length; i += 1) {
      expect(spacings[i] as number).toBeCloseTo((spacings[i - 1] as number) * 2, 6);
    }
    expect(Math.max(...spacings)).toBeLessThanOrEqual(SSIV_THRESHOLDS.pilotMaxFrameDeltaS);
    // A ladder worth having spans more than a single velocity band.
    expect(spacings.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps only the rungs a short clip can actually hold', () => {
    const spacings = pilotSpacings(1);
    expect(spacings.length).toBeGreaterThan(0);
    for (const spacing of spacings) expect(spacing).toBeLessThan(1);
    expect(Math.max(...spacings)).toBeLessThan(Math.max(...pilotSpacings(60)));
  });

  it('places one pair per rung, inside the clip', () => {
    const plan = planPilotPairs(30);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.pairs).toHaveLength(pilotSpacings(30).length);
    for (const pair of plan.pairs) {
      expect(pair.firstS).toBeGreaterThanOrEqual(0);
      expect(pair.secondS).toBeLessThanOrEqual(30);
      expect(pair.secondS - pair.firstS).toBeCloseTo(pair.frameDeltaS, 6);
    }
  });

  it('refuses a clip too short for even the shortest rung', () => {
    const plan = planPilotPairs(0.05);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe('CLIP_TOO_SHORT');
  });
});

describe('reading the displacement a spacing produces', () => {
  it('recovers a known displacement from a clip', () => {
    const clip = makeClip({ shiftY: 4, frameDeltaS: 0.1 });
    const result = probeSpacing(clip.pairs[0]!, TEST_ROI);
    expect(result.medianDisplacementPx).toBeCloseTo(4, 0);
    expect(result.usableVectors).toBeGreaterThanOrEqual(SSIV_THRESHOLDS.minAcceptedVectors);
    expect(result.frameDeltaS).toBeCloseTo(0.1, 6);
  });

  it('scales with the spacing, which is the whole point of the ladder', () => {
    const slow = probeSpacing(makeClip({ shiftY: 2, frameDeltaS: 0.1 }).pairs[0]!, TEST_ROI);
    const fast = probeSpacing(makeClip({ shiftY: 8, frameDeltaS: 0.4 }).pairs[0]!, TEST_ROI);
    expect(fast.medianDisplacementPx / slow.medianDisplacementPx).toBeCloseTo(4, 0);
  });
});

describe('probing the ladder the way the real run measures', () => {
  // The field failure these hold shut: a stone channel independently timed at
  // 0.83 m/s, where the pilot read tenths of a pixel at every short rung,
  // disqualified them for being sub-pixel and walked out to 0.96 s — a
  // spacing at which that water crosses over a hundred pixels against a 24 px
  // search, so nothing correlated and the run returned no vectors at all.
  const bedClip = () => makeClip({ shiftY: 6, visibleBed: { movingAmplitude: 0.3 } });

  it('measures the water, not the streambed showing through it', () => {
    const probes = probeLadder(bedClip().pairs, TEST_ROI);
    expect(probes).toHaveLength(6);
    for (const probe of probes) {
      expect(probe.medianDisplacementPx).toBeCloseTo(6, 0);
      expect(probe.usableVectors).toBeGreaterThanOrEqual(SSIV_THRESHOLDS.minAcceptedVectors);
    }
  });

  it('leaves the displacement alone on water with no bed under it', () => {
    const probes = probeLadder(makeClip({ shiftY: 4 }).pairs, TEST_ROI);
    for (const probe of probes) expect(probe.medianDisplacementPx).toBeCloseTo(4, 0);
  });

  it('keeps the ladder measurable, so a bed can no longer send it to the long end', () => {
    const chosen = chooseSpacing(probeLadder(bedClip().pairs, TEST_ROI));
    expect(chosen).not.toBeNull();
    // Every rung of this clip carries the same 6 px, so the choice must rest
    // on a real displacement rather than on the sub-pixel reading a visible
    // bed used to produce.
    expect(chosen!.medianDisplacementPx).toBeGreaterThan(1);
  });

  it('takes the camera motion from the frames that still have scenery in them', () => {
    // Suppression erases the bank the anchors track. Re-measuring the motion
    // from the suppressed frames reported a camera moving 5.84 px on a clip
    // shot from a tripod, which then cancelled the water's own 6.02 px.
    const pairs = bedClip().pairs;
    const viaLadder = probeLadder(pairs, TEST_ROI)[0] as SpacingProbe;
    const reMeasured = probeSpacing(
      suppressStaticBackground(pairs).pairs[0] as typeof pairs[number],
      TEST_ROI
    );
    expect(viaLadder.medianDisplacementPx).toBeCloseTo(6, 0);
    expect(reMeasured.medianDisplacementPx).toBeLessThan(1);
  });
});

describe('choosing the spacing to measure at', () => {
  it('takes the rung closest to the target displacement', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 0.4 }),
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 1.6 }),
      probe({ frameDeltaS: 0.24, medianDisplacementPx: TARGET_DISPLACEMENT_PX }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: 17 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.24, 6);
  });

  it('will not choose a rung whose displacement is below one pixel', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 0.2 }),
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 2 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.12, 6);
  });

  it('will not choose a rung the search could not follow', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 3 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: SSIV_THRESHOLDS.searchRadiusPx }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.12, 6);
  });

  it('ignores a rung that barely correlated at all', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 2 }),
      probe({ frameDeltaS: 0.96, medianDisplacementPx: TARGET_DISPLACEMENT_PX, usableVectors: 1 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.12, 6);
  });

  it('reaches for the longest rung when everything came out sub-pixel', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 0.1 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: 0.6 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.48, 6);
  });

  it('falls back to the shortest rung when every one outran the search', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 22, atSearchEdge: 19, usableVectors: 1 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: 23, atSearchEdge: 20, usableVectors: 0 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.12, 6);
  });

  it('passes over a rung whose camera motion could not be measured', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 2 }),
      probe({
        frameDeltaS: 0.96,
        medianDisplacementPx: TARGET_DISPLACEMENT_PX,
        stabilised: false,
      }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.12, 6);
  });

  it('still chooses on displacement when no rung stabilised at all', () => {
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 2, stabilised: false }),
      probe({
        frameDeltaS: 0.48,
        medianDisplacementPx: TARGET_DISPLACEMENT_PX,
        stabilised: false,
      }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.48, 6);
  });

  it('takes the shortest rung when no rung correlated well enough to measure', () => {
    // What water too fast for the ladder actually looks like: not a large
    // displacement, but nothing at all, because nothing correlates. Reading
    // that silence as "nobody was too fast" and reaching for the longest
    // spacing is how two field clips came to run at 0.240 s and 0.480 s on a
    // 0.005 m/px scale, where water near 0.8 m/s crosses 40 and 80 pixels
    // against a 24 pixel search range.
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: Number.NaN, usableVectors: 0 }),
      probe({ frameDeltaS: 0.12, medianDisplacementPx: Number.NaN, usableVectors: 0 }),
      probe({ frameDeltaS: 0.24, medianDisplacementPx: Number.NaN, usableVectors: 0 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: Number.NaN, usableVectors: 0 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.06, 6);
  });

  it('goes long only on a rung that measured the water barely moving', () => {
    // One rung correlated and found the travel genuinely under a pixel; the
    // rest found nothing. That is the one shape of evidence that earns a
    // longer spacing.
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 0.3 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: Number.NaN, usableVectors: 0 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.48, 6);
  });

  it('will not run at a spacing its own correlation floor would refuse', () => {
    // A field ladder, verbatim. The 0.120 s rung won on displacement alone —
    // 7.66 px against a 6 px target — while correlating at 0.27 against a
    // floor of 0.35, and the run it chose returned one vector out of a
    // hundred. The 0.060 s rung it beat sat above the floor with fourteen
    // usable vectors, and is where that water is measurable.
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 3.39, medianCorrelation: 0.39, usableVectors: 14 }),
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 7.66, medianCorrelation: 0.27, usableVectors: 4, atSearchEdge: 2 }),
      probe({ frameDeltaS: 0.24, medianDisplacementPx: 3.17, medianCorrelation: 0.29, usableVectors: 3, atSearchEdge: 2 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: Number.NaN, medianCorrelation: 0.28, usableVectors: 0, atSearchEdge: 4 }),
      probe({ frameDeltaS: 0.96, medianDisplacementPx: 5.45, medianCorrelation: 0.29, usableVectors: 3, atSearchEdge: 2 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.06, 6);
  });

  it('stays short when the rungs it would reach for have lost the pattern', () => {
    // A field ladder, verbatim, from a channel independently timed at
    // 0.83 m/s. Only the shortest rung had enough usable vectors to say
    // anything, and it read sub-pixel — so by displacement alone the water
    // looked too slow to see. Every longer rung had already fallen under the
    // correlation floor, which is the surface ceasing to look like itself,
    // not water standing still. The run went to 0.960 s, where that water
    // crosses fifty pixels against a 24 px search, and returned nothing.
    const chosen = chooseSpacing([
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 0.66, medianCorrelation: 0.4, usableVectors: 13 }),
      probe({ frameDeltaS: 0.12, medianDisplacementPx: 0.07, medianCorrelation: 0.25, usableVectors: 2, atSearchEdge: 2 }),
      probe({ frameDeltaS: 0.24, medianDisplacementPx: Number.NaN, medianCorrelation: 0.19, usableVectors: 0 }),
      probe({ frameDeltaS: 0.48, medianDisplacementPx: 0.24, medianCorrelation: 0.19, usableVectors: 1, atSearchEdge: 3 }),
      probe({ frameDeltaS: 0.96, medianDisplacementPx: 0.13, medianCorrelation: 0.23, usableVectors: 2, atSearchEdge: 2 }),
    ]);
    expect(chosen?.frameDeltaS).toBeCloseTo(0.06, 6);
  });

  it('has nothing to say about an empty ladder', () => {
    expect(chooseSpacing([])).toBeNull();
  });
});

describe('the same water at two frame spacings', () => {
  // One physical velocity, sampled two ways: 0.6 px apart at 0.1 s, and the
  // identical motion 4.8 px apart at 0.8 s. This is the field failure in
  // miniature — the setup could not resolve the flow, and the only thing that
  // changed to make it measurable was how far apart the two frames were taken.
  const VELOCITY = (0.6 * METRES_PER_PIXEL) / 0.1;

  it('refuses the spacing that leaves the water inside one pixel', () => {
    const result = analyse({
      clip: makeClip({ shiftY: 0.6, frameDeltaS: 0.1 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Whatever the run calls it, it must not be a number: the point is that
    // no velocity is reported from a displacement that was never located.
    expect(['INSUFFICIENT_VALID_VECTORS', 'INSUFFICIENT_TEXTURE']).toContain(result.error.code);
  });

  it('measures that same water once the frames are taken further apart', () => {
    const result = analyse({
      clip: makeClip({ shiftY: 4.8, frameDeltaS: 0.8 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceVelocity).toBeCloseTo(VELOCITY, 2);
  });

  it('reports what one pixel of displacement was worth', () => {
    const result = analyse({
      clip: makeClip({ shiftY: 4.8, frameDeltaS: 0.8 }),
      roi: TEST_ROI,
      knownDimensions: TEST_DIMENSIONS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.quality.velocityResolutionMs).toBeCloseTo(METRES_PER_PIXEL / 0.8, 2);
  });
});

describe('describing the pilot ladder for a failure report', () => {
  it('marks the chosen rung and lists every probe', () => {
    const probes = [
      probe({ frameDeltaS: 0.06, medianDisplacementPx: 0.4, medianCorrelation: 0.9 }),
      probe({ frameDeltaS: 0.96, medianDisplacementPx: 19.1, medianCorrelation: 0.31, atSearchEdge: 5 }),
    ];
    const text = describeSpacingProbes(probes, probes[1] as SpacingProbe);
    expect(text).toContain('dt=0.060s');
    expect(text).toContain('*dt=0.960s');
    expect(text).toContain('d=19.10px');
    expect(text).toContain('edge=5');
  });

  it('says so when nothing was chosen', () => {
    const text = describeSpacingProbes([], null);
    expect(text).toBe('pilot ladder (* chosen): ');
  });
});
