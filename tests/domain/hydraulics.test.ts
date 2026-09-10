import { circularSection, rectangularSection } from '../../domain/geometry';
import { manningVelocity, manualFlow, toLitresPerSecond, videoFlow } from '../../domain/hydraulics';
import { activeAlpha, deriveAlpha } from '../../domain/calibration';
import { buildReport, checkValue } from '../../domain/plausibility';
import type { SectionProperties } from '../../domain/types';
import { DEFAULT_ALPHA } from '../../domain/types';

const section: SectionProperties = {
  area: 1,
  wettedPerimeter: 3,
  topWidth: 2,
  hydraulicRadius: 1 / 3,
};

describe('Manning', () => {
  it('computes V = (1/n)·Rh^(2/3)·S^(1/2) and Q = A·V', () => {
    const result = manningVelocity(section, 0.013, 5); // 5 ‰ → S = 0.005
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expectedV = (1 / 0.013) * Math.pow(1 / 3, 2 / 3) * Math.sqrt(0.005);
    expect(result.value.velocity).toBeCloseTo(expectedV, 12);
    expect(result.value.flow).toBeCloseTo(section.area * expectedV, 12);
    expect(result.value.slope).toBeCloseTo(0.005, 12);
  });

  it('converts the operator gradient from ‰, not from a fraction', () => {
    // 1000 ‰ is S = 1, which makes √S drop out of Manning entirely.
    const unitSlope = manningVelocity(section, 0.013, 1000);
    expect(unitSlope.ok).toBe(true);
    if (!unitSlope.ok) return;
    expect(unitSlope.value.slope).toBeCloseTo(1, 12);
    expect(unitSlope.value.velocity).toBeCloseTo((1 / 0.013) * Math.pow(1 / 3, 2 / 3), 12);

    // A hundredfold slope is a tenfold velocity.
    const gentle = manningVelocity(section, 0.013, 0.1);
    const steep = manningVelocity(section, 0.013, 10);
    expect(gentle.ok && steep.ok).toBe(true);
    if (!gentle.ok || !steep.ok) return;
    expect(steep.value.velocity / gentle.value.velocity).toBeCloseTo(10, 9);
  });

  it('refuses every non-finite or non-positive input', () => {
    expect(manningVelocity(section, 0, 5).ok).toBe(false);
    expect(manningVelocity(section, -0.01, 5).ok).toBe(false);
    expect(manningVelocity(section, 0.013, 0).ok).toBe(false);
    expect(manningVelocity(section, 0.013, -5).ok).toBe(false);
    expect(manningVelocity(section, Number.NaN, 5).ok).toBe(false);
    expect(manningVelocity({ ...section, area: 0 }, 0.013, 5).ok).toBe(false);
  });

  it('names the field the operator has to fix', () => {
    const result = manningVelocity(section, 0, 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_ROUGHNESS');
      expect(result.error.field).toBe('roughness');
    }
  });
});

describe('manual velocity', () => {
  it('multiplies the entered velocity by the area', () => {
    const result = manualFlow(section, 0.8);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.flow).toBeCloseTo(0.8, 12);
  });

  it('rejects a zero or negative velocity', () => {
    expect(manualFlow(section, 0).ok).toBe(false);
    expect(manualFlow(section, -1).ok).toBe(false);
  });
});

describe('video flow', () => {
  it('applies Vmean = α · Vsurface and Q = A · α · Vsurface', () => {
    const result = videoFlow(section, 1.2, 0.85);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.meanVelocity).toBeCloseTo(1.02, 12);
    expect(result.value.flow).toBeCloseTo(1.02, 12);
    expect(result.value.alpha).toBe(0.85);
  });

  it('carries alpha through so it can be reported', () => {
    const result = videoFlow(section, 1, 0.92);
    expect(result.ok && result.value.alpha).toBe(0.92);
  });

  it('rejects a non-positive alpha or surface velocity', () => {
    expect(videoFlow(section, 1.2, 0).ok).toBe(false);
    expect(videoFlow(section, 0, 0.85).ok).toBe(false);
    expect(videoFlow(section, Number.NaN, 0.85).ok).toBe(false);
  });

  it('agrees with the circular section it was computed from', () => {
    const circle = circularSection({ kind: 'circular', diameter: 0.5 }, 0.2);
    expect(circle.ok).toBe(true);
    if (!circle.ok) return;
    const result = videoFlow(circle.value, 0.9, 0.85);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.flow).toBeCloseTo(circle.value.area * 0.9 * 0.85, 12);
  });
});

