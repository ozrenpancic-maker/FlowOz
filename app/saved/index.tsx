import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import type { SavedMeasurement } from '../../domain/measurement';
import type { Site } from '../../domain/types';
import { formatNumber } from '../../domain/units';
import { collectionFileName } from '../../reports/report-model';
import { toCsv } from '../../reports/csv';
import { saveTextWithSaf, shareFile, writeTempTextFile } from '../../reports/android-share';
import { useSettings } from '../../state/settings-context';
import {
  Badge,
  Button,
  Card,
  Choice,
  ErrorBlock,
  Muted,
  Note,
  Screen,
  SectionTitle,
  ValueRow,
} from '../../ui/components';
import { colors, gradeTone, spacing, typography } from '../../ui/theme';

export default function SavedMeasurementsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ siteId?: string }>();
  const { t, repository, ready, settings } = useSettings();

  const [measurements, setMeasurements] = useState<SavedMeasurement[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [siteFilter, setSiteFilter] = useState<string>(params.siteId ?? 'all');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const [all, siteList] = await Promise.all([
        repository.listMeasurements(),
        repository.listSites(),
      ]);
      setMeasurements(all);
      setSites(siteList);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [ready, repository]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const visible =
    siteFilter === 'all' ? measurements : measurements.filter((entry) => entry.siteId === siteFilter);

  const exportCollection = async () => {
    if (exporting || visible.length === 0) return;
    setExporting(true);
    setNote(null);
    setError(null);
    try {
      const csv = toCsv(visible, settings.csvFormat);
      const fileName = collectionFileName('csv', new Date().toISOString());
      const outcome = await saveTextWithSaf(fileName, csv);
      if (!outcome.ok) {
        // On a non-Android platform, or a SAF failure, fall back to the chooser.
        const temp = await writeTempTextFile(fileName, csv);
        if (temp) {
          const shared = await shareFile(temp, 'text/csv', t('saved.exportCollection'));
          setNote(shared.ok ? t('export.saved') : t(shared.error.messageKey));
        } else {
          setError(`${t(outcome.error.messageKey)} — ${outcome.error.detail}`);
        }
        return;
      }
      setNote('cancelled' in outcome ? t('export.cancelled') : t('export.saved'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Screen>
      <SectionTitle>{t('saved.filterBySite')}</SectionTitle>
      <Choice
        value={siteFilter}
        onChange={setSiteFilter}
        options={[
          { value: 'all', label: t('saved.allSites') },
          ...sites.map((site) => ({ value: site.id, label: site.name })),
        ]}
      />

      {error ? (
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      ) : null}
      {note ? <Note tone="pass">{note}</Note> : null}

      <Button
        label={t('saved.exportCollection')}
        variant="secondary"
        onPress={exportCollection}
        busy={exporting}
        disabled={exporting || visible.length === 0}
      />

      <SectionTitle>{t('saved.title')}</SectionTitle>
      {visible.length === 0 ? <Muted>{t('saved.empty')}</Muted> : null}
      {visible.map((measurement) => (
        <Card key={measurement.id}>
          <View style={styles.row}>
            <Text style={styles.id}>{measurement.displayId ?? measurement.id}</Text>
            <Badge label={measurement.confidence} tone={gradeTone(measurement.confidence)} />
          </View>
          <Muted>
            {measurement.createdAt} · {measurement.siteName ?? t('measure.oneOff')}
          </Muted>
          <ValueRow
            label={t('report.flowLs')}
            value={
              typeof measurement.flowM3s === 'number'
                ? formatNumber(measurement.flowM3s * 1000, 2)
                : t('common.withheld')
            }
            unit={typeof measurement.flowM3s === 'number' ? 'l/s' : undefined}
            withheld={typeof measurement.flowM3s !== 'number'}
          />
          <ValueRow
            label={t('report.method')}
            value={t(`measure.method.${measurement.method}`)}
            detail={measurement.processingStatus}
          />
          <Button
            label={t('common.continue')}
            variant="secondary"
            onPress={() => router.push(`/saved/${measurement.id}`)}
          />
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  id: { ...typography.mono, color: colors.accent },
});
