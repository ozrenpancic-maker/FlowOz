import {
  computeDisplayMapping,
  displayToSource,
  normalizedDisplayToSource,
  normalizedSourceToDisplay,
  sourceToDisplay,
  type FrameGeometry,
} from '../../domain/coordinate-transform';

describe('computeDisplayMapping', () => {
  it('returns null for degenerate geometry (zero or non-finite dimensions)', () => {
    expect(computeDisplayMapping({ sourceWidth: 0, sourceHeight: 100, displayWidth: 100, displayHeight: 100, fit: 'cover' })).toBeNull();
    expect(computeDisplayMapping({ sourceWidth: 100, sourceHeight: NaN, displayWidth: 100, displayHeight: 100, fit: 'cover' })).toBeNull();
  });

  it('picks the larger axis scale for cover, so the source overflows the box', () => {
    // Source 16:9 into a 4:3 display box: cover must scale by height (the
    // constraining axis) and crop width, not the other way round.
    const geometry: FrameGeometry = { sourceWidth: 1920, sourceHeight: 1080, displayWidth: 800, displayHeight: 800, fit: 'cover' };
    const mapping = computeDisplayMapping(geometry);
    expect(mapping).not.toBeNull();
    expect(mapping?.scale).toBeCloseTo(800 / 1080, 9);
    expect(mapping?.offsetX).toBeLessThan(0); // cropped on the sides
    expect(mapping?.offsetY).toBeCloseTo(0, 6);
  });

  it('picks the smaller axis scale for contain, so the source fits with letterboxing', () => {
    const geometry: FrameGeometry = { sourceWidth: 1920, sourceHeight: 1080, displayWidth: 800, displayHeight: 800, fit: 'contain' };
    const mapping = computeDisplayMapping(geometry);
    expect(mapping).not.toBeNull();
    expect(mapping?.scale).toBeCloseTo(800 / 1920, 9);
    expect(mapping?.offsetX).toBeCloseTo(0, 6);
    expect(mapping?.offsetY).toBeGreaterThan(0); // letterboxed top/bottom
  });

  it('has zero offset on both axes when the aspect ratios already match exactly', () => {
    const geometry: FrameGeometry = { sourceWidth: 1280, sourceHeight: 720, displayWidth: 400, displayHeight: 225, fit: 'cover' };
    const mapping = computeDisplayMapping(geometry);
    expect(mapping?.offsetX).toBeCloseTo(0, 9);
    expect(mapping?.offsetY).toBeCloseTo(0, 9);
  });
});

