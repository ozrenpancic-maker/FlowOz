import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';

import { videoFlow } from '../domain/hydraulics';
import { integrateVelocityAreaDischarge } from '../domain/lateral-profile';
import { computeSection } from '../domain/geometry';
import { createId } from '../domain/ids';
import { formatNumber, parseNumericInput } from '../domain/units';
import { persistMedia, type StoredMedia } from '../storage/media-storage';
import { useMeasurement } from '../state/measurement-context';
import { useSettings } from '../state/settings-context';
import { buildCalibration } from '../video/homography';
import type { SsivFailure } from '../video/failure-taxonomy';
import { defaultRoi, validateRoi } from '../video/roi';
import { SSIV_THRESHOLDS, type SsivAnalysis } from '../video/types';
import { lateralVelocityProfile } from '../video/lateral-profile';
import { classifyStability, type MotionSummary, type SensorSnapshot } from '../domain/sensor-snapshot';
import { alignWithSiteReference, cameraChangedFromReference } from '../domain/site-reference';
import type { FlowDirection, SiteCameraReference } from '../domain/types';
import { MotionSampler } from '../sensors/motion-sampler';
import { captureDeviceInfo } from '../sensors/device-info';
import { RoiEditor } from '../ui/RoiEditor';
import { VectorOverlay } from '../ui/VectorOverlay';
import { SsivProcessor, type SsivProgress, type SsivRequest } from '../ui/SsivProcessor';
import {
  Badge,
  Button,
  Card,
  Choice,
  ErrorBlock,
  Field,
  Muted,
  Note,
  Screen,
  SectionTitle,
  ValueRow,
} from '../ui/components';
import { colors, radius, spacing, typography } from '../ui/theme';

/** Reference implementation limit: roughly 80 MB per clip. */
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
/** Working resolution of the recording; the analysis downscales further. */
const VIDEO_QUALITY = '720p' as const;
/** No digital zoom for a metric measurement (Phase 7): uncontrolled zoom
 * changes the pixel-to-metre scale the ROI calibration assumes. Normalised
 * 0–1 per CameraViewProps.zoom; 0 is the camera's unzoomed field of view. */
const ZOOM = 0;

type CameraState = 'idle' | 'starting' | 'ready' | 'mount-error';

