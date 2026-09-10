import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { SSIV_THRESHOLDS } from '../video/types';
import { ALGORITHM_VERSION } from '../domain/types';
import { useSettings } from '../state/settings-context';
import { Badge, Card, KeyValue, Muted, Note, Screen, SectionTitle, ValueRow } from '../ui/components';

/**
 * Validation status.
 *
 * This screen exists to state what has *not* been validated. It must never
 * imply a validation that has not been carried out, so it reports only what is
 * on the device: how many measurements exist and which thresholds the algorithm
 * ran with.
 */
export default function ValidationScreen() {
  const { t, repository, ready } = useSettings();
  const [counts, setCounts] = useState<{ total: number; video: number; processed: number } | null>(null);

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const measurements = await repository.listMeasurements();
      setCounts({
        total: measurements.length,
        video: measurements.filter((entry) => entry.method === 'video').length,
        processed: measurements.filter((entry) => entry.processingStatus === 'PROCESSED').length,
      });
    } catch {
      setCounts(null);
    }
  }, [ready, repository]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  return (
    <Screen>
      <Badge label={t('validation.notValidated')} tone="error" />
      <SectionTitle>{t('validation.title')}</SectionTitle>
      <Note tone="warning">{t('validation.body')}</Note>
      <Note tone="warning">{t('validation.uncertaintyBody')}</Note>
      <Note tone="warning">{t('validation.fieldGate')}</Note>

      <SectionTitle>{t('validation.evidence')}</SectionTitle>
      {counts === null ? (
        <Muted>{t('validation.noEvidence')}</Muted>
      ) : (
        <Card>
          <ValueRow label={t('saved.title')} value={String(counts.total)} />
          <ValueRow label={t('measure.method.video')} value={String(counts.video)} />
          <ValueRow label="PROCESSED" value={String(counts.processed)} />
          <Muted>{t('validation.noEvidence')}</Muted>
        </Card>
      )}

      <SectionTitle>{t('report.algorithmVersion')}</SectionTitle>
      <Card>
        <KeyValue label={t('report.algorithmVersion')} value={ALGORITHM_VERSION} />
        <KeyValue label="min correlation" value={String(SSIV_THRESHOLDS.minCorrelation)} />
        <KeyValue label="min peak ratio" value={String(SSIV_THRESHOLDS.minPeakRatio)} />
        <KeyValue label="max uncertainty" value={`${SSIV_THRESHOLDS.maxUncertaintyPx} px`} />
        <KeyValue label="max forward/backward" value={`${SSIV_THRESHOLDS.maxForwardBackwardPx} px`} />
        <KeyValue label="min spatial coherence" value={String(SSIV_THRESHOLDS.minSpatialCoherence)} />
        <KeyValue label="min accepted vectors" value={String(SSIV_THRESHOLDS.minAcceptedVectors)} />
        <KeyValue label="min stabilisation correlation" value={String(SSIV_THRESHOLDS.minStabilisationCorrelation)} />
        <KeyValue
          label="min stable pairs"
          value={`${SSIV_THRESHOLDS.minStablePairs} / ${SSIV_THRESHOLDS.framePairs}`}
        />
        <KeyValue
          label="interrogation grid"
          value={`${SSIV_THRESHOLDS.gridColumns} × ${SSIV_THRESHOLDS.gridRows}`}
        />
        <KeyValue label="processing width" value={`${SSIV_THRESHOLDS.processingWidthPx} px`} />
        <KeyValue
          label="frame delta"
          value={`${SSIV_THRESHOLDS.minFrameDeltaS}–${SSIV_THRESHOLDS.maxFrameDeltaS} s`}
        />
      </Card>
    </Screen>
  );
}
