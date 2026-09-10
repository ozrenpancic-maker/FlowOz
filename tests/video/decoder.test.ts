import { bytesToLuminance, decodeBase64 } from '../../video/base64';
import {
  buildClip,
  collect,
  createCollector,
  decodeRequest,
  framePairFromMessage,
  parseDecoderMessage,
} from '../../video/decoder-adapter';
import { buildDecoderHtml } from '../../video/decoder-html';
import { planFramePairs } from '../../video/frame-plan';

/** Reference base64 encoder, so the fixtures are independent of the decoder. */
function encodeBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const word = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out += chars[(word >> 18) & 63]! + chars[(word >> 12) & 63]! + chars[(word >> 6) & 63]! + chars[word & 63]!;
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const w = (bytes[i] as number) << 16;
    out += chars[(w >> 18) & 63]! + chars[(w >> 12) & 63]! + '==';
  } else if (remaining === 2) {
    const w = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += chars[(w >> 18) & 63]! + chars[(w >> 12) & 63]! + chars[(w >> 6) & 63]! + '=';
  }
  return out;
}

describe('base64 decoding', () => {
  it('round-trips arbitrary bytes at every padding length', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 17, 256]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + 11) % 256;
      const decoded = decodeBase64(encodeBase64(bytes));
      expect(decoded).not.toBeNull();
      expect(Array.from(decoded as Uint8Array)).toEqual(Array.from(bytes));
    }
  });

  it('rejects a truncated or illegal payload instead of guessing', () => {
    expect(decodeBase64('AAA')).toBeNull();
    expect(decodeBase64('!!!!')).toBeNull();
  });

  it('converts bytes to a luminance plane of the same length', () => {
    const plane = bytesToLuminance(new Uint8Array([0, 128, 255]));
    expect(Array.from(plane)).toEqual([0, 128, 255]);
  });
});

