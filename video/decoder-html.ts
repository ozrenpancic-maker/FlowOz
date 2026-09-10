import { SSIV_THRESHOLDS } from './types';

/**
 * The frame extractor that runs inside the WebView.
 *
 * Everything is local: the page loads the persisted file:// video, seeks to the
 * planned timestamps, draws each frame into a canvas downscaled to the working
 * width and posts the luminance plane back as base64. No network, no upload.
 *
 * Every failure path posts an `error` message with a code — the WebView never
 * just stops and leaves the caller waiting.
 */
export function buildDecoderHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:#000;">
<video id="v" playsinline muted preload="auto" style="width:1px;height:1px;opacity:0"></video>
<canvas id="c" style="display:none"></canvas>
<script>
(function () {
  var video = document.getElementById('v');
  var canvas = document.getElementById('c');
  var context = canvas.getContext('2d', { willReadFrequently: true });
  var settled = false;

  function post(message) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }
  }

  function bail(code, detail) {
    if (settled) return;
    settled = true;
    post({ type: 'error', code: code, detail: String(detail || '') });
  }

  window.onerror = function (message) { bail('SCRIPT_ERROR', message); };

  function toBase64(bytes) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '';
    var i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      var word = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += chars[(word >> 18) & 63] + chars[(word >> 12) & 63] + chars[(word >> 6) & 63] + chars[word & 63];
    }
    var remaining = bytes.length - i;
    if (remaining === 1) {
      var w1 = bytes[i] << 16;
      out += chars[(w1 >> 18) & 63] + chars[(w1 >> 12) & 63] + '==';
    } else if (remaining === 2) {
      var w2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += chars[(w2 >> 18) & 63] + chars[(w2 >> 12) & 63] + chars[(w2 >> 6) & 63] + '=';
    }
    return out;
  }

  function seekTo(time) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        video.removeEventListener('seeked', onSeeked);
        reject(new Error('seek timeout at ' + time + 's'));
      }, 8000);
      function onSeeked() {
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        // One rAF so the decoded frame is actually presented before we draw it.
        requestAnimationFrame(function () { resolve(); });
      }
      video.addEventListener('seeked', onSeeked);
      try {
        video.currentTime = Math.max(0, Math.min(time, (video.duration || 0) - 0.001));
      } catch (error) {
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        reject(error);
      }
    });
  }

  function grabLuminance(width, height) {
    context.drawImage(video, 0, 0, width, height);
    var image = context.getImageData(0, 0, width, height);
    var rgba = image.data;
    var plane = new Uint8Array(width * height);
    for (var i = 0, p = 0; p < plane.length; i += 4, p += 1) {
      // Rec. 601 luma.
      plane[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;
    }
    return plane;
  }

  function run(plan) {
    var sourceWidth = video.videoWidth;
    var sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      bail('NO_VIDEO_DIMENSIONS', sourceWidth + 'x' + sourceHeight);
      return;
    }
    var width = Math.min(${SSIV_THRESHOLDS.processingWidthPx}, sourceWidth);
    var height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
    canvas.width = width;
    canvas.height = height;

    post({
      type: 'meta',
      durationS: video.duration,
      sourceWidth: sourceWidth,
      sourceHeight: sourceHeight,
      width: width,
      height: height,
      plannedPairs: plan.length
    });

    var index = 0;
    function next() {
      if (index >= plan.length) {
        if (!settled) { settled = true; post({ type: 'done', pairs: plan.length }); }
        return;
      }
      var entry = plan[index];
      seekTo(entry.firstS)
        .then(function () {
          var first = grabLuminance(width, height);
          return seekTo(entry.secondS).then(function () {
            var second = grabLuminance(width, height);
            post({
              type: 'pair',
              index: entry.index,
              firstS: entry.firstS,
              secondS: entry.secondS,
              frameDeltaS: entry.frameDeltaS,
              width: width,
              height: height,
              first: toBase64(first),
              second: toBase64(second)
            });
            index += 1;
            next();
          });
        })
        .catch(function (error) { bail('FRAME_SEEK_FAILED', error && error.message ? error.message : error); });
    }
    next();
  }

  window.__flowvisionDecode = function (payload) {
    try {
      var request = typeof payload === 'string' ? JSON.parse(payload) : payload;
      video.onerror = function () {
        var code = video.error ? video.error.code : 'unknown';
        bail('VIDEO_ELEMENT_ERROR', 'media error code ' + code);
      };
      video.onloadedmetadata = function () {
        if (!video.duration || !isFinite(video.duration)) {
          bail('NO_DURATION', String(video.duration));
          return;
        }
        run(request.plan);
      };
      video.src = request.uri;
      video.load();
    } catch (error) {
      bail('BOOTSTRAP_FAILED', error && error.message ? error.message : error);
    }
    return true;
  };

  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
