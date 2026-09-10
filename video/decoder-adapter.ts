import { bytesToLuminance, decodeBase64 } from './base64';
import { ssivFailure, type SsivFailure } from './failure-taxonomy';
import type { PlannedPair } from './frame-plan';
import { SSIV_THRESHOLDS, type DecodedClip, type FramePair } from './types';

/**
 * Contract between the WebView frame extractor and the React Native side.
 *
 * The parsing is pure so the message protocol can be tested without a device:
 * a malformed or truncated message becomes a typed VIDEO DECODE FAILURE, never
 * a half-built clip that the SSIV core would then analyse as if it were real.
 */

export type DecoderMessage =
  | { type: 'ready' }
  | {
      type: 'meta';
      durationS: number;
      sourceWidth: number;
      sourceHeight: number;
      width: number;
      height: number;
      plannedPairs: number;
    }
  | {
      type: 'pair';
      index: number;
      /** Times the player actually landed on [s]. */
      firstS: number;
      secondS: number;
      /** Measured spacing, `secondS - firstS` [s]. */
      frameDeltaS: number;
      /** Spacing the plan asked for, for comparison [s]. */
      plannedDeltaS?: number;
      width: number;
      height: number;
      first: string;
      second: string;
    }
  | { type: 'done'; pairs: number }
  | { type: 'error'; code: string; detail: string };

export function parseDecoderMessage(raw: string): DecoderMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const message = parsed as { type?: unknown };
  if (typeof message.type !== 'string') return null;

  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'meta': {
      const m = parsed as Record<string, unknown>;
      const numbers = ['durationS', 'sourceWidth', 'sourceHeight', 'width', 'height'] as const;
      if (!numbers.every((key) => typeof m[key] === 'number' && Number.isFinite(m[key] as number))) {
        return null;
      }
      return {
        type: 'meta',
        durationS: m.durationS as number,
        sourceWidth: m.sourceWidth as number,
        sourceHeight: m.sourceHeight as number,
        width: m.width as number,
        height: m.height as number,
        plannedPairs: typeof m.plannedPairs === 'number' ? m.plannedPairs : 0,
      };
    }
    case 'pair': {
      const m = parsed as Record<string, unknown>;
      const numbers = ['index', 'firstS', 'secondS', 'frameDeltaS', 'width', 'height'] as const;
      if (!numbers.every((key) => typeof m[key] === 'number' && Number.isFinite(m[key] as number))) {
        return null;
      }
      if (typeof m.first !== 'string' || typeof m.second !== 'string') return null;
      const planned = m.plannedDeltaS;
      return {
        type: 'pair',
        index: m.index as number,
        firstS: m.firstS as number,
        secondS: m.secondS as number,
        frameDeltaS: m.frameDeltaS as number,
        ...(typeof planned === 'number' && Number.isFinite(planned)
          ? { plannedDeltaS: planned }
          : {}),
        width: m.width as number,
        height: m.height as number,
        first: m.first,
        second: m.second,
      };
    }
    case 'done': {
      const m = parsed as Record<string, unknown>;
      return { type: 'done', pairs: typeof m.pairs === 'number' ? m.pairs : 0 };
    }
    case 'error': {
      const m = parsed as Record<string, unknown>;
      return {
        type: 'error',
        code: typeof m.code === 'string' ? m.code : 'UNKNOWN',
        detail: typeof m.detail === 'string' ? m.detail : '',
      };
    }
    default:
      return null;
  }
}

/**
 * The outcome of turning one `pair` message into a frame pair.
 *
 * A malformed payload is fatal — the decoder is not doing what it claims. A
 * pair whose two frames did not end up spaced the way the plan asked is only
 * unusable: the seek landed on a neighbouring frame, which says nothing about
 * the other pairs, so it is dropped and the run continues on the rest.
 */
export type FramePairOutcome =
  | { ok: true; pair: FramePair }
  | { ok: false; fatal: true; failure: SsivFailure }
  | { ok: false; fatal: false; detail: string };