export default function VideoVelocityScreen() {
  const router = useRouter();
  const { t, settings, repository } = useSettings();
  const { draft, patchDraft, setAnalysis, retryOriginId } = useMeasurement();
  const [siteReference, setSiteReference] = useState<SiteCameraReference | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [mountError, setMountError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaDetail, setMediaDetail] = useState<string | null>(null);
  const [stored, setStored] = useState<StoredMedia | null>(null);
  const [duration, setDuration] = useState<3 | 5 | 10>(settings.defaultVideoDurationS);
  const [showCamera, setShowCamera] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const motionSamplerRef = useRef<MotionSampler | null>(null);
  const [capturedMotion, setCapturedMotion] = useState<MotionSummary | null>(null);

  // Never leave a sensor subscription running past this screen: if the
  // operator navigates away mid-recording, stop the sampler on unmount
  // rather than let it keep listening in the background.
  useEffect(() => {
    return () => {
      motionSamplerRef.current?.stop();
      motionSamplerRef.current = null;
    };
  }, []);

  // A Site's saved camera reference (Phase 3), when this measurement belongs
  // to one — used only to show ALIGN WITH SITE REFERENCE / CAMERA
  // CONFIGURATION CHANGED, never to gate or alter the measurement itself.
  useEffect(() => {
    let cancelled = false;
    if (!draft.siteId) {
      setSiteReference(null);
      return;
    }
    repository
      .getSite(draft.siteId)
      .then((site) => {
        if (!cancelled) setSiteReference(site?.referenceCameraOrientation ?? null);
      })
      .catch(() => {
        if (!cancelled) setSiteReference(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.siteId, repository]);

  const [roi, setRoi] = useState(draft.waterRoi ?? defaultRoi());
  const [flowDirection, setFlowDirection] = useState<FlowDirection>(draft.flowDirection ?? 'FORWARD');
  const [widthText, setWidthText] = useState(
    draft.knownRoiDimensions ? String(draft.knownRoiDimensions.widthM) : ''
  );
  const [lengthText, setLengthText] = useState(
    draft.knownRoiDimensions ? String(draft.knownRoiDimensions.lengthM) : ''
  );

  const [request, setRequest] = useState<SsivRequest | null>(null);
  const [progress, setProgress] = useState<SsivProgress>('idle');
  const [analysis, setLocalAnalysis] = useState<SsivAnalysis | null>(null);
  const [failure, setFailure] = useState<SsivFailure | null>(null);
  const [showVectors, setShowVectors] = useState(false);

  const videoUri = stored?.uri ?? draft.videoUri ?? null;
  const player = useVideoPlayer(videoUri, (instance) => {
    instance.loop = true;
    instance.muted = true;
  });

  // The ROI is drawn on this preview and its normalised coordinates are later
  // read straight into the decoder's own frame — so the preview must show the
  // video's real aspect ratio. A default 16:9 box would make `contentFit="cover"`
  // crop a differently-shaped source, and every point the operator taps would
  // land on the wrong part of the frame the SSIV pipeline actually decodes.
  const { videoTrack } = useEvent(player, 'videoTrackChange', { videoTrack: player.videoTrack });
  const roiAspectRatio =
    videoTrack && videoTrack.size.width > 0 && videoTrack.size.height > 0
      ? videoTrack.size.width / videoTrack.size.height
      : 16 / 9;

  const widthM = parseNumericInput(widthText);
  const lengthM = parseNumericInput(lengthText);
  const knownDimensions =
    widthM !== null && lengthM !== null ? { widthM, lengthM } : null;

  // Calibration is validated against the analysis frame size; before a clip
  // exists we use its nominal 16:9 working size for the live status.
  const calibrationPreview = knownDimensions
    ? buildCalibration(
        roi,
        knownDimensions,
        SSIV_THRESHOLDS.processingWidthPx,
        Math.round((SSIV_THRESHOLDS.processingWidthPx * 9) / 16)
      )
    : null;
  const roiProblems = validateRoi(roi, knownDimensions ?? undefined);

  // ----------------------------------------------------------- permissions

  const openCamera = async () => {
    setMediaError(null);
    setMountError(null);

    if (!permission || !permission.granted) {
      const response = await requestPermission();
      if (!response.granted) {
        // Denied and permanently blocked are different situations with
        // different remedies; both are stated explicitly.
        setMediaError(response.canAskAgain ? 'video.permissionDenied' : 'video.permissionBlocked');
        return;
      }
    }
    // Permission is granted on this very tap: continue into the preview rather
    // than making the operator press the button a second time.
    setShowCamera(true);
    setCameraState('starting');
  };

  // -------------------------------------------------------------- capture

  const record = async () => {
    if (cameraState !== 'ready' || recording) return; // never record before onCameraReady
    setRecording(true);
    setMediaError(null);
    setMediaDetail(null);

    // Sampled for the actual acquisition window (Phase 2) — a single
    // instantaneous reading is not a stability metric. Stopped and read back
    // the moment recordAsync resolves, whichever way it ends (duration limit
    // or the operator's own STOP), so the window always matches the clip.
    const sampler = new MotionSampler();
    motionSamplerRef.current = sampler;
    void sampler.start();

    try {
      const result = await cameraRef.current?.recordAsync({
        maxDuration: duration,
        maxFileSize: MAX_VIDEO_BYTES,
      });
      const motion = motionSamplerRef.current === sampler ? sampler.stop() : null;
      motionSamplerRef.current = null;
      setCapturedMotion(motion);
      if (!result?.uri) {
        setMediaError('media.error.SOURCE_UNREADABLE');
        setMediaDetail('recordAsync returned no URI');
        return;
      }
      await adoptVideo(result.uri, 'camera', duration);
    } catch (error) {
      if (motionSamplerRef.current === sampler) {
        sampler.stop();
        motionSamplerRef.current = null;
      }
      setMediaError('media.error.SOURCE_UNREADABLE');
      setMediaDetail(error instanceof Error ? error.message : String(error));
    } finally {
      setRecording(false);
    }
  };

  const stopRecording = () => {
    cameraRef.current?.stopRecording();
  };

  const importVideo = async () => {
    setMediaError(null);
    setMediaDetail(null);
    setImportNote(null);
    // An imported clip was not recorded through this screen, so there is no
    // acquisition window to have sampled motion during.
    setCapturedMotion(null);

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsMultipleSelection: false,
        videoMaxDuration: 60,
      });
      if (result.canceled) {
        // Cancelling is a choice, not a failure.
        setImportNote(t('video.importCancelled'));
        return;
      }
      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setMediaError('media.error.SOURCE_UNREADABLE');
        setMediaDetail('the picker returned no URI');
        return;
      }
      await adoptVideo(asset.uri, 'import', asset.duration ? asset.duration / 1000 : undefined);
    } catch (error) {
      setMediaError('media.error.SOURCE_UNREADABLE');
      setMediaDetail(error instanceof Error ? error.message : String(error));
    }
  };

  /** Copy into permanent storage, verify it, and only then record it on the draft. */
  const adoptVideo = async (sourceUri: string, source: 'camera' | 'import', durationS?: number) => {
    const persisted = await persistMedia(sourceUri, 'video', extensionOf(sourceUri));
    if (!persisted.ok) {
      setMediaError(persisted.error.messageKey);
      setMediaDetail(persisted.error.detail);
      return;
    }

    setStored(persisted.media);
    setShowCamera(false);
    setCameraState('idle');
    setLocalAnalysis(null);
    setFailure(null);
    patchDraft({
      videoUri: persisted.media.uri,
      videoSource: source,
      videoCapturedAt: persisted.media.storedAt,
      ...(durationS !== undefined ? { videoDuration: durationS } : {}),
      surfaceVelocity: undefined,
    });
  };

  // -------------------------------------------------------------- analysis

  const runAnalysis = () => {
    if (!videoUri || !knownDimensions) return;
    setFailure(null);
    setLocalAnalysis(null);
    setShowVectors(false);
    setRequest({
      id: createId('ssiv'),
      videoUri,
      durationS: draft.videoDuration ?? duration,
      roi,
      knownDimensions,
      flowDirection,
    });
  };

  const handleResult = useCallback(
    (result: { ok: true; analysis: SsivAnalysis } | { ok: false; failure: SsivFailure }) => {
      setRequest(null);
      setProgress('idle');
      if (result.ok) {
        setLocalAnalysis(result.analysis);
        setFailure(null);
      } else {
        setLocalAnalysis(null);
        setFailure(result.failure);
      }
    },
    []
  );

  // Frozen once, at accept time: everything here is either known at capture
  // (motion, device identity) or only knowable after decode (resolution,
  // image quality) — accept is the first point both are available together,
  // the same point waterRoi/knownRoiDimensions/surfaceVelocity are already
  // finalised onto the draft.
  const buildSensorSnapshot = (result: SsivAnalysis): SensorSnapshot => ({
    timestamp: Date.now(),
    device: captureDeviceInfo(),
    camera: {
      available: true,
      facing: 'back',
      sourceWidth: result.sourceWidth,
      sourceHeight: result.sourceHeight,
      ...(videoTrack?.frameRate ? { nominalFps: videoTrack.frameRate } : {}),
      ...(result.frameDeltaS > 0
        ? {
            actualFps: 1 / result.frameDeltaS,
            observedFrameIntervalS: result.frameDeltaS,
            actualProcessingDeltaT: result.frameDeltaS,
            timingSource: 'WEBVIEW_MEDIA_TIME' as const,
          }
        : {}),
      // Only meaningful when this screen's own camera recorded the clip —
      // ZOOM below is the value it was held at; an imported clip's zoom, if
      // any was ever applied, was never under this app's control.
      ...(draft.videoSource === 'camera' ? { zoom: ZOOM } : {}),
      intrinsicsAvailable: false,
      distortionAvailable: false,
    },
    motion: capturedMotion ?? {
      accelerometerAvailable: false,
      gyroscopeAvailable: false,
      deviceMotionAvailable: false,
    },
    ...(draft.location
      ? {
          location: {
            available: true,
            latitude: draft.location.latitude,
            longitude: draft.location.longitude,
            ...(draft.location.accuracy !== undefined ? { accuracyM: draft.location.accuracy } : {}),
            ...(draft.location.altitude !== undefined ? { altitudeM: draft.location.altitude } : {}),
          },
        }
      : {}),
    ...(result.quality.imageQuality ? { imageQuality: result.quality.imageQuality } : {}),
  });

  const acceptResult = () => {
    if (!analysis || !knownDimensions) return;
    setAnalysis(analysis);
    patchDraft({
      surfaceVelocity: analysis.surfaceVelocity,
      waterRoi: roi,
      flowDirection,
      knownRoiDimensions: knownDimensions,
      method: 'video',
      sensorSnapshot: buildSensorSnapshot(analysis),
    });
    router.back();
  };

  // Preview of the discharge this result would produce, using the current draft.
  const previewFlow = (() => {
    if (!analysis || draft.depth === null) return null;
    const section = computeSection(draft.dimensions, draft.depth);
    if (!section.ok) return null;
    const flow = videoFlow(section.value, analysis.surfaceVelocity, draft.alpha);
    return flow.ok ? flow.value : null;
  })();

  // The lateral-profile cross-check — see domain/lateral-profile.ts for what
  // it assumes and why it never replaces previewFlow above.
  const lateralProfilePreview = (() => {
    if (!analysis || draft.depth === null) return null;
    const section = computeSection(draft.dimensions, draft.depth);
    if (!section.ok) return null;
    const profile = lateralVelocityProfile(analysis);
    const integrated = integrateVelocityAreaDischarge(
      draft.dimensions,
      draft.depth,
      section.value.topWidth,
      section.value.area,
      profile.columns,
      draft.alpha,
      profile.columnsTotal
    );
    return integrated.ok ? integrated.value : null;
  })();

  const busy = request !== null;

  // Repeatability check against a Site's saved camera pose (Phase 3) —
  // informational only, never a gate on the result.
  const orientationAlignment =
    siteReference && capturedMotion
      ? alignWithSiteReference(
          { pitchDeg: capturedMotion.pitchDeg, rollDeg: capturedMotion.rollDeg },
          siteReference
        )
      : null;
  const cameraConfigurationChanged =
    siteReference && analysis
      ? cameraChangedFromReference(
          {
            available: true,
            facing: 'back',
            sourceWidth: analysis.sourceWidth,
            sourceHeight: analysis.sourceHeight,
            ...(draft.videoSource === 'camera' ? { zoom: ZOOM } : {}),
            intrinsicsAvailable: false,
            distortionAvailable: false,
          },
          siteReference
        )
      : false;

  return (
    <Screen>
      <Badge label={t('video.experimentalBadge')} tone="experimental" />
      {retryOriginId ? <Note tone="warning">{t('video.retryHint')}</Note> : null}

      <SectionTitle>{t('video.title')}</SectionTitle>

      {/* ------------------------------------------------------- capture */}
      {!showCamera ? (
        <>
          <Choice
            label={t('video.duration')}
            value={duration}
            onChange={(next: 3 | 5 | 10) => setDuration(next)}
            options={[
              { value: 3 as const, label: '3 s' },
              { value: 5 as const, label: '5 s' },
              { value: 10 as const, label: '10 s' },
            ]}
          />
          <Button label={t('video.record')} onPress={openCamera} />
          <Button label={t('video.import')} variant="secondary" onPress={importVideo} />
          <Muted>{t('video.noAudio')}</Muted>
        </>
      ) : (
        <Card>
          <View style={styles.cameraFrame}>
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="back"
              mode="video"
              mute
              zoom={ZOOM}
              videoQuality={VIDEO_QUALITY}
              onCameraReady={() => setCameraState('ready')}
              onMountError={(event) => {
                setCameraState('mount-error');
                setMountError(event.message ?? 'unknown mount error');
              }}
            />
            {cameraState !== 'ready' ? (
              <View style={styles.cameraOverlay}>
                <Text style={styles.cameraOverlayText}>
                  {cameraState === 'mount-error'
                    ? t('video.cameraStartupFailed')
                    : t('video.cameraStarting')}
                </Text>
              </View>
            ) : null}
          </View>

          {cameraState === 'mount-error' ? (
            <ErrorBlock
              title={t('video.cameraStartupFailed')}
              detail={mountError ?? undefined}
              detailLabel={t('common.technicalDetail')}
            >
              <Button label={t('common.retry')} variant="secondary" onPress={() => setCameraState('starting')} />
            </ErrorBlock>
          ) : (
            <>
              <Note tone={cameraState === 'ready' ? 'pass' : 'warning'}>
                {cameraState === 'ready' ? t('video.cameraReady') : t('video.cameraStarting')}
              </Note>
              <Button
                label={recording ? t('video.recording') : t('video.record')}
                onPress={record}
                disabled={cameraState !== 'ready'}
                busy={recording}
              />
              {recording ? <Button label={t('video.stop')} variant="secondary" onPress={stopRecording} /> : null}
            </>
          )}
          <Button label={t('common.cancel')} variant="secondary" onPress={() => setShowCamera(false)} />
        </Card>
      )}

      {mediaError ? (
        <ErrorBlock
          title={t(mediaError)}
          action={
            mediaError === 'video.permissionBlocked' ? t('common.openAndroidSettings') : undefined
          }
          detail={mediaDetail ?? undefined}
          detailLabel={t('common.technicalDetail')}
        >
          {mediaError === 'video.permissionBlocked' ? (
            <Button
              label={t('common.openAndroidSettings')}
              variant="secondary"
              onPress={() => void Linking.openSettings()}
            />
          ) : null}
          {mediaError === 'video.permissionDenied' ? (
            <Button label={t('video.grantPermission')} variant="secondary" onPress={openCamera} />
          ) : null}
        </ErrorBlock>
      ) : null}
      {importNote ? <Note tone="warning">{importNote}</Note> : null}

      {/* ----------------------------------------------------------- ROI */}
      {videoUri ? (
        <>
          <Note tone="pass">{t('video.videoStored')}</Note>
          {stored ? (
            <Muted>
              {t('video.storedSize')}: {(stored.sizeBytes / (1024 * 1024)).toFixed(2)} MB ·{' '}
              {draft.videoSource === 'import' ? t('video.sourceImport') : t('video.sourceCamera')}
            </Muted>
          ) : null}

          <SectionTitle>{t('video.roiTitle')}</SectionTitle>
          <Muted>{t('video.roiHint')}</Muted>
          <RoiEditor
            roi={roi}
            onChange={setRoi}
            pointLabel={t('video.roiPoint')}
            aspectRatio={roiAspectRatio}
            sourceSize={videoTrack?.size}
            fit="cover"
            flowDirection={flowDirection}
          >
            <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit="cover" />
            {analysis ? <VectorOverlay analysis={analysis} /> : null}
          </RoiEditor>
          {analysis ? (
            <Muted>{t('video.vectorOverlayHint')}</Muted>
          ) : null}

          <Choice
            label={t('video.flowDirection.title')}
            value={flowDirection}
            onChange={(value: FlowDirection) => setFlowDirection(value)}
            options={[
              { value: 'FORWARD' as const, label: t('video.flowDirection.forward') },
              { value: 'REVERSED' as const, label: t('video.flowDirection.reversed') },
            ]}
          />
          <Muted>{t('video.flowDirection.hint')}</Muted>

          <SectionTitle>{t('video.knownDimensions')}</SectionTitle>
          <Muted>{t('video.scaleHint')}</Muted>
          <Field
            label={t('video.roiWidth')}
            unit="m"
            value={widthText}
            onChangeText={setWidthText}
            invalid={widthText !== '' && (widthM === null || widthM <= 0)}
          />
          <Field
            label={t('video.roiLength')}
            unit="m"
            value={lengthText}
            onChangeText={setLengthText}
            invalid={lengthText !== '' && (lengthM === null || lengthM <= 0)}
          />

          <ValueRow
            label={t('video.calibrationStatus')}
            value={
              calibrationPreview === null
                ? 'INVALID'
                : calibrationPreview.ok
                  ? calibrationPreview.value.status
                  : 'INVALID'
            }
            tone={calibrationPreview?.ok && calibrationPreview.value.status === 'VALID' ? 'pass' : 'error'}
          />
          {roiProblems.map((problem) => (
            <Note key={problem.code} tone="error">
              {t(problem.messageKey)} {problem.detail ? `· ${problem.detail}` : ''}
            </Note>
          ))}

          <Button
            label={busy ? (progress === 'analysing' ? t('video.analysing') : t('video.decoding')) : t('video.analyse')}
            onPress={runAnalysis}
            busy={busy}
            disabled={busy || knownDimensions === null || roiProblems.length > 0}
          />
          {draft.videoUri ? (
            <Button
              label={t('video.retry')}
              hint={t('video.retryHint')}
              variant="secondary"
              onPress={runAnalysis}
              disabled={busy || knownDimensions === null || roiProblems.length > 0}
            />
          ) : null}
        </>
      ) : (
        <Muted>{t('video.noVideo')}</Muted>
      )}

      {/* ------------------------------------------------------- failures */}
      {failure ? (
        <ErrorBlock
          title={t(failure.messageKey)}
          action={t(failure.actionKey)}
          detail={failure.detail}
          detailLabel={t('common.technicalDetail')}
        >
          {failure.evidence ? (
            <View style={styles.evidence}>
              {failure.evidence.acceptedVectors !== undefined ? (
                <ValueRow
                  label={t('video.acceptedVectors')}
                  value={`${failure.evidence.acceptedVectors}/${failure.evidence.totalVectors ?? 0}`}
                />
              ) : null}
              {failure.evidence.stablePairs !== undefined ? (
                <ValueRow
                  label={t('video.stablePairs')}
                  value={`${failure.evidence.stablePairs}/${failure.evidence.totalPairs ?? 0}`}
                />
              ) : null}
              {failure.evidence.calibrationStatus ? (
                <ValueRow label={t('video.calibrationStatus')} value={failure.evidence.calibrationStatus} />
              ) : null}
            </View>
          ) : null}
        </ErrorBlock>
      ) : null}

      {/* --------------------------------------------------------- result */}
      {analysis ? (
        <Card tone="pass">
          <SectionTitle>{t('measure.step.result')}</SectionTitle>
          <ValueRow
            label={t('video.surfaceVelocity')}
            value={formatNumber(analysis.surfaceVelocity, 4)}
            unit="m/s"
            provenance={t('provenance.measuredVideo')}
            detail={t(`video.velocitySource.${analysis.velocitySource}`)}
          />
          {analysis.velocitySource === 'ensemble' && analysis.instantaneousVelocity !== undefined ? (
            <ValueRow
              label={t('video.instantaneousVelocity')}
              value={formatNumber(analysis.instantaneousVelocity, 4)}
              unit="m/s"
            />
          ) : null}
          <ValueRow
            label={t('video.acceptedVectors')}
            value={`${analysis.quality.acceptedVectors}/${analysis.quality.totalVectors}`}
            detail={`${Math.round(analysis.quality.acceptanceRatio * 100)}%`}
          />
          <ValueRow label={t('video.rejectedVectors')} value={String(analysis.quality.rejectedVectors)} />
          <ValueRow
            label={t('video.stablePairs')}
            value={`${analysis.quality.stablePairs}/${analysis.quality.totalPairs}`}
          />
          <ValueRow
            label={t('video.cameraCompensation')}
            value={formatNumber(analysis.quality.cameraCompensationPx, 2)}
            unit="px"
          />
          {analysis.quality.crossFlowRatio > analysis.quality.crossFlowWarningRatio ? (
            <Note tone="warning">
              {t('video.crossFlowWarning')} ({formatNumber(analysis.quality.crossFlowRatio, 2)})
            </Note>
          ) : null}
          <ValueRow label={t('video.calibrationStatus')} value={analysis.calibrationStatus} tone="pass" />

          <SectionTitle>{t('video.cameraStability.title')}</SectionTitle>
          {capturedMotion ? (
            <>
              <ValueRow
                label={t('video.cameraStability.deviceMotion')}
                value={classifyStability(
                  capturedMotion.angularVelocityRmsDegPerSec,
                  capturedMotion.accelerationRmsMps2
                )}
              />
              {capturedMotion.angularVelocityRmsDegPerSec !== undefined ? (
                <ValueRow
                  label={t('video.cameraStability.angularMotion')}
                  value={formatNumber(capturedMotion.angularVelocityRmsDegPerSec, 2)}
                  unit="°/s RMS"
                  detail={capturedMotion.sampleCount !== undefined ? `n=${capturedMotion.sampleCount}` : undefined}
                />
              ) : null}
              {capturedMotion.pitchDeg !== undefined ? (
                <ValueRow label={t('video.cameraStability.pitch')} value={formatNumber(capturedMotion.pitchDeg, 1)} unit="°" />
              ) : null}
              {capturedMotion.rollDeg !== undefined ? (
                <ValueRow label={t('video.cameraStability.roll')} value={formatNumber(capturedMotion.rollDeg, 1)} unit="°" />
              ) : null}
            </>
          ) : (
            <Note tone="neutral">{t('video.cameraStability.unavailable')}</Note>
          )}

          {cameraConfigurationChanged ? (
            <Note tone="warning">{t('video.siteReference.configChanged')}</Note>
          ) : null}
          {orientationAlignment ? (
            <>
              <SectionTitle>{t('video.siteReference.title')}</SectionTitle>
              {orientationAlignment.pitch ? (
                <ValueRow
                  label={t('video.cameraStability.pitch')}
                  value={`${orientationAlignment.pitch.deltaDeg >= 0 ? '+' : ''}${formatNumber(orientationAlignment.pitch.deltaDeg, 1)}°`}
                  tone={orientationAlignment.pitch.band === 'POOR' ? 'error' : 'pass'}
                  detail={orientationAlignment.pitch.band}
                />
              ) : null}
              {orientationAlignment.roll ? (
                <ValueRow
                  label={t('video.cameraStability.roll')}
                  value={`${orientationAlignment.roll.deltaDeg >= 0 ? '+' : ''}${formatNumber(orientationAlignment.roll.deltaDeg, 1)}°`}
                  tone={orientationAlignment.roll.band === 'POOR' ? 'error' : 'pass'}
                  detail={orientationAlignment.roll.band}
                />
              ) : null}
              {orientationAlignment.heading ? (
                <ValueRow
                  label={t('video.siteReference.heading')}
                  value={`${orientationAlignment.heading.deltaDeg >= 0 ? '+' : ''}${formatNumber(orientationAlignment.heading.deltaDeg, 1)}°`}
                  detail={orientationAlignment.heading.band}
                />
              ) : (
                <ValueRow label={t('video.siteReference.heading')} value={t('common.withheld')} withheld />
              )}
            </>
          ) : null}

          <ValueRow
            label={t('video.alphaUsed')}
            value={formatNumber(draft.alpha, 3)}
            provenance={t(`provenance.${draft.alphaProvenance.toLowerCase()}`)}
          />
          {previewFlow ? (
            <>
              <ValueRow label={t('video.meanVelocity')} value={formatNumber(previewFlow.meanVelocity, 4)} unit="m/s" />
              <ValueRow label={t('video.flow')} value={formatNumber(previewFlow.flow, 5)} unit="m³/s" />
            </>
          ) : null}
          {lateralProfilePreview ? (
            <ValueRow
              label={t('video.lateralProfileFlow')}
              value={formatNumber(lateralProfilePreview.flow, 5)}
              unit="m³/s"
              detail={`${lateralProfilePreview.columnsUsed}/${lateralProfilePreview.columnsTotal} ${t('video.lateralProfileColumns')}`}
            />
          ) : (
            <Note tone="neutral">{t('video.lateralProfileUnavailable')}</Note>
          )}
          <ValueRow label={t('quality.uncertainty')} value={t('quality.uncertaintyWithheld')} withheld />

          <Button
            label={t('video.viewVectors')}
            variant="secondary"
            onPress={() => setShowVectors((current) => !current)}
          />
          {showVectors ? <VectorTable analysis={analysis} /> : null}
          <Button label={t('video.useResult')} onPress={acceptResult} />
        </Card>
      ) : null}

      <SsivProcessor request={request} onResult={handleResult} onProgress={setProgress} />
    </Screen>
  );
}

