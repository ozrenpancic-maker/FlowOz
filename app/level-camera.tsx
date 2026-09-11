import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer } from 'expo-sensors';

import { estimateDepthFromRim, fitEllipse, MAX_RIM_POINTS, MIN_RIM_POINTS, type Point2D } from '../domain/ellipse';
import { formatNumber, fromMetres } from '../domain/units';
import { displayToSource, sourceToDisplay, type FrameGeometry } from '../domain/coordinate-transform';
import { summarizeMotion, type SensorSnapshot } from '../domain/sensor-snapshot';
import { ALGORITHM_VERSION, type CameraLevelEvidence } from '../domain/types';
import { suggestInitialWaterLine, toEndpoints, type WaterLine } from '../domain/water-line';
import { captureDeviceInfo } from '../sensors/device-info';
import { persistMedia } from '../storage/media-storage';
import { useMeasurement } from '../state/measurement-context';
import { useSettings } from '../state/settings-context';
import { Badge, Button, Card, ErrorBlock, Muted, Note, Screen, SectionTitle, ValueRow } from '../ui/components';
import { WaterLineEditor } from '../ui/WaterLineEditor';
import { colors, radius, spacing, typography } from '../ui/theme';

/** No digital zoom for a metric measurement — see app/video.tsx's ZOOM. */
const ZOOM = 0;

/**
 * Camera-assisted level for a circular pipe.
 *
 * The operator photographs the pipe face, marks 8–12 rim points and 2 water-line
 * points. The photo, the gravity vector and the marked points are all stored as
 * evidence. The estimate is explicitly indicative: the affine rim model cannot
 * prove perspective accuracy and the screen says so before and after the fit.
 */
type Marking = 'rim' | 'waterline';

