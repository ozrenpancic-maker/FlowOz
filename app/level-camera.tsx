import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Accelerometer } from 'expo-sensors';

import { estimateDepthFromRim, fitEllipse, MAX_RIM_POINTS, MIN_RIM_POINTS, type Point2D } from '../domain/ellipse';
import { formatNumber, fromMetres } from '../domain/units';
import { persistMedia } from '../storage/media-storage';
import { useMeasurement } from '../state/measurement-context';
import { useSettings } from '../state/settings-context';
import { Badge, Button, Card, ErrorBlock, Muted, Note, Screen, SectionTitle, ValueRow } from '../ui/components';
import { colors, radius, spacing, typography } from '../ui/theme';

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
  const [waterline, setWaterline] = useState<Point2D[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [gravity, setGravity] = useState<{ x: number; y: number; z: number } | null>(null);
  const [estimate, setEstimate] = useState<ReturnType<typeof estimateDepthFromRim> | null>(null);

  const diameter = draft.dimensions.kind === 'circular' ? draft.dimensions.diameter : 0;

  // The gravity vector fixes which side of the water line is the invert.
  useEffect(() => {
    Accelerometer.setUpdateInterval(400);
    const subscription = Accelerometer.addListener((reading) => setGravity(reading));
    return () => subscription.remove();
  }, []);

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
      setWaterline([]);
      setEstimate(null);
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
    const point = { x, y };
    if (mode === 'rim') {
      setRimPoints((current) => (current.length >= MAX_RIM_POINTS ? current : [...current, point]));
    } else {
      setWaterline((current) => (current.length >= 2 ? [point] : [...current, point]));
    }
    setEstimate(null);
  };

  const runFit = () => {
    const fit = fitEllipse(rimPoints);
    if (!fit.ok) {
      setEstimate({ ok: false, error: fit.error });
      return;
    }
    if (waterline.length !== 2) {
      setEstimate({
        ok: false,
        error: {
          code: 'WATERLINE_OUTSIDE_RIM',
          messageKey: 'level.camera.waterlinePoints',
          detail: `${waterline.length}/2`,
        },
      });
      return;
    }
    setEstimate(
      estimateDepthFromRim(
        fit.value,
        [waterline[0] as Point2D, waterline[1] as Point2D],
        diameter,
        gravity ?? undefined
      )
    );
  };

  const useDepth = () => {
    if (!estimate?.ok) return;
    patchDraft({
      depth: estimate.value.depth,
      levelMethod: 'camera-assisted',
      ...(gravity ? { gravity } : {}),
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
          <View style={styles.frame} onLayout={onLayout}>
            <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={(event) => addPoint(event.nativeEvent.locationX, event.nativeEvent.locationY)}
            >
              <View style={StyleSheet.absoluteFill}>
                {rimPoints.map((point, index) => (
                  <View key={`rim-${index}`} style={[styles.marker, { left: point.x - 6, top: point.y - 6 }]} />
                ))}
                {waterline.map((point, index) => (
                  <View
                    key={`water-${index}`}
                    style={[styles.marker, styles.markerWater, { left: point.x - 6, top: point.y - 6 }]}
                  />
                ))}
              </View>
            </Pressable>
          </View>
          <Muted>
            {size.width > 0 ? `${Math.round(size.width)}×${Math.round(size.height)} px` : ''}
          </Muted>

          <View style={styles.modeRow}>
            <Button
              label={`${t('level.camera.rimPoints')} ${rimPoints.length}/${MAX_RIM_POINTS}`}
              variant={mode === 'rim' ? 'primary' : 'secondary'}
              onPress={() => setMode('rim')}
            />
            <Button
              label={`${t('level.camera.waterlinePoints')} ${waterline.length}/2`}
              variant={mode === 'waterline' ? 'primary' : 'secondary'}
              onPress={() => setMode('waterline')}
            />
          </View>

          <Button
            label={t('level.camera.clearPoints')}
            variant="secondary"
            onPress={() => {
              setRimPoints([]);
              setWaterline([]);
              setEstimate(null);
            }}
          />
          <Button label={t('level.camera.retake')} variant="secondary" onPress={() => setPhotoUri(null)} />
          <Button
            label={t('level.camera.estimate')}
            onPress={runFit}
            disabled={rimPoints.length < MIN_RIM_POINTS || waterline.length !== 2}
          />
        </>
      )}

      {estimate && !estimate.ok ? (
        <ErrorBlock
          title={t(estimate.error.messageKey)}
          detail={estimate.error.detail}
          detailLabel={t('common.technicalDetail')}
        />
      ) : null}

      {estimate?.ok ? (
        <Card tone={estimate.value.confidence === 'WEAK' ? 'warning' : 'neutral'}>
          <ValueRow
            label={t('measure.depth')}
            value={formatNumber(fromMetres(estimate.value.depth, draft.unit), 3)}
            unit={draft.unit}
            provenance={t('provenance.measured')}
          />
          <ValueRow label={t('report.fillRatio')} value={formatNumber(estimate.value.fillRatio, 3)} />
          <ValueRow
            label={t('level.camera.confidence')}
            value={estimate.value.confidence}
            tone={estimate.value.confidence === 'WEAK' ? 'warning' : 'neutral'}
          />
          <ValueRow
            label="rim fit"
            value={`${estimate.value.fit.inlierCount} pts · residual ${formatNumber(estimate.value.fit.residual, 2)} px · axis ratio ${formatNumber(estimate.value.fit.axisRatio, 3)}`}
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
  markerWater: { borderColor: colors.warning },
  modeRow: { flexDirection: 'row', gap: spacing.sm },
});
