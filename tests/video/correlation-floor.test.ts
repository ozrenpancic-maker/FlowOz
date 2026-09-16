import { analyse } from '../../video/ssiv-core';
import { SSIV_THRESHOLDS } from '../../video/types';
import { makeClip, TEST_DIMENSIONS, TEST_ROI } from './synthetic';

/**
 * Where the correlation floor has to sit, measured rather than chosen.
 *
 * The floor's job is to keep noise out. What it must not do is keep out water
 * whose pattern only partly survives between frames, which is what every
 * refused field clip turned out to be: median grid correlations of 0.37 to
 * 0.49 against a 0.55 floor, with the displacement squarely inside the search
 * range at the spacing the pilot had chosen.
 *
 * These are the two edges of the band the floor has to sit between. Both are
 * run through the whole pipeline against a known true velocity, so a change
 * to the floor that breaks either shows up here rather than in the field.
 */
describe('the correlation floor', () => {
  const TRUE_VELOCITY = (4 * (TEST_DIMENSIONS.lengthM / 81)) / 0.1;

  it('keeps out a clip with no real motion in it at all', () => {
    // Every frame's surface replaced outright: there is no displacement to
    // find, so any velocity reported would be pure invention. At a floor of
    // 0.20 this clip reported 6.4 m/s.
    const clip = makeClip({ shiftY: 4, frameDeltaS: 0.1, surfaceRenewal: 1 });
    const result = analyse({ clip, roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(false);
  });

  it('still measures water whose surface mostly renews between frames', () => {
    // Seven tenths of the pattern replaced — well past what the old 0.55
    // floor would pass, and the velocity is still there to be found.
    const clip = makeClip({ shiftY: 4, frameDeltaS: 0.1, surfaceRenewal: 0.7 });
    const result = analyse({ clip, roi: TEST_ROI, knownDimensions: TEST_DIMENSIONS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.value.surfaceVelocity - TRUE_VELOCITY) / TRUE_VELOCITY).toBeLessThan(0.15);
  });

  it('is still a floor, not an absence of one', () => {
    expect(SSIV_THRESHOLDS.minCorrelation).toBeGreaterThanOrEqual(0.25);
    expect(SSIV_THRESHOLDS.minCorrelation).toBeLessThanOrEqual(0.4);
  });
});
