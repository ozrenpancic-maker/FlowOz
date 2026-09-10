import {
  CUSTOM_ROUGHNESS_ID,
  ROUGHNESS_MATERIALS,
  findMaterial,
  isOutsideBand,
  materialForRoughness,
  materialLabelKey,
} from '../../domain/roughness';
import { manningVelocity } from '../../domain/hydraulics';
import {
  degreesToPermille,
  permilleToDegrees,
  permilleToSlope,
  isSlopeUnit,
} from '../../domain/units';
import { en } from '../../state/i18n/en';
import { hr } from '../../state/i18n/hr';

describe('roughness catalogue', () => {
  it('keeps every working value inside its own published band', () => {
    for (const material of ROUGHNESS_MATERIALS) {
      expect(material.minN).toBeLessThanOrEqual(material.n);
      expect(material.n).toBeLessThanOrEqual(material.maxN);
      expect(material.minN).toBeGreaterThan(0);
    }
  });

  it('gives every material a name in both locales', () => {
    for (const material of ROUGHNESS_MATERIALS) {
      const key = materialLabelKey(material.id);
      expect(en[key as keyof typeof en]).toBeDefined();
      expect(hr[key as keyof typeof hr]).toBeDefined();
    }
    expect(en['material.custom' as keyof typeof en]).toBeDefined();
    expect(hr['material.custom' as keyof typeof hr]).toBeDefined();
  });

  it('uses ids that are unique, so a saved measurement resolves to one material', () => {
    const ids = ROUGHNESS_MATERIALS.map((material) => material.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(CUSTOM_ROUGHNESS_ID);
  });

  it('resolves a known id and refuses an unknown one', () => {
    expect(findMaterial('concrete-smooth')?.n).toBeCloseTo(0.012, 9);
    expect(findMaterial('no-such-material')).toBeNull();
    expect(findMaterial(undefined)).toBeNull();
    expect(materialForRoughness(0.024)?.id).toBe('corrugated-metal');
    expect(materialForRoughness(0.0999)).toBeNull();
  });

  it('flags an n typed outside the band of the chosen material', () => {
    const concrete = findMaterial('concrete-smooth');
    expect(concrete).not.toBeNull();
    if (!concrete) return;
    expect(isOutsideBand(concrete, 0.012)).toBe(false);
    expect(isOutsideBand(concrete, 0.011)).toBe(false);
    expect(isOutsideBand(concrete, 0.03)).toBe(true);
  });

  it('spans a plausible velocity range across the catalogue', () => {
    const section = { area: 1, wettedPerimeter: 4, hydraulicRadius: 0.25, topWidth: 1 };
    const smooth = manningVelocity(section, findMaterial('pvc')!.n, 5);
    const rough = manningVelocity(section, findMaterial('rock-cut')!.n, 5);
    expect(smooth.ok && rough.ok).toBe(true);
    if (!smooth.ok || !rough.ok) return;
    // A rougher bed can only ever be slower at the same section and gradient.
    expect(rough.value.velocity).toBeLessThan(smooth.value.velocity);
  });
});

describe('slope units', () => {
  it('treats the gradient as the tangent of the bed angle', () => {
    // 45° is a 1:1 fall, which is 1000‰ exactly.
    expect(degreesToPermille(45)).toBeCloseTo(1000, 6);
    expect(degreesToPermille(0)).toBeCloseTo(0, 12);
    // A 1‰ gradient is a shallow angle, and S is the dimensionless 0.001.
    expect(permilleToDegrees(1)).toBeCloseTo(0.0573, 4);
    expect(permilleToSlope(degreesToPermille(1))).toBeCloseTo(Math.tan(Math.PI / 180), 9);
  });

  it('round-trips a value through both units without drift', () => {
    for (const degrees of [0.1, 0.5, 1, 2.5, 10, 30]) {
      expect(permilleToDegrees(degreesToPermille(degrees))).toBeCloseTo(degrees, 9);
    }
    for (const permille of [0.5, 1, 5, 25, 120]) {
      expect(degreesToPermille(permilleToDegrees(permille))).toBeCloseTo(permille, 9);
    }
  });

  it('gives Manning the same answer whichever unit was typed', () => {
    const section = { area: 2, wettedPerimeter: 5, hydraulicRadius: 0.4, topWidth: 2 };
    const typedInPermille = manningVelocity(section, 0.013, 5);
    const typedInDegrees = manningVelocity(section, 0.013, degreesToPermille(permilleToDegrees(5)));
    expect(typedInPermille.ok && typedInDegrees.ok).toBe(true);
    if (!typedInPermille.ok || !typedInDegrees.ok) return;
    expect(typedInDegrees.value.flow).toBeCloseTo(typedInPermille.value.flow, 9);
  });

  it('accepts only the two supported units', () => {
    expect(isSlopeUnit('permille')).toBe(true);
    expect(isSlopeUnit('degrees')).toBe(true);
    expect(isSlopeUnit('radians')).toBe(false);
    expect(isSlopeUnit(undefined)).toBe(false);
  });
});