function VectorTable({ analysis }: { analysis: SsivAnalysis }) {
  return (
    <View style={styles.vectorTable}>
      <Text style={styles.vectorHeader}>pair · col,row · dx,dy px · corr · ratio · unc · f/b · coh · v</Text>
      {analysis.vectors.map((vector, index) => (
        <Text
          key={`${vector.pairIndex}-${vector.gridColumn}-${vector.gridRow}-${index}`}
          style={[styles.vectorRow, vector.accepted ? styles.vectorAccepted : styles.vectorRejected]}
        >
          {vector.pairIndex} · {vector.gridColumn},{vector.gridRow} ·{' '}
          {formatNumber(vector.dxPx, 2)},{formatNumber(vector.dyPx, 2)} ·{' '}
          {formatNumber(vector.correlation, 3)} · {formatNumber(vector.peakRatio, 3)} ·{' '}
          {formatNumber(vector.uncertaintyPx, 2)} · {formatNumber(vector.forwardBackwardPx, 2)} ·{' '}
          {formatNumber(vector.spatialCoherence, 2)} ·{' '}
          {vector.velocityMs !== undefined ? `${formatNumber(vector.velocityMs, 3)} m/s` : '—'}
          {vector.accepted ? '' : ` · ${vector.rejectionReason ?? ''}`}
        </Text>
      ))}
    </View>
  );
}

function extensionOf(uri: string): string {
  const match = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(uri);
  return match?.[1] ?? 'mp4';
}

const styles = StyleSheet.create({
  cameraFrame: {
    width: '100%',
    aspectRatio: 3 / 4,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  cameraOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  cameraOverlayText: { ...typography.sectionTitle, color: colors.warning, textAlign: 'center' },
  evidence: { marginTop: spacing.sm },
  vectorTable: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: 2,
  },
  vectorHeader: { ...typography.small, color: colors.textMuted },
  vectorRow: { fontSize: 10, fontFamily: 'monospace' },
  vectorAccepted: { color: colors.pass },
  vectorRejected: { color: colors.textFaint },
});
