import { SSIV_THRESHOLDS } from './types';

/**
 * Frame-pair sampling plan.
 *
 * Six pairs are spread across the usable middle of the clip. The spacing inside
 * a pair is bounded (§11.4): too short and the displacement drowns in sub-pixel
 * noise, too long and the correlation window loses the pattern entirely.
 */

export interface PlannedPair {
  index: number;
  /** Timestamps of the two frames [s]. */
  firstS: number;
  secondS: number;
  frameDeltaS: number;
}

export type FramePlanErrorCode = 'CLIP_TOO_SHORT' | 'INVALID_DURATION';

export interface FramePlanError {
  code: FramePlanErrorCode;
  detail: string;
}

export function planFramePairs(
  durationS: number,
  options?: { pairCount?: number; minDeltaS?: number; maxDeltaS?: number }
): { ok: true; pairs: PlannedPair[] } | { ok: false; error: FramePlanError } {
  const pairCount = options?.pairCount ?? SSIV_THRESHOLDS.framePairs;
  const minDelta = options?.minDeltaS ?? SSIV_THRESHOLDS.minFrameDeltaS;
  const maxDelta = options?.maxDeltaS ?? SSIV_THRESHOLDS.maxFrameDeltaS;

  if (!Number.isFinite(durationS) || durationS <= 0) {
    return { ok: false, error: { code: 'INVALID_DURATION', detail: `duration=${durationS}` } };
  }

  // Skip the first and last 5% — the operator is usually still settling the
  // phone there.
  const margin = Math.min(0.25, durationS * 0.05);
  const usableStart = margin;
  const usableEnd = durationS - margin;
  const usable = usableEnd - usableStart;

  if (usable <= minDelta) {
    return {
      ok: false,
      error: { code: 'CLIP_TOO_SHORT', detail: `usable ${usable.toFixed(3)} s ≤ ${minDelta} s` },
    };
  }

  // Prefer a spacing that spreads the pairs evenly, clamped into the band.
  const spread = usable / pairCount;
  const frameDeltaS = Math.min(maxDelta, Math.max(minDelta, Math.min(spread, maxDelta)));

  const pairs: PlannedPair[] = [];
  for (let index = 0; index < pairCount; index += 1) {
    const anchor =
      pairCount === 1
        ? usableStart
        : usableStart + ((usable - frameDeltaS) * index) / (pairCount - 1);
    const firstS = anchor;
    const secondS = anchor + frameDeltaS;
    if (secondS > durationS) break;
    pairs.push({ index, firstS, secondS, frameDeltaS });
  }

  if (pairs.length === 0) {
    return {
      ok: false,
      error: { code: 'CLIP_TOO_SHORT', detail: `no pair fits in ${durationS.toFixed(3)} s` },
    };
  }

  return { ok: true, pairs };
}

/** Working frame size for a given source size, preserving the aspect ratio. */
export function processingSize(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth = SSIV_THRESHOLDS.processingWidthPx
): { width: number; height: number } | null {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return null;
  }
  // Never upscale: a smaller source is analysed at its own resolution.
  const width = Math.min(targetWidth, Math.round(sourceWidth));
  const height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
  return { width, height };
}
