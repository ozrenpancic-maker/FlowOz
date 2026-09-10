import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import type { KnownRoiDimensions, WaterRoi } from '../domain/types';
import {
  buildClip,
  collect,
  createCollector,
  decodeRequest,
  parseDecoderMessage,
  type DecoderCollectorState,
} from '../video/decoder-adapter';
import { buildDecoderHtml } from '../video/decoder-html';
import { ssivFailure, type SsivFailure } from '../video/failure-taxonomy';
import { planFramePairs } from '../video/frame-plan';
import { analyse } from '../video/ssiv-core';
import type { SsivAnalysis } from '../video/types';

/**
 * Runs the local video → SSIV pipeline.
 *
 * Frames are decoded in an off-screen WebView canvas (no network, no upload),
 * handed to the pure SSIV core, and the result — success or a typed failure —
 * is always reported. The watchdog exists so that a WebView that never answers
 * still ends in VIDEO DECODE FAILURE instead of a spinner that runs forever.
 */

export interface SsivRequest {
  /** Changing this id restarts the analysis; it also de-duplicates callbacks. */
  id: string;
  videoUri: string;
  durationS: number;
  roi: WaterRoi;
  knownDimensions: KnownRoiDimensions;
}

export type SsivProgress = 'idle' | 'decoding' | 'analysing';

const WATCHDOG_MS = 90_000;

/**
 * The decoder page must itself be served from a file:// origin. Loaded without
 * a base URL the document gets an opaque origin, and Android's
 * allowFileAccessFromFileURLs — which only ever applies to file-scheme
 * documents — then does nothing, so drawing the persisted file:// clip taints
 * the canvas and getImageData is refused.
 */
const DECODER_BASE_URL = 'file:///android_asset/';

export function SsivProcessor({
  request,
  onResult,
  onProgress,
}: {
  request: SsivRequest | null;
  onResult: (result: { ok: true; analysis: SsivAnalysis } | { ok: false; failure: SsivFailure }) => void;
  onProgress?: (progress: SsivProgress) => void;
}) {
  const webViewRef = useRef<WebView>(null);
  const collectorRef = useRef<DecoderCollectorState>(createCollector());
  const settledRef = useRef(false);
  const [html] = useState(() => buildDecoderHtml());

  useEffect(() => {
    if (!request) return;

    collectorRef.current = createCollector();
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
    onResult(result);
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

    if (message.type === 'ready') {
      const plan = planFramePairs(request.durationS);
      if (!plan.ok) {
        settle({
          ok: false,
          failure: ssivFailure('VIDEO_DECODE_FAILURE', `${plan.error.code}: ${plan.error.detail}`),
        });
        return;
      }
      const payload = decodeRequest(request.videoUri, plan.pairs);
      webViewRef.current?.injectJavaScript(
        `window.__flowvisionDecode(${JSON.stringify(payload)}); true;`
      );
      return;
    }

    const state = collect(collectorRef.current, message);
    if (!state.finished) return;

    const clip = buildClip(state);
    if (!clip.ok) {
      settle({ ok: false, failure: clip.failure });
      return;
    }

    onProgress?.('analysing');
    const analysis = analyse({
      clip: clip.clip,
      roi: request.roi,
      knownDimensions: request.knownDimensions,
    });

    settle(analysis.ok ? { ok: true, analysis: analysis.value } : { ok: false, failure: analysis.error });
  };

  if (!request) return null;

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={webViewRef}
        key={request.id}
        source={{ html, baseUrl: DECODER_BASE_URL }}
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