export default function LevelCameraScreen() {
  const router = useRouter();
  const { t } = useSettings();
  const { draft, patchDraft } = useMeasurement();

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [permissionProblem, setPermissionProblem] = useState<'denied' | 'blocked' | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(draft.photoUri ?? null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const [mode, setMode] = useState<Marking>('rim');
  const [rimPoints, setRimPoints] = useState<Point2D[]>([]);
  const [waterLine, setWaterLine] = useState<WaterLine | null>(null);
  const [initialWaterLine, setInitialWaterLine] = useState<WaterLine | null>(null);
  const [waterLineHistory, setWaterLineHistory] = useState<WaterLine[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [photoSize, setPhotoSize] = useState<{ width: number; height: number } | null>(null);
  const [gravity, setGravity] = useState<{ x: number; y: number; z: number } | null>(null);

  const diameter = draft.dimensions.kind === 'circular' ? draft.dimensions.diameter : 0;

  // The heavy robust ellipse fit only needs to re-run when the rim points
  // themselves change — never on every frame of a waterline drag.
  const ellipseFit = useMemo(
    () => (rimPoints.length >= MIN_RIM_POINTS ? fitEllipse(rimPoints) : null),
    [rimPoints]
  );

  // The waterline is initialised once, automatically, right after the rim fit
  // first succeeds — gravity only suggests its starting angle; the operator's
  // own drag/rotate always wins from then on (see domain/water-line.ts).
  useEffect(() => {
    if (mode === 'waterline' && ellipseFit?.ok && !waterLine) {
      const initial = suggestInitialWaterLine(ellipseFit.value, gravity ?? undefined);
      setWaterLine(initial);
      setInitialWaterLine(initial);
      setWaterLineHistory([]);
    }
  }, [mode, ellipseFit, waterLine, gravity]);

  // Cheap, closed-form — safe to recompute on every render, including every
  // frame of a drag, so the depth reading is genuinely live.
  const liveEstimate =
    ellipseFit?.ok && waterLine
      ? estimateDepthFromRim(ellipseFit.value, toEndpoints(waterLine), diameter, gravity ?? undefined)
      : null;

  const pushWaterLineUndo = () => {
    if (waterLine) setWaterLineHistory((current) => [...current, waterLine]);
  };
  const undoWaterLine = () => {
    setWaterLineHistory((current) => {
      if (current.length === 0) return current;
      setWaterLine(current[current.length - 1] as WaterLine);
      return current.slice(0, -1);
    });
  };
  const resetWaterLine = () => {
    if (!initialWaterLine) return;
    pushWaterLineUndo();
    setWaterLine(initialWaterLine);
  };

  // The gravity vector fixes which side of the water line is the invert.
  useEffect(() => {
    Accelerometer.setUpdateInterval(400);
    const subscription = Accelerometer.addListener((reading) => setGravity(reading));
    return () => subscription.remove();
  }, []);

  // The frame that rim/waterline taps are read against must show the photo's
  // real aspect ratio — a mismatched frame would let `resizeMode="cover"` crop
  // away part of the rim, making it untappable, and would misalign display
  // pixels against the photo's own pixels for anything later drawn on the
  // original image.
  useEffect(() => {
    if (!photoUri) {
      setPhotoSize(null);
      return;
    }
    let cancelled = false;
    Image.getSize(
      photoUri,
      (width, height) => {
        if (!cancelled) setPhotoSize({ width, height });
      },
      () => {
        if (!cancelled) setPhotoSize(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [photoUri]);

  const photoAspectRatio =
    photoSize && photoSize.width > 0 && photoSize.height > 0 ? photoSize.width / photoSize.height : 3 / 4;

  // The real transform from a tap on this preview to a pixel of the actual
  // stored photo (see domain/coordinate-transform.ts) — null until both the
  // photo's own dimensions and the on-screen box's layout are known, in
  // which case points fall back to raw display pixels rather than blocking
  // capture.
  const frameGeometry: FrameGeometry | null =
    photoSize && photoSize.width > 0 && photoSize.height > 0 && size.width > 0 && size.height > 0
      ? {
          sourceWidth: photoSize.width,
          sourceHeight: photoSize.height,
          displayWidth: size.width,
          displayHeight: size.height,
          fit: 'cover',
        }
      : null;
  const toSourcePoint = (point: Point2D): Point2D =>
    (frameGeometry && displayToSource(point, frameGeometry)) || point;
  const toDisplayPoint = (point: Point2D): Point2D =>
    (frameGeometry && sourceToDisplay(point, frameGeometry)) || point;

  const openCamera = async () => {
    setCaptureError(null);
    if (!permission?.granted) {
      const response = await requestPermission();
      if (!response.granted) {
        setPermissionProblem(response.canAskAgain ? 'denied' : 'blocked');
        return;
      }
    }
    setPermissionProblem(null);
    setPhotoUri(null);
  };

  const takePhoto = async () => {
    if (!cameraReady) return;
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.8 });
      if (!photo?.uri) {
        setCaptureError('takePictureAsync returned no URI');
        return;
      }
      const persisted = await persistMedia(photo.uri, 'photo', 'jpg');
      if (!persisted.ok) {
        setCaptureError(`${t(persisted.error.messageKey)} — ${persisted.error.detail}`);
        return;
      }
      setPhotoUri(persisted.media.uri);
      setRimPoints([]);
      setWaterLine(null);
      setInitialWaterLine(null);
      setWaterLineHistory([]);
      patchDraft({
        photoUri: persisted.media.uri,
        ...(gravity ? { gravity } : {}),
        orientation: 'portrait',
      });
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error));
    }
  };

  const addPoint = (x: number, y: number) => {
    // Stored in the photo's own source-pixel frame, not the preview box's —
    // see domain/coordinate-transform.ts. Rim marking only — the waterline is
    // now placed by dragging (see WaterLineEditor), not by tapping.
    const point = toSourcePoint({ x, y });
    setRimPoints((current) => (current.length >= MAX_RIM_POINTS ? current : [...current, point]));
  };

  const useDepth = () => {
    const estimate = liveEstimate;
    if (!estimate?.ok || !waterLine) return;
    const motion = summarizeMotion({
      accelerometerAvailable: gravity !== null,
      gyroscopeAvailable: false,
      deviceMotionAvailable: false,
      gravitySamples: gravity ? [gravity] : [],
      angularSpeedsDegPerSec: [],
      linearAccelSamplesMps2: [],
    });
    const sensorSnapshot: SensorSnapshot = {
      timestamp: Date.now(),
      device: captureDeviceInfo(),
      camera: {
        available: true,
        facing: 'back',
        zoom: ZOOM,
        ...(photoSize ? { sourceWidth: photoSize.width, sourceHeight: photoSize.height } : {}),
        intrinsicsAvailable: false,
        distortionAvailable: false,
      },
      motion,
    };
    const cameraLevelEvidence: CameraLevelEvidence = {
      ...(photoSize ? { sourceImageWidth: photoSize.width, sourceImageHeight: photoSize.height } : {}),
      rimPoints,
      waterlinePoints: toEndpoints(waterLine),
      waterLineModel: {
        midpointX: waterLine.midpoint.x,
        midpointY: waterLine.midpoint.y,
        angleRad: waterLine.angleRad,
        halfLengthPx: waterLine.halfLengthPx,
      },
      fit: estimate.value.fit,
      ...(gravity ? { gravityVector: gravity } : {}),
      ...(motion.pitchDeg !== undefined ? { pitchDeg: motion.pitchDeg } : {}),
      ...(motion.rollDeg !== undefined ? { rollDeg: motion.rollDeg } : {}),
      imageOrientation: 'portrait',
      algorithmVersion: ALGORITHM_VERSION,
    };
    patchDraft({
      depth: estimate.value.depth,
      levelMethod: 'camera-assisted',
      ...(gravity ? { gravity } : {}),
      cameraLevelEvidence,
      sensorSnapshot,
    });
    router.back();
  };

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  };

  if (draft.dimensions.kind !== 'circular') {
    return (
      <Screen>
        <ErrorBlock title={t('common.error')} detail="camera-assisted level requires a circular pipe" />
      </Screen>
    );
  }

  return (
    <Screen>
      <Badge label={t('common.experimental')} tone="experimental" />
      <SectionTitle>{t('level.camera.title')}</SectionTitle>
      <Note tone="warning">{t('level.camera.affineModelLimitation')}</Note>
      <Muted>{t('level.camera.instructions')}</Muted>

      {permissionProblem ? (
        <ErrorBlock
          title={t(permissionProblem === 'blocked' ? 'video.permissionBlocked' : 'video.permissionDenied')}
        >
          {permissionProblem === 'blocked' ? (
            <Button
              label={t('common.openAndroidSettings')}
              variant="secondary"
              onPress={() => void Linking.openSettings()}
            />
          ) : (
            <Button label={t('video.grantPermission')} variant="secondary" onPress={openCamera} />
          )}
        </ErrorBlock>
      ) : null}

      {captureError ? (
        <ErrorBlock title={t('common.error')} detail={captureError} detailLabel={t('common.technicalDetail')} />
      ) : null}

      {!photoUri ? (
        <Card>
          <View style={styles.frame}>
            {permission?.granted ? (
              <CameraView
                ref={cameraRef}
                style={StyleSheet.absoluteFill}
                facing="back"
                mode="picture"
                zoom={ZOOM}
                onCameraReady={() => setCameraReady(true)}
                onMountError={(event) => setMountError(event.message ?? 'unknown mount error')}
              />
            ) : null}
            {!permission?.granted || !cameraReady ? (
              <View style={styles.overlay}>
                <Text style={styles.overlayText}>
                  {mountError ? t('video.cameraStartupFailed') : t('video.cameraStarting')}
                </Text>
              </View>
            ) : null}
          </View>
          {mountError ? (
            <ErrorBlock
              title={t('video.cameraStartupFailed')}
              detail={mountError}
              detailLabel={t('common.technicalDetail')}
            />
          ) : null}
          {permission?.granted ? (
            <Button label={t('level.camera.takePhoto')} onPress={takePhoto} disabled={!cameraReady} />
          ) : (
            <Button label={t('video.grantPermission')} onPress={openCamera} />
          )}
        </Card>
      ) : (
        <>
          {mode === 'rim' ? (
            <>
              <View style={[styles.frame, { aspectRatio: photoAspectRatio }]} onLayout={onLayout}>
                <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                <Pressable
                  style={StyleSheet.absoluteFill}
                  onPress={(event) => addPoint(event.nativeEvent.locationX, event.nativeEvent.locationY)}
                >
                  <View style={StyleSheet.absoluteFill}>
                    {rimPoints.map((point, index) => {
                      const display = toDisplayPoint(point);
                      return (
                        <View
                          key={`rim-${index}`}
                          style={[styles.marker, { left: display.x - 6, top: display.y - 6 }]}
                        />
                      );
                    })}
                  </View>
                </Pressable>
              </View>
              <Muted>
                {size.width > 0 ? `${Math.round(size.width)}×${Math.round(size.height)} px` : ''}
              </Muted>
            </>
          ) : ellipseFit?.ok && waterLine && photoSize ? (
            <>
              <WaterLineEditor
                photoUri={photoUri}
                sourceSize={photoSize}
                waterLine={waterLine}
                onChange={setWaterLine}
                onGestureStart={pushWaterLineUndo}
                aspectRatio={photoAspectRatio}
                rimPoints={rimPoints}
              />
              <Muted>{t('level.camera.waterlineInstructions')}</Muted>
              <View style={styles.modeRow}>
                <Button
                  label={t('level.camera.undo')}
                  variant="secondary"
                  onPress={undoWaterLine}
                  disabled={waterLineHistory.length === 0}
                />
                <Button
                  label={t('level.camera.resetLine')}
                  variant="secondary"
                  onPress={resetWaterLine}
                  disabled={!initialWaterLine}
                />
              </View>
            </>
          ) : (
            <ErrorBlock
              title={
                ellipseFit && !ellipseFit.ok
                  ? t(ellipseFit.error.messageKey)
                  : t('level.camera.needMoreRimPoints')
              }
              detail={ellipseFit && !ellipseFit.ok ? ellipseFit.error.detail : undefined}
              detailLabel={t('common.technicalDetail')}
            />
          )}

          <View style={styles.modeRow}>
            <Button
              label={`${t('level.camera.rimPoints')} ${rimPoints.length}/${MAX_RIM_POINTS}`}
              variant={mode === 'rim' ? 'primary' : 'secondary'}
              onPress={() => setMode('rim')}
            />
            <Button
              label={t('level.camera.waterlinePoints')}
              variant={mode === 'waterline' ? 'primary' : 'secondary'}
              onPress={() => setMode('waterline')}
            />
          </View>

          <Button
            label={t('level.camera.clearPoints')}
            variant="secondary"
            onPress={() => {
              setRimPoints([]);
              setWaterLine(null);
              setInitialWaterLine(null);
              setWaterLineHistory([]);
            }}
          />
          <Button label={t('level.camera.retake')} variant="secondary" onPress={() => setPhotoUri(null)} />
        </>
      )}

      {liveEstimate && !liveEstimate.ok ? (
        <ErrorBlock
          title={t(liveEstimate.error.messageKey)}
          detail={liveEstimate.error.detail}
          detailLabel={t('common.technicalDetail')}
        />
      ) : null}

      {liveEstimate?.ok ? (
        <Card tone={liveEstimate.value.confidence === 'WEAK' ? 'warning' : 'neutral'}>
          <ValueRow
            label={t('measure.depth')}
            value={formatNumber(fromMetres(liveEstimate.value.depth, draft.unit), 3)}
            unit={draft.unit}
            provenance={t('provenance.measured')}
          />
          <ValueRow label={t('report.fillRatio')} value={formatNumber(liveEstimate.value.fillRatio, 3)} />
          <ValueRow
            label={t('level.camera.confidence')}
            value={liveEstimate.value.confidence}
            tone={liveEstimate.value.confidence === 'WEAK' ? 'warning' : 'neutral'}
          />
          <ValueRow
            label="rim fit"
            value={`${liveEstimate.value.fit.inlierCount} pts · residual ${formatNumber(liveEstimate.value.fit.residual, 2)} px · axis ratio ${formatNumber(liveEstimate.value.fit.axisRatio, 3)}`}
          />
          <Note tone="warning">{t('level.camera.affineModelLimitation')}</Note>
          <Button label={t('level.camera.useDepth')} onPress={useDepth} />
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: colors.border,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  overlayText: { ...typography.sectionTitle, color: colors.warning },
  marker: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: 'rgba(5,11,14,0.4)',
  },
  modeRow: { flexDirection: 'row', gap: spacing.sm },
});