describe('displayToSource / sourceToDisplay round-trip', () => {
  const cases: Array<{ name: string; geometry: FrameGeometry }> = [
    { name: '1920x1080 source, cover, into a square display', geometry: { sourceWidth: 1920, sourceHeight: 1080, displayWidth: 400, displayHeight: 400, fit: 'cover' } },
    { name: '1080x1920 (portrait) source, cover, into a square display', geometry: { sourceWidth: 1080, sourceHeight: 1920, displayWidth: 400, displayHeight: 400, fit: 'cover' } },
    { name: '4:3 source, contain, into a 16:9 display', geometry: { sourceWidth: 640, sourceHeight: 480, displayWidth: 480, displayHeight: 270, fit: 'contain' } },
    { name: '16:9 source, contain, into a 4:3 display', geometry: { sourceWidth: 1280, sourceHeight: 720, displayWidth: 480, displayHeight: 360, fit: 'contain' } },
    { name: 'portrait source, cover, into a landscape display', geometry: { sourceWidth: 720, sourceHeight: 1280, displayWidth: 500, displayHeight: 300, fit: 'cover' } },
    { name: 'landscape source, cover, into a portrait display', geometry: { sourceWidth: 1280, sourceHeight: 720, displayWidth: 300, displayHeight: 500, fit: 'cover' } },
    { name: 'exactly matching aspect ratio (no crop, no letterbox)', geometry: { sourceWidth: 1280, sourceHeight: 720, displayWidth: 320, displayHeight: 180, fit: 'cover' } },
  ];

  for (const { name, geometry } of cases) {
    it(`maps a source-frame point through to display and back to the same source pixel — ${name}`, () => {
      const sourcePoints = [
        { x: 0, y: 0 },
        { x: geometry.sourceWidth, y: geometry.sourceHeight },
        { x: geometry.sourceWidth / 2, y: geometry.sourceHeight / 2 },
        { x: geometry.sourceWidth * 0.25, y: geometry.sourceHeight * 0.75 },
      ];
      for (const source of sourcePoints) {
        const display = sourceToDisplay(source, geometry);
        expect(display).not.toBeNull();
        if (!display) continue;
        const roundTripped = displayToSource(display, geometry);
        expect(roundTripped).not.toBeNull();
        if (!roundTripped) continue;
        expect(roundTripped.x).toBeCloseTo(source.x, 6);
        expect(roundTripped.y).toBeCloseTo(source.y, 6);
      }
    });
  }

  it('a point tapped at the centre of the display box always lands at the centre of the source frame', () => {
    for (const { geometry } of cases) {
      const centreDisplay = { x: geometry.displayWidth / 2, y: geometry.displayHeight / 2 };
      const source = displayToSource(centreDisplay, geometry);
      expect(source).not.toBeNull();
      if (!source) continue;
      expect(source.x).toBeCloseTo(geometry.sourceWidth / 2, 3);
      expect(source.y).toBeCloseTo(geometry.sourceHeight / 2, 3);
    }
  });

  it('rejects a contain-fitted point that falls inside the letterbox bar, rather than inventing a source pixel', () => {
    // Square source into a wide display, contain: letterboxed left/right.
    const geometry: FrameGeometry = { sourceWidth: 400, sourceHeight: 400, displayWidth: 800, displayHeight: 400, fit: 'contain' };
    // (0,0) in display space sits in the left letterbox bar (content starts at x=200).
    expect(displayToSource({ x: 0, y: 0 }, geometry)).toBeNull();
    // The centre of the display box is inside the actual content.
    expect(displayToSource({ x: 400, y: 200 }, geometry)).not.toBeNull();
  });

  it('never rejects a cover-fitted point inside the display box — cover always has content under every pixel', () => {
    const geometry: FrameGeometry = { sourceWidth: 1920, sourceHeight: 1080, displayWidth: 300, displayHeight: 700, fit: 'cover' };
    for (const point of [{ x: 0, y: 0 }, { x: 300, y: 700 }, { x: 150, y: 350 }]) {
      expect(displayToSource(point, geometry)).not.toBeNull();
    }
  });
});

describe('normalizedDisplayToSource / normalizedSourceToDisplay', () => {
  it('is the identity when the display and source aspect ratios already match', () => {
    const geometry = { sourceWidth: 1280, sourceHeight: 720, displayWidth: 320, displayHeight: 180, fit: 'cover' as const };
    for (const point of [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.5 }, { x: 0, y: 0 }, { x: 1, y: 1 }]) {
      const source = normalizedDisplayToSource(point, geometry);
      expect(source?.x).toBeCloseTo(point.x, 9);
      expect(source?.y).toBeCloseTo(point.y, 9);
    }
  });

  it('correctly un-crops a tap on a cover-fitted mismatched-aspect-ratio preview', () => {
    // 16:9 source shown "cover" in a square box: height is the binding axis
    // (it takes the larger of the two candidate scales), so the box shows
    // the full height with the left/right edges of the wide source cropped
    // away. A tap at the very left edge of the box must map to a source x
    // well to the right of 0, not to 0 itself.
    const geometry = { sourceWidth: 1920, sourceHeight: 1080, displayWidth: 400, displayHeight: 400, fit: 'cover' as const };
    const leftOfBox = normalizedDisplayToSource({ x: 0, y: 0.5 }, geometry);
    expect(leftOfBox).not.toBeNull();
    expect(leftOfBox?.x).toBeGreaterThan(0);
    expect(leftOfBox?.x).toBeLessThan(0.5);
    // The full height is visible (no vertical crop): top of the box is
    // exactly the top of the source.
    const topOfBox = normalizedDisplayToSource({ x: 0.5, y: 0 }, geometry);
    expect(topOfBox?.y).toBeCloseTo(0, 6);
  });

  it('round-trips a source-normalised point through source->display->source', () => {
    const geometry = { sourceWidth: 1080, sourceHeight: 1920, displayWidth: 400, displayHeight: 300, fit: 'cover' as const };
    const original = { x: 0.3, y: 0.6 };
    const display = normalizedSourceToDisplay(original, geometry);
    expect(display).not.toBeNull();
    if (!display) return;
    const roundTripped = normalizedDisplayToSource(display, geometry);
    expect(roundTripped?.x).toBeCloseTo(original.x, 6);
    expect(roundTripped?.y).toBeCloseTo(original.y, 6);
  });
});