describe('unit helper', () => {
  it('converts m³/s to l/s', () => {
    expect(toLitresPerSecond(0.0123)).toBeCloseTo(12.3, 9);
  });
});

describe('alpha calibration', () => {
  const base = {
    id: 'cal-1',
    createdAt: '2026-09-10T10:00:00.000Z',
    depth: 0.3,
    area: 0.5,
    surfaceVelocity: 1.0,
  };

  it('derives α = Qref / (A · Vsurface)', () => {
    const result = deriveAlpha({ ...base, referenceFlow: 0.425 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alpha).toBeCloseTo(0.85, 12);
    expect(result.value.valid).toBe(true);
  });

  it('flags a physically indefensible alpha instead of storing it as good', () => {
    const result = deriveAlpha({ ...base, referenceFlow: 5 }); // α = 10
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(false);
    expect(result.value.invalidReason).toBe('calibration.error.ALPHA_OUT_OF_RANGE');
  });

  it('rejects non-positive inputs with a typed error', () => {
    expect(deriveAlpha({ ...base, area: 0, referenceFlow: 1 }).ok).toBe(false);
    expect(deriveAlpha({ ...base, surfaceVelocity: 0, referenceFlow: 1 }).ok).toBe(false);
    expect(deriveAlpha({ ...base, referenceFlow: 0 }).ok).toBe(false);
  });

  it('keeps invalid points out of the active alpha', () => {
    const good = deriveAlpha({ ...base, id: 'a', referenceFlow: 0.4 });
    const alsoGood = deriveAlpha({ ...base, id: 'b', referenceFlow: 0.45 });
    const bad = deriveAlpha({ ...base, id: 'c', referenceFlow: 5 });
    expect(good.ok && alsoGood.ok && bad.ok).toBe(true);
    if (!good.ok || !alsoGood.ok || !bad.ok) return;

    const active = activeAlpha([good.value, alsoGood.value, bad.value]);
    expect(active.status).toBe('calibrated');
    expect(active.pointCount).toBe(2);
    expect(active.alpha).toBeCloseTo((0.8 + 0.9) / 2, 9);
  });

  it('falls back to the documented default when there is nothing valid', () => {
    expect(activeAlpha([]).alpha).toBe(DEFAULT_ALPHA);
    expect(activeAlpha([]).status).toBe('default');

    const bad = deriveAlpha({ ...base, referenceFlow: 5 });
    if (bad.ok) {
      const active = activeAlpha([bad.value]);
      expect(active.alpha).toBe(DEFAULT_ALPHA);
      expect(active.status).toBe('calibrating');
    }
  });
});

describe('plausibility limits', () => {
  it('blocks physically impossible values', () => {
    expect(checkValue('depth', -1)[0]?.severity).toBe('blocking');
    expect(checkValue('roughness', 0.001)[0]?.severity).toBe('blocking');
    expect(checkValue('velocity', 50)[0]?.severity).toBe('blocking');
    expect(checkValue('alpha', 5)[0]?.severity).toBe('blocking');
  });

  it('only advises on unusual but possible values', () => {
    const finding = checkValue('roughness', 0.3)[0];
    expect(finding?.severity).toBe('advisory');
    expect(finding?.code).toBe('UNUSUALLY_HIGH');
  });

  it('passes ordinary field values without comment', () => {
    expect(checkValue('roughness', 0.013)).toHaveLength(0);
    expect(checkValue('depth', 0.25)).toHaveLength(0);
    expect(checkValue('alpha', 0.85)).toHaveLength(0);
  });

  it('treats a non-finite number as blocking whatever the field', () => {
    expect(checkValue('anything-at-all', Number.NaN)[0]?.severity).toBe('blocking');
  });

  it('summarises a whole draft and separates advisories from blockers', () => {
    const report = buildReport({ depth: 0.2, roughness: 0.3, alpha: 0.85, velocity: null });
    expect(report.blocked).toBe(false);
    expect(report.advisories).toHaveLength(1);

    const blocked = buildReport({ depth: -1, roughness: 0.013 });
    expect(blocked.blocked).toBe(true);
  });

  it('never invents a finding for a value it was not given', () => {
    const report = buildReport({ depth: undefined, roughness: null });
    expect(report.findings).toHaveLength(0);
  });
});

describe('section sanity for the plausibility gate', () => {
  it('produces a positive hydraulic radius for a normal channel', () => {
    const result = rectangularSection({ kind: 'rectangular', width: 1.2 }, 0.3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hydraulicRadius).toBeGreaterThan(0);
  });
});
