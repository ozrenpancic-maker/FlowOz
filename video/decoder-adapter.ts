import { bytesToLuminance, decodeBase64 } from './base64';
import { ssivFailure, type SsivFailure } from './failure-taxonomy';
import type { PlannedPair } from './frame-plan';
import type { DecodedClip, FramePair } from './types';

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
      firstS: number;
      secondS: number;
      frameDeltaS: number;
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
      return {
        type: 'pair',
        index: m.index as number,
        firstS: m.firstS as number,
        secondS: m.secondS as number,
        frameDeltaS: m.frameDeltaS as number,
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

/** Turn one `pair` message into a frame pair, or explain why it cannot be. */
export function framePairFromMessage(
  message: Extract<DecoderMessage, { type: 'pair' }>
): { ok: true; pair: FramePair } | { ok: false; failure: SsivFailure } {
  const expected = message.width * message.height;
  const first = decodeBase64(message.first);
  const second = decodeBase64(message.second);

  if (!first || !second) {
    return {
      ok: false,
      failure: ssivFailure('VIDEO_DECODE_FAILURE', `pair ${message.index}: base64 is not decodable`),
    };
  }
  if (first.length !== expected || second.length !== expected) {
    return {
      ok: false,
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
  finished: boolean;
  failure?: SsivFailure;
}

export function createCollector(): DecoderCollectorState {
  return { pairs: [], finished: false };
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
        state.failure = result.failure;
        state.finished = true;
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
    return { ok: false, failure: ssivFailure('VIDEO_DECODE_FAILURE', 'no frame pair was extracted') };
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
