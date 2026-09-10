import { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { activeAlpha } from '../../domain/calibration';
import { classifyAccuracy } from '../../domain/gps';
import type { Site } from '../../domain/types';
import { formatNumber } from '../../domain/units';
import { captureGps } from '../../state/gps-capture';
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
import { colors, typography } from '../../ui/theme';

export default function SiteDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, repository, ready } = useSettings();
  const { startFromSite } = useMeasurement();

  const [site, setSite] = useState<Site | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!ready || !id) return;
    try {
      setSite(await repository.getSite(id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [ready, id, repository]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const captureLocation = async () => {
    if (!site || busy) return;
    setBusy(true);
    setGpsNote(null);
    try {
      const fix = await captureGps();
      if (!fix.ok) {
        setGpsNote(t(fix.reasonKey));
        return;
      }
      const updated: Site = { ...site, location: fix.location, updatedAt: new Date().toISOString() };
      await repository.saveSite(updated);
      setSite(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <Screen>
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      </Screen>
    );
  }
  if (!site) {
    return (
      <Screen>
        <Muted>{t('common.loading')}</Muted>
      </Screen>
    );
  }

  const alpha = activeAlpha(site.calibrationPoints);

  return (
    <Screen>
      <Text style={styles.name}>{site.name}</Text>
      <Muted>{site.id}</Muted>

      <SectionTitle>{t('sites.geometry')}</SectionTitle>
      <Card>
        <ValueRow label={t('report.geometryKind')} value={t(`measure.geometry.${site.draft.dimensions.kind}`)} />
        {site.draft.dimensions.kind === 'circular' ? (
          <ValueRow label="D" value={formatNumber(site.draft.dimensions.diameter, 4)} unit="m" />
        ) : null}
        {site.draft.dimensions.kind === 'rectangular' ? (
          <ValueRow label="B" value={formatNumber(site.draft.dimensions.width, 4)} unit="m" />
        ) : null}
        {site.draft.dimensions.kind === 'trapezoidal' ? (
          <ValueRow label="b" value={formatNumber(site.draft.dimensions.bottomWidth, 4)} unit="m" />
        ) : null}
        <Muted>{t('measure.depthHint')}</Muted>
      </Card>

      <SectionTitle>{t('calibration.activeAlpha')}</SectionTitle>
      <Card>
        <ValueRow
          label="α"
          value={formatNumber(alpha.alpha, 3)}
          provenance={alpha.status === 'calibrated' ? t('provenance.calibrated') : t('provenance.assumed')}
        />
        <Badge label={t(`alphaStatus.${alpha.status}`)} tone={alpha.status === 'calibrated' ? 'pass' : 'warning'} />
        <ValueRow label={t('sites.calibrationPoints')} value={String(site.calibrationPoints.length)} />
        <Button label={t('calibration.title')} variant="secondary" onPress={() => router.push(`/calibration?siteId=${site.id}`)} />
      </Card>

      <SectionTitle>{t('sites.location')}</SectionTitle>
      <Card>
        {site.location ? (
          <>
            <ValueRow label={t('report.latitude')} value={formatNumber(site.location.latitude, 6)} unit="°" />
            <ValueRow label={t('report.longitude')} value={formatNumber(site.location.longitude, 6)} unit="°" />
            <ValueRow
              label={t('gps.accuracy')}
              value={`${formatNumber(site.location.accuracy ?? null, 1)} m · ${t(
                `gps.class.${classifyAccuracy(site.location.accuracy)}`
              )}`}
            />
          </>
        ) : (
          <Muted>{t('common.none')}</Muted>
        )}
        {gpsNote ? <Note tone="warning">{gpsNote}</Note> : null}
        <Button label={t('sites.captureLocation')} variant="secondary" onPress={captureLocation} busy={busy} />
      </Card>

      <Button
        label={t('sites.openMeasurement')}
        onPress={() => {
          startFromSite(site);
          router.push('/measure?step=geometry');
        }}
      />
      <Button
        label={t('saved.title')}
        variant="secondary"
        onPress={() => router.push(`/saved?siteId=${site.id}`)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { ...typography.title, color: colors.text },
});
