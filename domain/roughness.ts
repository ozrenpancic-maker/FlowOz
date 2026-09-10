/**
 * Manning roughness catalogue.
 *
 * Published n values for the surfaces a field operator actually meets, so the
 * coefficient is picked from a named material instead of typed from memory.
 * The band is carried alongside the working value: n is a judgement about a
 * surface, not a measurement of it, and a reader of the report is entitled to
 * see how wide that judgement is.
 *
 * Values follow the conventional open-channel tables (Chow, *Open-Channel
 * Hydraulics*, and the standard pipe-material tables that derive from them).
 */

export type RoughnessGroup = 'pipe' | 'channel';

export interface RoughnessMaterial {
  /** Stable id — this is what a saved measurement records. */
  id: string;
  group: RoughnessGroup;
  /** Working Manning n [-]. */
  n: number;
  /** Published band for the same surface [-]. */
  minN: number;
  maxN: number;
}

export const ROUGHNESS_MATERIALS: readonly RoughnessMaterial[] = Object.freeze([
  { id: 'pvc', group: 'pipe', n: 0.01, minN: 0.009, maxN: 0.011 },
  { id: 'steel-welded', group: 'pipe', n: 0.012, minN: 0.01, maxN: 0.014 },
  { id: 'concrete-smooth', group: 'pipe', n: 0.012, minN: 0.011, maxN: 0.013 },
  { id: 'clay-vitrified', group: 'pipe', n: 0.013, minN: 0.011, maxN: 0.015 },
  { id: 'cast-iron', group: 'pipe', n: 0.013, minN: 0.011, maxN: 0.015 },
  { id: 'brick', group: 'pipe', n: 0.015, minN: 0.012, maxN: 0.017 },
  { id: 'concrete-rough', group: 'pipe', n: 0.017, minN: 0.014, maxN: 0.02 },
  { id: 'corrugated-metal', group: 'pipe', n: 0.024, minN: 0.022, maxN: 0.027 },
  { id: 'earth-clean', group: 'channel', n: 0.022, minN: 0.018, maxN: 0.025 },
  { id: 'earth-gravelly', group: 'channel', n: 0.025, minN: 0.022, maxN: 0.03 },
  { id: 'earth-weedy', group: 'channel', n: 0.03, minN: 0.025, maxN: 0.035 },
  { id: 'gravel-bed', group: 'channel', n: 0.03, minN: 0.028, maxN: 0.035 },
  { id: 'stream-clean', group: 'channel', n: 0.035, minN: 0.03, maxN: 0.04 },
  { id: 'rock-cut', group: 'channel', n: 0.04, minN: 0.035, maxN: 0.045 },
  { id: 'stream-stony-weedy', group: 'channel', n: 0.045, minN: 0.035, maxN: 0.05 },
]);

/** The id used when the operator types an n by hand instead of picking one. */
export const CUSTOM_ROUGHNESS_ID = 'custom';

export function findMaterial(id: string | undefined | null): RoughnessMaterial | null {
  if (!id) return null;
  return ROUGHNESS_MATERIALS.find((material) => material.id === id) ?? null;
}

/** i18n key for a material name. */
export function materialLabelKey(id: string): string {
  return id === CUSTOM_ROUGHNESS_ID ? 'material.custom' : `material.${id}`;
}

/**
 * Which catalogue entry an n belongs to, used when reopening a draft that
 * stored only the number. An n that sits in no published band is custom.
 */
export function materialForRoughness(n: number | null | undefined): RoughnessMaterial | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return ROUGHNESS_MATERIALS.find((material) => material.n === n) ?? null;
}

/** True when n falls outside the published band for the chosen material. */
export function isOutsideBand(material: RoughnessMaterial, n: number): boolean {
  return n < material.minN || n > material.maxN;
}
