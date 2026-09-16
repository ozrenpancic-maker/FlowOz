import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { FlowDirection, KnownRoiDimensions, WaterRoi } from '../domain/types';
import {
  buildClip,
  collect,
  createCollector,
  decodeRequest,
  decoderBaseUrl,
  parseDecoderMessage,
  type DecoderCollectorState,
} from '../video/decoder-adapter';
import { buildDecoderHtml } from '../video/decoder-html';
import { ssivFailure, type SsivFailure } from '../video/failure-taxonomy';
import { planFramePairs, planPilotPairs } from '../video/frame-plan';
import { chooseSpacing, describeSpacingProbes, probeLadder } from '../video/pilot';
import { analyse } from '../video/ssiv-core';
import type { SsivAnalysis } from '../video/types';

/**
 * Runs the local video → SSIV pipeline.
 *
 * Frames are decoded in an off-screen WebView canvas (no network, no upload),
 * handed to the pure SSIV core, and the result — success or a typed failure —
 * is always reported. The watchdog exists so that a WebView that never answers
 * still ends in VIDEO DECODE FAILURE instead of a spinner that runs forever.
 *
 * The decode runs in two passes. The first is a short pilot across a ladder of
 * frame spacings, which measures how far this particular water actually
 * travels between two frames; the second decodes the real pairs at whichever
 * spacing put that displacement where correlation can locate it. Fixing the
 * spacing up front instead left the displacement to chance, and on a real
 * channel it came out at about one pixel — too little to measure, and
 * reported as a velocity two hundred times under the truth rather than as a
 * setup that could not answer the question.
 */

export interface SsivRequest {
  /** Changing this id restarts the analysis; it also de-duplicates callbacks. */
  id: string;
  videoUri: string;
  durationS: number;
  roi: WaterRoi;
  knownDimensions: KnownRoiDimensions;
  /** Defaults to FORWARD when omitted. */
  flowDirection?: FlowDirection;
}

export type SsivProgress = 'idle' | 'decoding' | 'analysing';

// Two decode passes, so the budget covers both. A large imported clip spends
// most of it seeking, not correlating.
const WATCHDOG_MS = 180_000;

export function SsivProcessor({
  request,
  onResult,
  onProgress,
}: {
  request: SsivRequest | null;
  onResult: (
    result:
      | { ok: true; analysis: SsivAnalysis; pilotLog?: string }
      | { ok: false; failure: SsivFailure; pilotLog?: string }
  ) => void;
  onProgress?: (progress: SsivProgress) => void;
}) {
  const webViewRef = useRef<WebView>(null);
  const collectorRef = useRef<DecoderCollectorState>(createCollector());
  const stageRef = useRef<'pilot' | 'final'>('pilot');
  const pilotLogRef = useRef<string | undefined>(undefined);
  const settledRef = useRef(false);
  const [html] = useState(() => buildDecoderHtml());

  useEffect(() => {
    if (!request) return;

    collectorRef.current = createCollector();
    stageRef.current = 'pilot';
    settledRef.current = false;
    onProgress?.('decoding');

    const watchdog = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      onResult({
        ok: false,
        failure: ssivFailure(
          'VIDEO_DECODE_FAILURE',
          `the local decoder did not answer within ${WATCHDOG_MS / 1000} s`
        ),
      });
    }, WATCHDOG_MS);

    return () => clearTimeout(watchdog);
    // onResult/onProgress are stable callbacks from the screen; the request id
    // is what actually starts a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  const settle = (result: Parameters<typeof onResult>[0]) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onResult(pilotLogRef.current ? { ...result, pilotLog: pilotLogRef.current } : result);
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    if (!request || settledRef.current) return;

    const message = parseDecoderMessage(event.nativeEvent.data);
    if (!message) {
      settle({
        ok: false,
        failure: ssivFailure('VIDEO_DECODE_FAILURE', 'the decoder sent an unreadable message'),
      });
      return;
    }

    const decode = (pairs: Parameters<typeof decodeRequest>[1]) => {
      const payload = decodeRequest(request.videoUri, pairs);
      webViewRef.current?.injectJavaScript(
        `window.__flowvisionDecode(${JSON.stringify(payload)}); true;`
      );
    };

    if (message.type === 'ready') {
      const plan = planPilotPairs(request.durationS);
      if (!plan.ok) {
        settle({
          ok: false,
          failure: ssivFailure('VIDEO_DECODE_FAILURE', `${plan.error.code}: ${plan.error.detail}`),
        });
        return;
      }
      decode(plan.pairs);
      return;
    }

    const state = collect(collectorRef.current, message);
    if (!state.finished) return;

    const clip = buildClip(state);

    if (stageRef.current === 'pilot') {
      // Read the displacement each rung of the ladder produced and keep the
      // spacing that put it where a correlation peak can be located. The pilot
      // only ever narrows the choice, so a pilot that decoded nothing, or
      // found nothing to go on, leaves the fixed band in charge rather than
      // failing the run — that is exactly where the run would have started
      // before the ladder existed.
      const probes = clip.ok ? probeLadder(clip.clip.pairs, request.roi) : [];
      const chosen = clip.ok ? chooseSpacing(probes) : null;
      pilotLogRef.current = clip.ok ? describeSpacingProbes(probes, chosen) : undefined;
      const plan = chosen
        ? planFramePairs(request.durationS, {
            minDeltaS: chosen.frameDeltaS,
            maxDeltaS: chosen.frameDeltaS,
          })
        : planFramePairs(request.durationS);
      if (!plan.ok) {
        settle({
          ok: false,
          failure: ssivFailure('VIDEO_DECODE_FAILURE', `${plan.error.code}: ${plan.error.detail}`),
        });
        return;
      }
      stageRef.current = 'final';
      collectorRef.current = createCollector();
      decode(plan.pairs);
      return;
    }

    if (!clip.ok) {
      settle({ ok: false, failure: clip.failure });
      return;
    }

    onProgress?.('analysing');
    const analysis = analyse({
      clip: clip.clip,
      roi: request.roi,
      knownDimensions: request.knownDimensions,
      flowDirection: request.flowDirection,
    });

    settle(analysis.ok ? { ok: true, analysis: analysis.value } : { ok: false, failure: analysis.error });
  };

  if (!request) return null;

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={webViewRef}
        key={request.id}
        source={{ html, baseUrl: decoderBaseUrl(request.videoUri) }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={handleMessage}
        onError={(event) =>
          settle({
            ok: false,
            failure: ssivFailure(
              'VIDEO_DECODE_FAILURE',
              `WebView error: ${event.nativeEvent.description}`
            ),
          })
        }
        onRenderProcessGone={() =>
          settle({
            ok: false,
            failure: ssivFailure('VIDEO_DECODE_FAILURE', 'the decoder process was terminated'),
          })
        }
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Off-screen but mounted: an unmounted WebView cannot decode.
  host: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
  webview: { width: 1, height: 1, backgroundColor: 'transparent' },
});
