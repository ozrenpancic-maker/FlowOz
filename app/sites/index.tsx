import { useCallback, useState } from 'react';
import { Text, StyleSheet } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { activeAlpha } from '../../domain/calibration';
import { createId } from '../../domain/ids';
import type { Site } from '../../domain/types';
import { DEFAULT_ALPHA } from '../../domain/types';
import { formatNumber } from '../../domain/units';
import { emptyDraft } from '../../state/measurement-context';
import { useSettings } from '../../state/settings-context';
import { Button, Card, ErrorBlock, Field, Muted, Screen, SectionTitle } from '../../ui/components';
import { colors, typography } from '../../ui/theme';

export default function SitesScreen() {
  const router = useRouter();
  const { t, repository, ready, settings } = useSettings();
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      setSites(await repository.listSites());
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

  const createSite = async () => {
    if (creating || name.trim() === '') return;
    setCreating(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const site: Site = {
        id: createId('site'),
        name: name.trim(),
        createdAt: now,
        updatedAt: now,
        draft: emptyDraft(settings.defaultAlpha),
        alpha: settings.defaultAlpha || DEFAULT_ALPHA,
        alphaStatus: 'default',
        calibrationPoints: [],
      };
      await repository.saveSite(site);
      setName('');
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Screen>
      <SectionTitle>{t('sites.new')}</SectionTitle>
      <Field label={t('sites.name')} keyboardType="default" value={name} onChangeText={setName} />
      <Button
        label={t('sites.saveSite')}
        onPress={createSite}
        busy={creating}
        disabled={creating || name.trim() === ''}
      />

      {error ? (
        <ErrorBlock title={t('common.error')} detail={error} detailLabel={t('common.technicalDetail')} />
      ) : null}

      <SectionTitle>{t('sites.title')}</SectionTitle>
      {sites.length === 0 ? <Muted>{t('sites.empty')}</Muted> : null}
      {sites.map((site) => {
        const alpha = activeAlpha(site.calibrationPoints);
        return (
          <Card key={site.id}>
            <Text style={styles.name}>{site.name}</Text>
            <Muted>
              {t('calibration.activeAlpha')}: {formatNumber(alpha.alpha, 3)} · {t(`alphaStatus.${alpha.status}`)}
            </Muted>
            <Muted>
              {t('sites.calibrationPoints')}: {site.calibrationPoints.length}
            </Muted>
            <Button label={t('common.continue')} variant="secondary" onPress={() => router.push(`/sites/${site.id}`)} />
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { ...typography.body, color: colors.text, fontWeight: '700' },
});
