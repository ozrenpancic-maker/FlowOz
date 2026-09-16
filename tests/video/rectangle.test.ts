import type { WaterRoi } from '../../domain/types';
import { rectifyRoi } from '../../video/rectangle';

const FRAME_WIDTH = 1920;
const FRAME_HEIGHT = 1080;

/**
 * A pinhole camera looking down at the water plane, used to photograph a
 * rectangle whose real proportions are known — so the rectification can be
 * checked against the truth rather than against itself.
 *
 * World: the water is the plane z = 0, the flow runs along +y, the camera
 * sits at height h looking along +y and tilted `pitchDeg` below horizontal.
 */
function photograph(options: {
  widthM: number;
  lengthM: number;
  pitchDeg: number;
  heightM: number;
  nearM: number;
  focalPx: number;
  /** Turning the camera off the channel axis, which is what breaks the
   * symmetric trapezoid and lets the shape give up its own focal length. */
  yawDeg?: number;
}): WaterRoi {
  const pitch = (options.pitchDeg * Math.PI) / 180;
  const yaw = ((options.yawDeg ?? 0) * Math.PI) / 180;
  const cameraY = 0;
  const cameraZ = options.heightM;
  // Camera axes as rows: right, down, forward.
  const right: [number, number, number] = [Math.cos(yaw), -Math.sin(yaw), 0];
  const forward: [number, number, number] = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.cos(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
  ];
  const down: [number, number, number] = [
    -Math.sin(pitch) * Math.sin(yaw),
    -Math.sin(pitch) * Math.cos(yaw),
    -Math.cos(pitch),
  ];

  const project = (x: number, y: number) => {
    const d: [number, number, number] = [x - 0, y - cameraY, 0 - cameraZ];
    const vx = right[0] * d[0] + right[1] * d[1] + right[2] * d[2];
    const vy = down[0] * d[0] + down[1] * d[1] + down[2] * d[2];
    const vz = forward[0] * d[0] + forward[1] * d[1] + forward[2] * d[2];
    return {
      x: (FRAME_WIDTH / 2 + (options.focalPx * vx) / vz) / FRAME_WIDTH,
      y: (FRAME_HEIGHT / 2 + (options.focalPx * vy) / vz) / FRAME_HEIGHT,
    };
  };

  const halfWidth = options.widthM / 2;
  const near = options.nearM;
  const far = options.nearM + options.lengthM;
  return {
    topLeft: project(-halfWidth, far),
    topRight: project(halfWidth, far),
    bottomRight: project(halfWidth, near),
    bottomLeft: project(-halfWidth, near),
  };
}