describe('decoder message protocol', () => {
  it('parses each message kind', () => {
    expect(parseDecoderMessage(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' });
    expect(
      parseDecoderMessage(
        JSON.stringify({
          type: 'meta',
          durationS: 5,
          sourceWidth: 1280,
          sourceHeight: 720,
          width: 240,
          height: 135,
          plannedPairs: 6,
        })
      )
    ).toMatchObject({ type: 'meta', width: 240, height: 135 });
    expect(parseDecoderMessage(JSON.stringify({ type: 'done', pairs: 6 }))).toEqual({
      type: 'done',
      pairs: 6,
    });
    expect(
      parseDecoderMessage(JSON.stringify({ type: 'error', code: 'NO_DURATION', detail: 'NaN' }))
    ).toEqual({ type: 'error', code: 'NO_DURATION', detail: 'NaN' });
  });

  it('rejects malformed JSON and unknown message types', () => {
    expect(parseDecoderMessage('{not json')).toBeNull();
    expect(parseDecoderMessage('null')).toBeNull();
    expect(parseDecoderMessage(JSON.stringify({ type: 'something-else' }))).toBeNull();
    expect(parseDecoderMessage(JSON.stringify({ type: 'meta', durationS: 'five' }))).toBeNull();
    expect(parseDecoderMessage(JSON.stringify({ type: 'pair', index: 0 }))).toBeNull();
  });

  const goodPair = (width = 4, height = 3) => {
    const plane = new Uint8Array(width * height).fill(120);
    return {
      type: 'pair' as const,
      index: 0,
      firstS: 0.25,
      secondS: 0.35,
      frameDeltaS: 0.1,
      width,
      height,
      first: encodeBase64(plane),
      second: encodeBase64(plane),
    };
  };

  it('turns a well-formed pair message into a frame pair', () => {
    const result = framePairFromMessage(goodPair());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pair.width).toBe(4);
    expect(result.pair.first).toHaveLength(12);
    expect(result.pair.frameDeltaS).toBeCloseTo(0.1, 9);
  });

  it('turns a truncated plane into a typed decode failure, not a short frame', () => {
    const message = { ...goodPair(), first: encodeBase64(new Uint8Array(5)) };
    const result = framePairFromMessage(message);
    expect(result.ok).toBe(false);
    if (!result.ok && result.fatal) expect(result.failure.code).toBe('VIDEO_DECODE_FAILURE');
    else throw new Error('a malformed plane must be fatal');
  });

  it('keeps a pair whose measured spacing only drifted by a frame', () => {
    const result = framePairFromMessage({
      ...goodPair(),
      frameDeltaS: 0.117,
      plannedDeltaS: 0.1,
    });
    expect(result.ok).toBe(true);
    // The measured spacing, not the planned one, is what reaches the core.
    if (result.ok) expect(result.pair.frameDeltaS).toBeCloseTo(0.117, 9);
  });

  it('drops a mistimed pair without failing the whole run', () => {
    const result = framePairFromMessage({
      ...goodPair(),
      frameDeltaS: 0.4,
      plannedDeltaS: 0.1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fatal).toBe(false);
    if (!result.fatal) expect(result.detail).toContain('300%');
  });

  it('drops a pair whose two seeks landed on the same frame', () => {
    const result = framePairFromMessage({ ...goodPair(), frameDeltaS: 0, plannedDeltaS: 0.1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fatal).toBe(false);
  });

  it('turns undecodable base64 into a typed decode failure', () => {
    const result = framePairFromMessage({ ...goodPair(), second: '!!!!' });
    expect(result.ok).toBe(false);
    if (!result.ok && result.fatal) expect(result.failure.code).toBe('VIDEO_DECODE_FAILURE');
    else throw new Error('a malformed plane must be fatal');
  });
});

describe('collector', () => {
  const meta = {
    type: 'meta' as const,
    durationS: 5,
    sourceWidth: 1280,
    sourceHeight: 720,
    width: 4,
    height: 3,
    plannedPairs: 2,
  };
  const pair = (index: number) => {
    const plane = new Uint8Array(12).fill(index + 1);
    return {
      type: 'pair' as const,
      index,
      firstS: index * 0.5,
      secondS: index * 0.5 + 0.1,
      frameDeltaS: 0.1,
      width: 4,
      height: 3,
      first: encodeBase64(plane),
      second: encodeBase64(plane),
    };
  };

  it('assembles a clip from an ordinary sequence', () => {
    const state = createCollector();
    collect(state, { type: 'ready' });
    collect(state, meta);
    collect(state, pair(1));
    collect(state, pair(0));
    collect(state, { type: 'done', pairs: 2 });

    const clip = buildClip(state);
    expect(clip.ok).toBe(true);
    if (!clip.ok) return;
    expect(clip.clip.pairs.map((entry) => entry.index)).toEqual([0, 1]); // sorted
    expect(clip.clip.sourceWidth).toBe(1280);
    expect(clip.clip.width).toBe(4);
  });

  it('carries on after a mistimed pair and analyses the rest', () => {
    const state = createCollector();
    collect(state, meta);
    collect(state, { ...pair(0), frameDeltaS: 0.9, plannedDeltaS: 0.1 });
    collect(state, { ...pair(1), plannedDeltaS: 0.1 });
    collect(state, { type: 'done', pairs: 2 });

    expect(state.dropped).toHaveLength(1);
    const clip = buildClip(state);
    expect(clip.ok).toBe(true);
    if (clip.ok) expect(clip.clip.pairs.map((entry) => entry.index)).toEqual([1]);
  });

  it('fails the run when every pair was mistimed', () => {
    const state = createCollector();
    collect(state, meta);
    collect(state, { ...pair(0), frameDeltaS: 0.9, plannedDeltaS: 0.1 });
    collect(state, { ...pair(1), frameDeltaS: 0.9, plannedDeltaS: 0.1 });
    collect(state, { type: 'done', pairs: 2 });

    const clip = buildClip(state);
    expect(clip.ok).toBe(false);
    if (!clip.ok) {
      expect(clip.failure.code).toBe('VIDEO_DECODE_FAILURE');
      expect(clip.failure.detail).toContain('mistimed');
    }
  });

  it('surfaces a decoder error as a typed failure', () => {
    const state = createCollector();
    collect(state, meta);
    collect(state, { type: 'error', code: 'FRAME_SEEK_FAILED', detail: 'seek timeout at 2s' });
    expect(state.finished).toBe(true);

    const clip = buildClip(state);
    expect(clip.ok).toBe(false);
    if (!clip.ok) {
      expect(clip.failure.code).toBe('VIDEO_DECODE_FAILURE');
      expect(clip.failure.detail).toContain('FRAME_SEEK_FAILED');
    }
  });

  it('refuses to build a clip with no metadata or no pairs', () => {
    const noMeta = createCollector();
    collect(noMeta, { type: 'done', pairs: 0 });
    expect(buildClip(noMeta).ok).toBe(false);

    const noPairs = createCollector();
    collect(noPairs, meta);
    collect(noPairs, { type: 'done', pairs: 0 });
    expect(buildClip(noPairs).ok).toBe(false);
  });

  it('stops at the first bad pair rather than analysing a partial clip', () => {
    const state = createCollector();
    collect(state, meta);
    collect(state, { ...pair(0), first: '!!!!' });
    expect(state.finished).toBe(true);
    expect(buildClip(state).ok).toBe(false);
  });
});

describe('decoder bootstrap', () => {
  it('carries the URI and the plan into the WebView payload', () => {
    const plan = planFramePairs(5);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    const payload = JSON.parse(decodeRequest('file:///data/video.mp4', plan.pairs));
    expect(payload.uri).toBe('file:///data/video.mp4');
    expect(payload.plan).toHaveLength(plan.pairs.length);
    expect(payload.plan[0]).toHaveProperty('frameDeltaS');
  });

  it('builds a self-contained local page with no network references', () => {
    const html = buildDecoderHtml();
    expect(html).toContain('__flowvisionDecode');
    expect(html).toContain('ReactNativeWebView');
    // Nothing is fetched from anywhere: the page is entirely local.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('fetch(');
    expect(html).not.toContain('XMLHttpRequest');
    // Every failure path posts a typed error rather than going quiet.
    expect(html).toContain("bail('VIDEO_ELEMENT_ERROR'");
    expect(html).toContain("'FRAME_SEEK_FAILED'");
    expect(html).toContain("bail('NO_DURATION'");
  });

  it('reports a blocked canvas read separately from a failed seek', () => {
    const html = buildDecoderHtml();
    // A tainted canvas throws at getImageData, which is not a seek problem.
    expect(html).toContain("blocked.code = 'FRAME_READ_BLOCKED'");
    expect(html).toContain('(error && error.code) || ');
  });

  it('reports the times the player reached, not the times it was asked for', () => {
    const html = buildDecoderHtml();
    expect(html).toContain('resolve(video.currentTime)');
    expect(html).toContain('secondActualS - firstActualS');
    expect(html).toContain('plannedDeltaS: entry.frameDeltaS');
  });
});
