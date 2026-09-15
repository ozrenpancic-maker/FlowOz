import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { decodeRequest, decoderBaseUrl, parseDecoderMessage } from '../video/decoder-adapter';
import { buildDecoderHtml } from '../video/decoder-html';

/**
 * The real frame size of a video, read from the decoder that will analyse it.
 *
 * `videoTrack.size` reports the frame as it is stored, not as it is shown. A
 * phone records a portrait clip as a landscape frame plus a rotation flag, so
 * for every portrait video that size is the wrong way round — and the ROI
 * editor, which sizes its preview box and converts taps through exactly that
 * size, then works in a frame that does not exist. The video is letterboxed
 * into a 16:9 box as a narrow strip, and a tap's horizontal position is
 * recorded against the box rather than the strip inside it.
 *
 * The decoder in the WebView has no such problem: a video element applies the
 * rotation, so `videoWidth`/`videoHeight` are the frame as drawn, which is
 * also the frame the SSIV pipeline goes on to interrogate. Asking it for a
 * plan of no pairs gets that answer at the cost of loading metadata alone,
 * and means the editor and the analysis agree on the shape of the frame by
 * construction rather than by assumption.
 */

export interface VideoFrameSize {
  width: number;
  height: number;
}

export function VideoMetadataProbe({
  uri,
  onResolved,
}: {
  uri: string;
  onResolved: (size: VideoFrameSize | null) => void;
}) {
  const webViewRef = useRef<WebView>(null);
  const settledRef = useRef(false);
  const [html] = useState(() => buildDecoderHtml());

  const settle = (size: VideoFrameSize | null) => {
    if (settledRef.current) return;
    settledRef.current = true;
    onResolved(size);
  };

  const handleMessage = (event: WebViewMessageEvent) => {
    const message = parseDecoderMessage(event.nativeEvent.data);
    if (!message) return;
    if (message.type === 'ready') {
      webViewRef.current?.injectJavaScript(
        `window.__flowvisionDecode(${JSON.stringify(decodeRequest(uri, []))}); true;`
      );
      return;
    }
    if (message.type === 'meta') {
      settle({ width: message.sourceWidth, height: message.sourceHeight });
      return;
    }
    // A clip whose metadata will not load is not something the ROI editor can
    // paper over, so the caller is told so rather than left waiting.
    if (message.type === 'error') settle(null);
  };

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={webViewRef}
        key={uri}
        source={{ html, baseUrl: decoderBaseUrl(uri) }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        javaScriptEnabled
        domStorageEnabled={false}
        onMessage={handleMessage}
        onError={() => settle(null)}
        onRenderProcessGone={() => settle(null)}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Off-screen but mounted: an unmounted WebView cannot load anything.
  host: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
  webview: { width: 1, height: 1, backgroundColor: 'transparent' },
});
