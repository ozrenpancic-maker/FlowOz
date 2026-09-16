import { probeSpacing } from '../../video/pilot';
import { analyse } from '../../video/ssiv-core';
import { makeClip, TEST_DIMENSIONS, TEST_ROI } from './synthetic';

/**
 * Water whose surface partly renews between the two frames of a pair, rather
 * than only travelling.
 *
 * This was built to test a suspicion about the field refusals, which all share
 * one shape: a median grid correlation of 0.37 to 0.48 against the 0.55 floor,
 * nearly every vector dropped as LOW_CORRELATION, and a displacement that
 * should have been squarely inside the search range. The suspicion was that
 * the floor is throwing away real matches on broken water.
 *
 * It did not hold up. A linear blend of the travelled pattern with a fresh one
 * does not push the correlation anywhere near the field's 0.4s — the
 * correlation stays around 0.65 even when four fifths of the window is
 * replaced — so this reproduces a partly renewing surface but not the regime
 * the field clips are in, and is no evidence for moving the floor. What it
 * does pin down is the behaviour either side of the point where the true peak
 * stops winning, which is worth keeping.
 */
describe('a surface that partly renews between frames', () => {
  const EXPECTED_VELOCITY = (4 * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;

  it('costs correlation', () => {
    const clean = probeSpacing(makeClip({ shiftY: 4, frameDeltaS: 0.1 }).pairs[0]!, TEST_ROI);
    const renewing = probeSpacing(
      makeClip({ shiftY: 4, frameDeltaS: 0.1, surfaceRenewal: 0.5 }).pairs[0]!,
      TEST_ROI
    );
    expect(clean.medianCorrelation).toBeGreaterThan(0.95);
    expect(renewing.medianCorrelation).toBeLessThan(clean.medianCorrelation);
  });

  it('is still measured correctly while the true peak wins', () => {
    const clip = makeClip({ shiftY: 4, frameDeltaS: 0.1, surfaceRenewal: 0.5 });
    const probe = probeSpacing(clip.pairs[0]!, TEST_ROI);
    // Half the window renewed, and the pilot still reads the travel as the
    // real one — loosely, because a pilot median over one pair carries the
    // noise of the nodes the pattern no longer holds.
    expect(Math.abs(probe.medianDisplacementPx - 4)).toBeLessThan(2);

    const result = analyse({ clip, roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceVelocity).toBeCloseTo(EXPECTED_VELOCITY, 1);
  });

  it('is refused, not guessed at, once the true peak stops winning', () => {
    // Past that point the grid's own displacement runs away to the edge of the
    // search range — noise outscoring what is left of the pattern. The run has
    // to refuse rather than report where the noise happened to land.
    const clip = makeClip({ shiftY: 4, frameDeltaS: 0.1, surfaceRenewal: 0.75 });
    const probe = probeSpacing(clip.pairs[0]!, TEST_ROI);
    expect(probe.medianDisplacementPx).toBeGreaterThan(10);

    const result = analyse({ clip, roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(false);
  });
});
