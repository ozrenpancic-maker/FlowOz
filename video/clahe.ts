/**
 * Contrast-Limited Adaptive Histogram Equalisation (CLAHE) on a single
 * luminance plane.
 *
 * Turbid or low-contrast water can leave the whole interrogation window only
 * a few grey levels wide, which is exactly what the correlation in `ncc.ts`
 * needs to find a peak in: ZNCC already normalises away a window's mean and
 * variance, but it cannot invent detail that was never captured in the first
 * place. CLAHE stretches the *local* contrast before that — same idea as
 * OpenCV's `cv2.createCLAHE`, reimplemented here in plain TypeScript so it
 * runs in the same pure, unit-testable pipeline as the rest of the SSIV core
 * (no native/OpenCV dependency exists in this project).
 *
 * The tile grid and clip factor below are the standard textbook/OpenCV
 * defaults (8×8 tiles, clip ≈3× the tile's average bin height) — not a
 * threshold tuned against this app's own field data the way SSIV_THRESHOLDS
 * is. Treat it the same as any other unvalidated preprocessing step: worth
 * trying, not yet proven better on real footage.
 */

const BINS = 256;
const DEFAULT_TILES = 8;
const DEFAULT_CLIP_FACTOR = 3;

interface TileMapping {
  /** BINS-entry lookup: input grey level → equalised grey level. */
  map: Float32Array;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function buildTileMapping(
  data: Float32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  clipFactor: number
): TileMapping {
  const histogram = new Float64Array(BINS);
  const tileWidth = x1 - x0;
  const tileHeight = y1 - y0;
  const pixelCount = tileWidth * tileHeight;

  for (let y = y0; y < y1; y += 1) {
    const row = y * width;
    for (let x = x0; x < x1; x += 1) {
      const level = Math.round(clamp(data[row + x] as number, 0, 255));
      histogram[level] = (histogram[level] as number) + 1;
    }
  }

  // Clip each bin and redistribute the excess evenly — the standard CLAHE
  // contrast limit, so a tile that is almost all one grey level (a flat sky
  // reflection, say) cannot dominate its own mapping and blow out noise.
  const clipLimit = Math.max(1, (clipFactor * pixelCount) / BINS);
  let excess = 0;
  for (let i = 0; i < BINS; i += 1) {
    const count = histogram[i] as number;
    if (count > clipLimit) {
      excess += count - clipLimit;
      histogram[i] = clipLimit;
    }
  }
  const redistribute = excess / BINS;
  for (let i = 0; i < BINS; i += 1) {
    histogram[i] = (histogram[i] as number) + redistribute;
  }

  const map = new Float32Array(BINS);
  let cumulative = 0;
  const scale = pixelCount > 0 ? 255 / pixelCount : 0;
  for (let i = 0; i < BINS; i += 1) {
    cumulative += histogram[i] as number;
    map[i] = cumulative * scale;
  }
  return { map };
}

/**
 * Apply CLAHE to a luminance plane, returning a new Float32Array of the same
 * size. `tiles` is the number of tiles along each axis; a very small working
 * frame is given fewer tiles so no tile ever shrinks to a handful of pixels.
 */
export function applyClahe(
  data: Float32Array,
  width: number,
  height: number,
  options?: { tiles?: number; clipFactor?: number }
): Float32Array {
  if (width <= 0 || height <= 0 || data.length !== width * height) return data;

  const minTilePx = 8;
  const requestedTiles = options?.tiles ?? DEFAULT_TILES;
  const tilesX = Math.max(1, Math.min(requestedTiles, Math.floor(width / minTilePx)) || 1);
  const tilesY = Math.max(1, Math.min(requestedTiles, Math.floor(height / minTilePx)) || 1);
  const clipFactor = options?.clipFactor ?? DEFAULT_CLIP_FACTOR;

  if (tilesX === 1 && tilesY === 1) {
    const mapping = buildTileMapping(data, width, 0, 0, width, height, clipFactor);
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      out[i] = mapping.map[Math.round(clamp(data[i] as number, 0, 255))] as number;
    }
    return out;
  }

  // Tile boundaries and the pixel coordinate of each tile's centre, used as
  // the control points for the bilinear blend below.
  const boundsX: number[] = [];
  for (let t = 0; t <= tilesX; t += 1) boundsX.push(Math.round((t * width) / tilesX));
  const boundsY: number[] = [];
  for (let t = 0; t <= tilesY; t += 1) boundsY.push(Math.round((t * height) / tilesY));

  const mappings: TileMapping[][] = [];
  const centersX: number[] = [];
  const centersY: number[] = [];
  for (let ty = 0; ty < tilesY; ty += 1) {
    const row: TileMapping[] = [];
    for (let tx = 0; tx < tilesX; tx += 1) {
      const x0 = boundsX[tx] as number;
      const x1 = boundsX[tx + 1] as number;
      const y0 = boundsY[ty] as number;
      const y1 = boundsY[ty + 1] as number;
      row.push(buildTileMapping(data, width, x0, y0, x1, y1, clipFactor));
      if (ty === 0) centersX.push((x0 + x1) / 2);
    }
    mappings.push(row);
    centersY.push((boundsY[ty] as number + (boundsY[ty + 1] as number)) / 2);
  }

  // Find the tile index whose centre is at or before `coord`, clamped so
  // pixels outside the outermost centres extrapolate from the edge tile
  // instead of reading past the array.
  const lowerTileIndex = (coord: number, centers: number[]): number => {
    let index = 0;
    while (index < centers.length - 1 && (centers[index + 1] as number) <= coord) index += 1;
    return index;
  };

  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y += 1) {
    const ty0 = lowerTileIndex(y, centersY);
    const ty1 = Math.min(ty0 + 1, tilesY - 1);
    const cy0 = centersY[ty0] as number;
    const cy1 = centersY[ty1] as number;
    const fy = cy1 > cy0 ? clamp((y - cy0) / (cy1 - cy0), 0, 1) : 0;

    for (let x = 0; x < width; x += 1) {
      const tx0 = lowerTileIndex(x, centersX);
      const tx1 = Math.min(tx0 + 1, tilesX - 1);
      const cx0 = centersX[tx0] as number;
      const cx1 = centersX[tx1] as number;
      const fx = cx1 > cx0 ? clamp((x - cx0) / (cx1 - cx0), 0, 1) : 0;

      const level = Math.round(clamp(data[y * width + x] as number, 0, 255));
      const v00 = (mappings[ty0]?.[tx0] as TileMapping).map[level] as number;
      const v01 = (mappings[ty0]?.[tx1] as TileMapping).map[level] as number;
      const v10 = (mappings[ty1]?.[tx0] as TileMapping).map[level] as number;
      const v11 = (mappings[ty1]?.[tx1] as TileMapping).map[level] as number;
      const top = v00 + (v01 - v00) * fx;
      const bottom = v10 + (v11 - v10) * fx;
      out[y * width + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}