/** Turn one `pair` message into a frame pair, or explain why it cannot be. */
export function framePairFromMessage(
  message: Extract<DecoderMessage, { type: 'pair' }>
): FramePairOutcome {
  const expected = message.width * message.height;

  if (!Number.isFinite(message.frameDeltaS) || message.frameDeltaS <= 0) {
    return {
      ok: false,
      fatal: false,
      detail: `pair ${message.index}: both seeks landed on the same frame (Δt=${message.frameDeltaS}s)`,
    };
  }

  const reference = message.plannedDeltaS;
  if (reference !== undefined && reference > 0) {
    const deviation = Math.abs(message.frameDeltaS - reference) / reference;
    if (deviation > SSIV_THRESHOLDS.maxFrameDeltaDeviationFraction) {
      return {
        ok: false,
        fatal: false,
        detail:
          `pair ${message.index}: Δt=${message.frameDeltaS.toFixed(4)}s against a planned ` +
          `${reference.toFixed(4)}s (${(deviation * 100).toFixed(0)}% off)`,
      };
    }
  } else if (
    message.frameDeltaS < SSIV_THRESHOLDS.minFrameDeltaS / 2 ||
    message.frameDeltaS > SSIV_THRESHOLDS.maxFrameDeltaS * 2
  ) {
    return {
      ok: false,
      fatal: false,
      detail: `pair ${message.index}: Δt=${message.frameDeltaS.toFixed(4)}s is outside the usable band`,
    };
  }

  const first = decodeBase64(message.first);
  const second = decodeBase64(message.second);

  if (!first || !second) {
    return {
      ok: false,
      fatal: true,
      failure: ssivFailure('VIDEO_DECODE_FAILURE', `pair ${message.index}: base64 is not decodable`),
    };
  }
  if (first.length !== expected || second.length !== expected) {
    return {
      ok: false,
      fatal: true,
      failure: ssivFailure(
        'VIDEO_DECODE_FAILURE',
        `pair ${message.index}: got ${first.length}/${second.length} samples, expected ${expected}`
      ),
    };
  }

  return {
    ok: true,
    pair: {
      index: message.index,
      first: bytesToLuminance(first),
      second: bytesToLuminance(second),
      width: message.width,
      height: message.height,
      frameDeltaS: message.frameDeltaS,
    },
  };
}

export interface DecoderCollectorState {
  meta?: Extract<DecoderMessage, { type: 'meta' }>;
  pairs: FramePair[];
  /** Why each unusable pair was dropped, kept for the failure detail. */
  dropped: string[];
  finished: boolean;
  failure?: SsivFailure;
}

export function createCollector(): DecoderCollectorState {
  return { pairs: [], dropped: [], finished: false };
}

/**
 * Fold one message into the collector. Returns the same object so a React ref
 * can hold it across renders without re-allocating.
 */
export function collect(state: DecoderCollectorState, message: DecoderMessage): DecoderCollectorState {
  switch (message.type) {
    case 'ready':
      return state;
    case 'meta':
      state.meta = message;
      return state;
    case 'pair': {
      const result = framePairFromMessage(message);
      if (!result.ok) {
        if (result.fatal) {
          state.failure = result.failure;
          state.finished = true;
        } else {
          state.dropped.push(result.detail);
        }
        return state;
      }
      state.pairs.push(result.pair);
      return state;
    }
    case 'done':
      state.finished = true;
      return state;
    case 'error':
      state.failure = ssivFailure('VIDEO_DECODE_FAILURE', `${message.code}: ${message.detail}`);
      state.finished = true;
      return state;
    default:
      return state;
  }
}

export function buildClip(
  state: DecoderCollectorState
): { ok: true; clip: DecodedClip } | { ok: false; failure: SsivFailure } {
  if (state.failure) return { ok: false, failure: state.failure };
  if (!state.meta) {
    return { ok: false, failure: ssivFailure('VIDEO_DECODE_FAILURE', 'no video metadata received') };
  }
  if (state.pairs.length === 0) {
    return {
      ok: false,
      failure: ssivFailure(
        'VIDEO_DECODE_FAILURE',
        state.dropped.length > 0
          ? `every frame pair was mistimed — ${state.dropped.join('; ')}`
          : 'no frame pair was extracted'
      ),
    };
  }

  return {
    ok: true,
    clip: {
      sourceWidth: state.meta.sourceWidth,
      sourceHeight: state.meta.sourceHeight,
      width: state.meta.width,
      height: state.meta.height,
      durationS: state.meta.durationS,
      pairs: [...state.pairs].sort((a, b) => a.index - b.index),
    },
  };
}

/** The payload injected into the WebView to start a decode. */
export function decodeRequest(uri: string, plan: readonly PlannedPair[]): string {
  return JSON.stringify({ uri, plan });
}

const FALLBACK_BASE_URL = 'file:///android_asset/';

/**
 * Where the decoder page should claim to be loaded from.
 *
 * Loaded without a base URL the document gets an opaque origin, and Android's
 * allowFileAccessFromFileURLs — which only ever applies to file-scheme
 * documents — then does nothing, so drawing the persisted clip taints the
 * canvas and getImageData is refused. Serving the page from the clip's own
 * directory makes the two same-origin outright, rather than leaving the read to
 * depend on a file-to-file access flag that newer WebView builds keep
 * tightening.
 *
 * Anything without a directory to borrow — a content:// pick that was never
 * copied into app storage — falls back, and fails loudly rather than quietly
 * reading nothing.
 */
export function decoderBaseUrl(videoUri: string): string {
  if (!videoUri.startsWith('file://')) return FALLBACK_BASE_URL;
  const cut = videoUri.lastIndexOf('/');
  return cut > 'file://'.length ? videoUri.slice(0, cut + 1) : FALLBACK_BASE_URL;
}
