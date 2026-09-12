import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';

import type { SavedMeasurement } from '../../domain/measurement';
import { classifyAccuracy } from '../../domain/gps';
import { median } from '../../domain/linalg';
import { formatNumber } from '../../domain/units';
import { classifyStability } from '../../domain/sensor-snapshot';
import { buildSiteCameraReference } from '../../domain/site-reference';
import { gradeContrast, gradeExposure, gradeGlare, gradeSharpness } from '../../video/image-quality';
import { buildReportModel, exportFileName } from '../../reports/report-model';
import { generatePdf } from '../../reports/pdf';
import { toCsv } from '../../reports/csv';
import { saveFileWithSaf, saveTextWithSaf, shareFile, writeTempTextFile } from '../../reports/android-share';
import { mediaExists } from '../../storage/media-storage';
import { useMeasurement } from '../../state/measurement-context';
import { useSettings } from '../../state/settings-context';
import {
  Badge,
  Button,
  Card,
  ErrorBlock,
  Muted,
  Note,
  Screen,
  SectionTitle,
  ValueRow,
} from '../../ui/components';
import { VectorOverlay } from '../../ui/VectorOverlay';
import { colors, gradeTone, radius, spacing, typography } from '../../ui/theme';

export default function MeasurementDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, repository, ready, settings } = useSettings();
  const { startRetry } = useMeasurement();

  const [measurement, setMeasurement] = useState<SavedMeasurement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [videoPresent, setVideoPresent] = useState<boolean | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(async () => {
    if (!ready || !id) return;
    try {
      const record = await repository.getMeasurement(id);
      setMeasurement(record);
      setError(null);
      if (record?.videoUri) setVideoPresent(await mediaExists(record.videoUri));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [ready, id, repository]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const player = useVideoPlayer(
    measurement?.videoUri && videoPresent ? measurement.videoUri : null,
    (instance) => {
      instance.loop = true;
      instance.muted = true;
    }
  );

  const exportPdf = async (share: boolean) => {
    if (!measurement || busy) return;
    setBusy('pdf');
    setNote(null);
    setError(null);
    try {
      const model = buildReportModel(measurement, settings);
      const pdf = await generatePdf(model, t);
      if (!pdf.ok) {
        setError(`${t(pdf.error.messageKey)} — ${pdf.error.detail}`);
        return;
      }
      const fileName = exportFileName(measurement, 'pdf');
      if (share) {
        const shared = await shareFile(pdf.uri, 'application/pdf', t('saved.sharePdf'));
        setNote(shared.ok ? t('export.saved') : t(shared.error.messageKey));
        return;
      }
      const outcome = await saveFileWithSaf(pdf.uri, fileName);
      if (!outcome.ok) {
        setError(`${t(outcome.error.messageKey)} — ${outcome.error.detail}`);
        return;
      }
      setNote('cancelled' in outcome ? t('export.cancelled') : t('export.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async (share: boolean) => {
    if (!measurement || busy) return;
    setBusy('csv');
    setNote(null);
    setError(null);
    try {
      const csv = toCsv([measurement], settings.csvFormat);
      const fileName = exportFileName(measurement, 'csv');
      if (share) {
        const temp = await writeTempTextFile(fileName, csv);
        if (!temp) {
          setError('cache directory unavailable');
          return;
        }
        const shared = await shareFile(temp, 'text/csv', t('saved.shareCsv'));
        setNote(shared.ok ? t('export.saved') : t(shared.error.messageKey));
        return;
      }
      const outcome = await saveTextWithSaf(fileName, csv);
      if (!outcome.ok) {
        setError(`${t(outcome.error.messageKey)} — ${outcome.error.detail}`);
        return;
      }
      setNote('cancelled' in outcome ? t('export.cancelled') : t('export.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const saveAsSiteReference = async () => {
    if (!measurement?.siteId || !measurement.sensorSnapshot || busy) return;
    setBusy('site-reference');
    setError(null);
    setNote(null);
    try {
      const site = await repository.getSite(measurement.siteId);
      if (!site) {
        setError(t('saved.siteReference.siteMissing'));
        return;
      }
      await repository.saveSite({
        ...site,
        referenceCameraOrientation: buildSiteCameraReference(measurement.sensorSnapshot, measurement.waterRoi),
        updatedAt: new Date().toISOString(),
      });
      setNote(t('saved.siteReference.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!measurement || busy) return;
    setBusy('delete');
    setError(null);
    try {
      const result = await repository.deleteMeasurement(measurement.id);
      // Media is only released when no other saved record still points at it.
      setNote(result.orphanedMedia.length > 0 ? t('saved.mediaOrphaned') : t('saved.mediaKept'));
      router.back();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  if (error && !measurement) {
    return (
      <Screen>
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      </Screen>
    );
  }
  if (!measurement) {
    return (
      <Screen>
        <Muted>{t('common.loading')}</Muted>
      </Screen>
    );
  }

  const analysis = measurement.videoAnalysis;

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.id}>{measurement.displayId ?? measurement.id}</Text>
        <Badge label={measurement.confidence} tone={gradeTone(measurement.confidence)} />
      </View>
      <Muted>
        {measurement.createdAt} · {measurement.siteName ?? t('measure.oneOff')} ·{' '}
        {measurement.processingStatus}
      </Muted>

      {error ? (
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      ) : null}
      {note ? <Note tone="pass">{note}</Note> : null}

      <SectionTitle>{t('report.section.result')}</SectionTitle>
      <Card tone={gradeTone(measurement.confidence)}>
        <ValueRow
          label={t('report.flowM3s')}
          value={typeof measurement.flowM3s === 'number' ? formatNumber(measurement.flowM3s, 5) : t('common.withheld')}
          unit={typeof measurement.flowM3s === 'number' ? 'm³/s' : undefined}
          withheld={typeof measurement.flowM3s !== 'number'}
          provenance={t('provenance.calculated')}
        />
        <ValueRow label={t('report.meanVelocity')} value={formatNumber(measurement.velocity ?? null, 4)} unit="m/s" />
        <ValueRow label={t('report.area')} value={formatNumber(measurement.area ?? null, 5)} unit="m²" />
        <ValueRow label={t('report.depth')} value={formatNumber(measurement.depth, 4)} unit="m" />
        {measurement.fillRatio !== undefined ? (
          <ValueRow label={t('report.fillRatio')} value={formatNumber(measurement.fillRatio, 3)} />
        ) : null}
        <ValueRow label={t('quality.uncertainty')} value={measurement.dataQuality.uncertainty} withheld />
      </Card>

      <SectionTitle>{t('report.section.quality')}</SectionTitle>
      <Card>
        <ValueRow
          label={t('report.geometryQuality')}
          value={measurement.dataQuality.geometry.grade}
          detail={t(measurement.dataQuality.geometry.reasonKey)}
          tone={gradeTone(measurement.dataQuality.geometry.grade)}
        />
        <ValueRow
          label={t('report.levelQuality')}
          value={measurement.dataQuality.level.grade}
          detail={t(measurement.dataQuality.level.reasonKey)}
          tone={gradeTone(measurement.dataQuality.level.grade)}
        />
        <ValueRow
          label={t('report.velocityQuality')}
          value={measurement.dataQuality.velocity.grade}
          detail={t(measurement.dataQuality.velocity.reasonKey)}
          tone={gradeTone(measurement.dataQuality.velocity.grade)}
        />
      </Card>

      {measurement.location ? (
        <>
          <SectionTitle>{t('report.section.location')}</SectionTitle>
          <Card>
            <ValueRow label={t('report.latitude')} value={formatNumber(measurement.location.latitude, 6)} unit="°" />
            <ValueRow label={t('report.longitude')} value={formatNumber(measurement.location.longitude, 6)} unit="°" />
            <ValueRow
              label={t('gps.accuracy')}
              value={`${formatNumber(measurement.location.accuracy ?? null, 1)} m · ${t(
                `gps.class.${classifyAccuracy(measurement.location.accuracy)}`
              )}`}
            />
          </Card>
        </>
      ) : null}

      {measurement.method === 'video' ? (
        <>
          <SectionTitle>{t('video.title')}</SectionTitle>
          <Badge label={t('video.experimentalBadge')} tone="experimental" />
          <Card>
            <ValueRow
              label={t('video.surfaceVelocity')}
              value={formatNumber(measurement.surfaceVelocity ?? null, 4)}
              unit="m/s"
              provenance={t('provenance.measuredVideo')}
            />
            <ValueRow
              label={t('video.alphaUsed')}
              value={formatNumber(measurement.alpha ?? null, 3)}
              provenance={t(`provenance.${measurement.provenance.alpha.toLowerCase()}`)}
            />
            {analysis ? (
              <>
                <ValueRow
                  label={t('video.acceptedVectors')}
                  value={`${analysis.quality.acceptedVectors}/${analysis.quality.totalVectors}`}
                  detail={`${Math.round(analysis.quality.acceptanceRatio * 100)}%`}
                />
                <ValueRow
                  label={t('video.stablePairs')}
                  value={`${analysis.quality.stablePairs}/${analysis.quality.totalPairs}`}
                />
                <ValueRow label={t('video.calibrationStatus')} value={analysis.calibrationStatus} />
                <ValueRow
                  label={t('video.cameraCompensation')}
                  value={formatNumber(analysis.quality.cameraCompensationPx, 2)}
                  unit="px"
                />
              </>
            ) : null}
            {measurement.perspectiveScale ? (
              <>
                <ValueRow label={t('video.roiWidth')} value={formatNumber(measurement.perspectiveScale.widthM, 3)} unit="m" />
                <ValueRow label={t('video.roiLength')} value={formatNumber(measurement.perspectiveScale.lengthM, 3)} unit="m" />
              </>
            ) : null}
          </Card>

          {measurement.videoUri ? (
            videoPresent === false ? (
              <Note tone="warning">{t('saved.videoMissing')}</Note>
            ) : (
              <>
                <Muted>{t('saved.videoPreview')}</Muted>
                <View style={styles.videoFrame}>
                  <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls contentFit="contain" />
                  {analysis ? <VectorOverlay analysis={analysis} fit="contain" /> : null}
                </View>
                {analysis ? <Muted>{t('video.vectorOverlayHint')}</Muted> : null}
              </>
            )
          ) : null}

          <Button
            label={t('video.retry')}
            hint={t('video.retryHint')}
            variant="secondary"
            disabled={!measurement.videoUri || videoPresent === false}
            onPress={() => {
              // The stored record is left untouched; the retry works on a new draft.
              startRetry(measurement);
              router.push('/video');
            }}
          />
        </>
      ) : null}

      {measurement.siteId && measurement.sensorSnapshot ? (
        <Button
          label={t('saved.siteReference.save')}
          hint={t('saved.siteReference.hint')}
          variant="secondary"
          onPress={saveAsSiteReference}
          busy={busy === 'site-reference'}
          disabled={busy !== null}
        />
      ) : null}

      {measurement.sensorSnapshot || analysis || measurement.cameraLevelEvidence ? (
        <>
          <SectionTitle>{t('saved.technicalData')}</SectionTitle>
          <Button
            label={showTechnical ? t('common.close') : t('saved.technicalData')}
            variant="secondary"
            onPress={() => setShowTechnical((current) => !current)}
          />
          {showTechnical ? (
            <Card>
              {measurement.sensorSnapshot ? (
                <>
              <ValueRow label={t('saved.technical.device')} value={measurement.sensorSnapshot.device.model ?? t('common.withheld')} withheld={!measurement.sensorSnapshot.device.model} />
              <ValueRow label={t('saved.technical.androidVersion')} value={measurement.sensorSnapshot.device.androidVersion ?? t('common.withheld')} withheld={!measurement.sensorSnapshot.device.androidVersion} />
              <ValueRow label={t('saved.technical.appVersion')} value={measurement.sensorSnapshot.device.appVersion} />

              <ValueRow
                label={t('saved.technical.cameraFacing')}
                value={measurement.sensorSnapshot.camera.facing ?? t('common.withheld')}
                withheld={!measurement.sensorSnapshot.camera.facing}
              />
              {measurement.sensorSnapshot.camera.sourceWidth ? (
                <ValueRow
                  label={t('saved.technical.resolution')}
                  value={`${measurement.sensorSnapshot.camera.sourceWidth}×${measurement.sensorSnapshot.camera.sourceHeight}`}
                />
              ) : null}
              {measurement.sensorSnapshot.camera.nominalFps !== undefined ? (
                <ValueRow label={t('saved.technical.nominalFps')} value={formatNumber(measurement.sensorSnapshot.camera.nominalFps, 2)} unit="fps" />
              ) : null}
              {measurement.sensorSnapshot.camera.actualFps !== undefined ? (
                <ValueRow label={t('saved.technical.actualFps')} value={formatNumber(measurement.sensorSnapshot.camera.actualFps, 2)} unit="fps" />
              ) : null}
              {measurement.sensorSnapshot.camera.zoom !== undefined ? (
                <ValueRow label={t('saved.technical.zoom')} value={formatNumber(measurement.sensorSnapshot.camera.zoom, 2)} />
              ) : null}

              <ValueRow
                label={t('video.cameraStability.deviceMotion')}
                value={classifyStability(
                  measurement.sensorSnapshot.motion.angularVelocityRmsDegPerSec,
                  measurement.sensorSnapshot.motion.accelerationRmsMps2
                )}
              />
              {measurement.sensorSnapshot.motion.angularVelocityRmsDegPerSec !== undefined ? (
                <ValueRow
                  label={t('video.cameraStability.angularMotion')}
                  value={formatNumber(measurement.sensorSnapshot.motion.angularVelocityRmsDegPerSec, 2)}
                  unit="°/s RMS"
                />
              ) : null}
              {measurement.sensorSnapshot.motion.pitchDeg !== undefined ? (
                <ValueRow label={t('video.cameraStability.pitch')} value={formatNumber(measurement.sensorSnapshot.motion.pitchDeg, 1)} unit="°" />
              ) : null}
              {measurement.sensorSnapshot.motion.rollDeg !== undefined ? (
                <ValueRow label={t('video.cameraStability.roll')} value={formatNumber(measurement.sensorSnapshot.motion.rollDeg, 1)} unit="°" />
              ) : null}

              {measurement.sensorSnapshot.imageQuality ? (
                <>
                  <ValueRow label={t('saved.technical.exposure')} value={gradeExposure(measurement.sensorSnapshot.imageQuality)} />
                  <ValueRow label={t('saved.technical.contrast')} value={gradeContrast(measurement.sensorSnapshot.imageQuality)} />
                  <ValueRow label={t('saved.technical.sharpness')} value={gradeSharpness(measurement.sensorSnapshot.imageQuality)} />
                  <ValueRow label={t('saved.technical.glare')} value={gradeGlare(measurement.sensorSnapshot.imageQuality)} />
                </>
              ) : null}
                </>
              ) : null}

              {analysis ? (
                <>
                  {measurement.sensorSnapshot?.camera.timingSource ? (
                    <ValueRow
                      label={t('saved.technical.timingSource')}
                      value={measurement.sensorSnapshot.camera.timingSource}
                    />
                  ) : null}
                  <ValueRow label={t('saved.technical.deltaT')} value={formatNumber(analysis.frameDeltaS, 4)} unit="s" />
                  <ValueRow
                    label={t('saved.technical.streamwiseVelocity')}
                    value={formatNumber(measurement.surfaceVelocity ?? null, 4)}
                    unit="m/s"
                  />
                  {analysis.lateralVelocity !== undefined ? (
                    <ValueRow
                      label={t('saved.technical.lateralVelocity')}
                      value={formatNumber(analysis.lateralVelocity, 4)}
                      unit="m/s"
                    />
                  ) : null}
                  {analysis.speedMagnitude !== undefined ? (
                    <ValueRow
                      label={t('saved.technical.speedMagnitude')}
                      value={formatNumber(analysis.speedMagnitude, 4)}
                      unit="m/s"
                    />
                  ) : null}
                  <ValueRow
                    label={t('saved.technical.crossFlowRatio')}
                    value={formatNumber(analysis.quality.crossFlowRatio, 3)}
                  />
                  <ValueRow
                    label={t('saved.technical.distinctAcceptedColumns')}
                    value={`${analysis.quality.distinctAcceptedColumns}/${analysis.thresholds.gridColumns}`}
                  />
                  <ValueRow
                    label={t('saved.technical.staticBackground')}
                    value={
                      Number.isFinite(analysis.quality.staticBackgroundCorrelation)
                        ? formatNumber(analysis.quality.staticBackgroundCorrelation, 3)
                        : '—'
                    }
                    detail={t(
                      analysis.quality.backgroundSuppressed
                        ? 'video.backgroundSuppressed'
                        : 'video.backgroundKept'
                    )}
                  />
                  <ValueRow
                    label={t('saved.technical.sceneBackground')}
                    value={
                      Number.isFinite(analysis.quality.sceneBackgroundCorrelation)
                        ? formatNumber(analysis.quality.sceneBackgroundCorrelation, 3)
                        : '—'
                    }
                  />
                  {analysis.quality.crossFlowRatio > analysis.quality.crossFlowWarningRatio &&
                  analysis.quality.distinctAcceptedColumns <= 1 ? (
                    <Note tone="warning">{t('video.crossFlowNarrowColumn')}</Note>
                  ) : null}
                  <ValueRow
                    label={t('saved.technical.ssivSnr')}
                    value={formatNumber(median(analysis.vectors.filter((v) => v.accepted).map((v) => v.snr)), 2)}
                  />
                  <ValueRow label={t('saved.technical.algorithmVersion')} value={analysis.algorithmVersion} />
                </>
              ) : null}

              {measurement.cameraLevelEvidence ? (
                <>
                  <SectionTitle>{t('saved.technical.cameraLevelTitle')}</SectionTitle>
                  {measurement.cameraLevelEvidence.sourceImageWidth !== undefined &&
                  measurement.cameraLevelEvidence.sourceImageHeight !== undefined ? (
                    <ValueRow
                      label={t('saved.technical.sourceImageSize')}
                      value={`${measurement.cameraLevelEvidence.sourceImageWidth}×${measurement.cameraLevelEvidence.sourceImageHeight}`}
                    />
                  ) : null}
                  <ValueRow
                    label={t('saved.technical.ellipseResidual')}
                    value={formatNumber(measurement.cameraLevelEvidence.fit.residual, 3)}
                    unit="px"
                  />
                  <ValueRow
                    label={t('saved.technical.ellipseInliers')}
                    value={`${measurement.cameraLevelEvidence.fit.inlierCount} / ${measurement.cameraLevelEvidence.fit.rejectedCount}`}
                  />
                  <ValueRow
                    label={t('saved.technical.axisRatio')}
                    value={formatNumber(measurement.cameraLevelEvidence.fit.axisRatio, 3)}
                  />
                  {measurement.cameraLevelEvidence.pitchDeg !== undefined ? (
                    <ValueRow
                      label={t('video.cameraStability.pitch')}
                      value={formatNumber(measurement.cameraLevelEvidence.pitchDeg, 1)}
                      unit="°"
                    />
                  ) : null}
                  {measurement.cameraLevelEvidence.rollDeg !== undefined ? (
                    <ValueRow
                      label={t('video.cameraStability.roll')}
                      value={formatNumber(measurement.cameraLevelEvidence.rollDeg, 1)}
                      unit="°"
                    />
                  ) : null}
                  <ValueRow
                    label={t('saved.technical.algorithmVersion')}
                    value={measurement.cameraLevelEvidence.algorithmVersion}
                  />
                </>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}

      <SectionTitle>{t('saved.rawEvidence')}</SectionTitle>
      <Button
        label={showRaw ? t('common.close') : t('saved.rawEvidence')}
        variant="secondary"
        onPress={() => setShowRaw((current) => !current)}
      />
      {showRaw ? (
        <View style={styles.rawBox}>
          <Text style={styles.raw}>{JSON.stringify(measurement.raw, null, 2)}</Text>
        </View>
      ) : null}

      <SectionTitle>{t('report.title')}</SectionTitle>
      <Button label={t('saved.exportPdf')} onPress={() => exportPdf(false)} busy={busy === 'pdf'} disabled={busy !== null} />
      <Button label={t('saved.sharePdf')} variant="secondary" onPress={() => exportPdf(true)} disabled={busy !== null} />
      <Button label={t('saved.exportCsv')} onPress={() => exportCsv(false)} busy={busy === 'csv'} disabled={busy !== null} />
      <Button label={t('saved.shareCsv')} variant="secondary" onPress={() => exportCsv(true)} disabled={busy !== null} />

      <SectionTitle>{t('common.delete')}</SectionTitle>
      <Note tone="warning">{t('saved.deleteWarning')}</Note>
      {confirmingDelete ? (
        <>
          <Button label={t('saved.deleteConfirm')} variant="danger" onPress={remove} busy={busy === 'delete'} />
          <Button label={t('common.cancel')} variant="secondary" onPress={() => setConfirmingDelete(false)} />
        </>
      ) : (
        <Button label={t('common.delete')} variant="danger" onPress={() => setConfirmingDelete(true)} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  id: { ...typography.mono, color: colors.accent, fontSize: 16 },
  videoFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  rawBox: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
    backgroundColor: colors.surface,
  },
  raw: { fontSize: 10, fontFamily: 'monospace', color: colors.textMuted },
});
