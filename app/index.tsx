import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import type { SavedMeasurement } from '../domain/measurement';
import { formatNumber } from '../domain/units';
import { toLitresPerSecond } from '../domain/hydraulics';
import { useMeasurement } from '../state/measurement-context';
import { useSettings } from '../state/settings-context';
import { Badge, Button, Card, ErrorBlock, Muted, Screen, SectionTitle, ValueRow } from '../ui/components';
import { colors, gradeTone, spacing, typography } from '../ui/theme';

export default function HomeScreen() {
  const router = useRouter();
  const { t, repository, ready, storageError, settings } = useSettings();
  const { reset } = useMeasurement();
  const [recent, setRecent] = useState<SavedMeasurement[]>([]);
  const [listError, setListError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      if (!ready || storageError) return;

      (async () => {
        try {
          const measurements = await repository.listMeasurements();
          if (!cancelled) {
            setRecent(measurements.slice(0, 5));
            setListError(null);
          }
        } catch (error) {
          if (!cancelled) setListError(error instanceof Error ? error.message : String(error));
        }
      })();

      return () => {
        cancelled = true;
      };
    }, [ready, storageError, repository])
  );

  const startMeasurement = () => {
    reset(settings.defaultAlpha);
    router.push('/measure');
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.wordmark}>FLOWVISION</Text>
        <Badge label={t('app.offline')} tone="pass" />
      </View>
      <Muted>{t('app.tagline')}</Muted>

      {storageError ? (
        <ErrorBlock
          title={t('common.error')}
          action={t('settings.storage')}
          detail={storageError}
          detailLabel={t('common.technicalDetail')}
        />
      ) : null}

      <Button label={t('home.newMeasurement')} hint={t('home.newMeasurementHint')} onPress={startMeasurement} />

      {/* The two screens a field day actually goes through, kept beside the
          measurement button. The rest are occasional and sit below the recent
          list, so the top of the screen carries only what gets used. */}
      <View style={styles.grid}>
        <View style={styles.gridItem}>
          <Button label={t('home.sites')} variant="secondary" onPress={() => router.push('/sites')} />
        </View>
        <View style={styles.gridItem}>
          <Button label={t('home.saved')} variant="secondary" onPress={() => router.push('/saved')} />
        </View>
      </View>

      <SectionTitle>{t('home.recent')}</SectionTitle>
      {listError ? (
        <ErrorBlock title={t('common.error')} detail={listError} detailLabel={t('common.technicalDetail')} />
      ) : null}
      {recent.length === 0 && !listError ? <Muted>{t('home.noRecent')}</Muted> : null}
      {recent.map((measurement) => (
        <Card key={measurement.id}>
          <View style={styles.recentHeader}>
            <Text style={styles.recentId}>{measurement.displayId ?? measurement.id}</Text>
            <Badge
              label={measurement.dataQuality.overall.grade}
              tone={gradeTone(measurement.dataQuality.overall.grade)}
            />
          </View>
          <ValueRow
            label={t('report.flowLs')}
            value={
              typeof measurement.flowM3s === 'number'
                ? formatNumber(toLitresPerSecond(measurement.flowM3s), 2)
                : t('common.withheld')
            }
            unit={typeof measurement.flowM3s === 'number' ? 'l/s' : undefined}
            withheld={typeof measurement.flowM3s !== 'number'}
            detail={`${measurement.method} · ${measurement.processingStatus}`}
          />
          <Button
            label={t('common.continue')}
            variant="secondary"
            onPress={() => router.push(`/saved/${measurement.id}`)}
          />
        </Card>
      ))}

      <SectionTitle>{t('home.tools')}</SectionTitle>
      <View style={styles.grid}>
        <View style={styles.gridItem}>
          <Button label={t('home.calibration')} variant="secondary" onPress={() => router.push('/calibration')} />
        </View>
        <View style={styles.gridItem}>
          <Button label={t('home.validation')} variant="secondary" onPress={() => router.push('/validation')} />
        </View>
        <View style={styles.gridItem}>
          <Button label={t('home.settings')} variant="secondary" onPress={() => router.push('/settings')} />
        </View>
        <View style={styles.gridItem}>
          <Button label={t('home.liveFlow')} variant="secondary" onPress={() => router.push('/live-flow')} />
        </View>
      </View>
      <Badge label={t('live.badge')} tone="experimental" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.lg },
  wordmark: { ...typography.wordmark, color: colors.text },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  gridItem: { flexGrow: 1, flexBasis: '46%' },
  recentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  recentId: { ...typography.mono, color: colors.accent },
});
