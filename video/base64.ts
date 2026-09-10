/**
 * Minimal base64 → bytes decoder. The WebView frame extractor sends luminance
 * planes as base64; Hermes has no `atob`, so the conversion lives here where it
 * can be tested directly.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i += 1) {
    table[ALPHABET.charCodeAt(i)] = i;
  }
  table['='.charCodeAt(0)] = -2;
  return table;
})();

export function decodeBase64(input: string): Uint8Array | null {
  const clean = input.replace(/\s+/g, '');
  if (clean.length % 4 !== 0) return null;

  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((clean.length / 4) * 3 - padding);

  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j += 1) {
      const symbol = LOOKUP[clean.charCodeAt(i + j)] as number;
      if (symbol === -1) return null; // character outside the alphabet
      word = (word << 6) | (symbol === -2 ? 0 : symbol);
    }
    if (byteIndex < bytes.length) bytes[byteIndex++] = (word >> 16) & 0xff;
    if (byteIndex < bytes.length) bytes[byteIndex++] = (word >> 8) & 0xff;
    if (byteIndex < bytes.length) bytes[byteIndex++] = word & 0xff;
  }

  return bytes;
}

/** Bytes → the Float32 luminance plane the SSIV core consumes. */
export function bytesToLuminance(bytes: Uint8Array): Float32Array {
  const plane = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    plane[i] = bytes[i] as number;
  }
  return plane;
}