describe('reading a rectangle back out of its perspective', () => {
  it('recovers the focal length and the proportions the camera actually saw', () => {
    const roi = photograph({
      widthM: 1,
      lengthM: 2,
      pitchDeg: 50,
      heightM: 1.5,
      nearM: 1.2,
      focalPx: 1400,
    });
    // Pointed straight down the channel with no roll, so the cross-stream
    // edges stay parallel: the shape alone cannot give up the focal length.
    const fromShape = rectifyRoi(roi, FRAME_WIDTH, FRAME_HEIGHT);
    expect(fromShape.ok).toBe(false);
    if (!fromShape.ok) expect(fromShape.error.code).toBe('EDGES_TOO_PARALLEL');

    // Handed the focal length the camera actually used, it resolves exactly.
    const result = rectifyRoi(roi, FRAME_WIDTH, FRAME_HEIGHT, 1400);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.focalLengthSource).toBe('known');
    expect(result.value.aspectRatio).toBeCloseTo(2, 3);
    expect(result.value.edgeDisagreement).toBeLessThan(1e-6);
  });

  it('holds across the shapes, tilts and lenses a phone actually produces', () => {
    const cases = [
      { widthM: 0.6, lengthM: 0.6, pitchDeg: 35, heightM: 1.2, nearM: 1.5, focalPx: 1200 },
      { widthM: 1.2, lengthM: 4, pitchDeg: 65, heightM: 2, nearM: 0.8, focalPx: 1700 },
      { widthM: 2, lengthM: 1, pitchDeg: 45, heightM: 1.6, nearM: 2, focalPx: 900 },
      { widthM: 0.8, lengthM: 3, pitchDeg: 25, heightM: 3, nearM: 4, focalPx: 1500 },
    ];
    for (const options of cases) {
      const result = rectifyRoi(photograph(options), FRAME_WIDTH, FRAME_HEIGHT, options.focalPx);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const expected = options.lengthM / options.widthM;
      expect(result.value.aspectRatio / expected).toBeCloseTo(1, 2);
    }
  });

  it('reads the focal length out of the shape once the shot is off the channel axis', () => {
    // Turned twelve degrees away from straight-down-the-channel: the
    // cross-stream edges now converge too, so both unknowns are pinned and
    // nothing has to be handed in.
    const roi = photograph({
      widthM: 1,
      lengthM: 2,
      pitchDeg: 50,
      heightM: 1.5,
      nearM: 1.2,
      focalPx: 1400,
      yawDeg: 12,
    });
    const result = rectifyRoi(roi, FRAME_WIDTH, FRAME_HEIGHT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.focalLengthSource).toBe('recovered');
    expect(result.value.focalLengthPx).toBeCloseTo(1400, -2);
    expect(result.value.aspectRatio).toBeCloseTo(2, 2);
  });

  it('recovers the shape across several off-axis turns', () => {
    for (const yawDeg of [8, 15, 25, -18]) {
      const result = rectifyRoi(
        photograph({
          widthM: 1.2,
          lengthM: 3,
          pitchDeg: 45,
          heightM: 1.8,
          nearM: 1.5,
          focalPx: 1300,
          yawDeg,
        }),
        FRAME_WIDTH,
        FRAME_HEIGHT
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.focalLengthPx / 1300).toBeCloseTo(1, 1);
      expect(result.value.aspectRatio / 2.5).toBeCloseTo(1, 1);
    }
  });

  it('refuses a shot taken square-on, where there is no perspective to read', () => {
    // Straight down at the water: the edges stay parallel, both vanishing
    // points are at infinity, and nothing about the focal length follows.
    const roi: WaterRoi = {
      topLeft: { x: 0.3, y: 0.2 },
      topRight: { x: 0.7, y: 0.2 },
      bottomRight: { x: 0.7, y: 0.8 },
      bottomLeft: { x: 0.3, y: 0.8 },
    };
    const result = rectifyRoi(roi, FRAME_WIDTH, FRAME_HEIGHT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('EDGES_TOO_PARALLEL');
  });

  it('refuses a quadrilateral that is not the image of a rectangle', () => {
    // Both edge pairs converge the same way — a trapezoid leaning off to one
    // side, which no rectangle on a plane can project to.
    const roi: WaterRoi = {
      topLeft: { x: 0.35, y: 0.25 },
      topRight: { x: 0.62, y: 0.2 },
      bottomRight: { x: 0.9, y: 0.75 },
      bottomLeft: { x: 0.12, y: 0.62 },
    };
    const result = rectifyRoi(roi, FRAME_WIDTH, FRAME_HEIGHT);
    if (result.ok) {
      // If it does resolve, the focal length it implies must at least be one a
      // phone could have — that is the whole point of the plausibility band.
      expect(result.value.focalLengthPx).toBeGreaterThan(0.2 * FRAME_WIDTH);
    } else {
      expect(['IMPLAUSIBLE_FOCAL_LENGTH', 'EDGES_TOO_PARALLEL']).toContain(result.error.code);
    }
  });

  it('notices when the corners were not placed on a rectangle', () => {
    const honest = photograph({
      widthM: 1,
      lengthM: 2,
      pitchDeg: 50,
      heightM: 1.5,
      nearM: 1.2,
      focalPx: 1400,
    });
    const slipped: WaterRoi = {
      ...honest,
      bottomRight: { x: honest.bottomRight.x + 0.06, y: honest.bottomRight.y + 0.04 },
    };
    const result = rectifyRoi(slipped, FRAME_WIDTH, FRAME_HEIGHT);
    if (!result.ok) return;
    expect(result.value.edgeDisagreement).toBeGreaterThan(0.01);
  });
});
