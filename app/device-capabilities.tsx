import { useEffect, useState } from 'react';

import { CAMERA_CAPABILITY_MATRIX } from '../domain/sensor-snapshot';
import { probeDeviceCapabilities, type DeviceCapabilities } from '../sensors/capabilities';
import { useSettings } from '../state/settings-context';
import { Card, KeyValue, Muted, Note, Screen, SectionTitle, ValueRow } from '../ui/components';

/**
 * Diagnostic-only screen (Settings → Engineering → Device Capabilities). It
 * never blocks a measurement — an unavailable optional sensor here is simply
 * reported, exactly as read from the platform (Phase 5/19).
 */
export default function DeviceCapabilitiesScreen() {
  const { t } = useSettings();
  const [capabilities, setCapabilities] = useState<DeviceCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    probeDeviceCapabilities()
      .then((result) => {
        if (!cancelled) setCapabilities(result);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = (available: boolean) => (available ? t('capabilities.available') : t('capabilities.unavailable'));

  return (
    <Screen>
      <SectionTitle>{t('capabilities.title')}</SectionTitle>
      <Muted>{t('capabilities.body')}</Muted>
      {error ? <Note tone="error">{error}</Note> : null}

      <SectionTitle>{t('capabilities.sensors')}</SectionTitle>
      {capabilities ? (
        <Card>
          <KeyValue label={t('capabilities.accelerometer')} value={label(capabilities.accelerometer)} />
          <KeyValue label={t('capabilities.gyroscope')} value={label(capabilities.gyroscope)} />
          <KeyValue label={t('capabilities.deviceMotion')} value={label(capabilities.deviceMotion)} />
          <KeyValue label={t('capabilities.magnetometer')} value={label(capabilities.magnetometer)} />
          <KeyValue label={t('capabilities.gps')} value={label(capabilities.gpsServicesEnabled)} />
          <KeyValue label={t('capabilities.barometer')} value={label(capabilities.barometer)} />
        </Card>
      ) : (
        <Muted>{t('common.loading')}</Muted>
      )}

      <SectionTitle>{t('capabilities.cameraMetadata')}</SectionTitle>
      <Card>
        {CAMERA_CAPABILITY_MATRIX.map((row) => (
          <ValueRow key={row.property} label={row.property} value={row.status} detail={row.note} />
        ))}
      </Card>

      <SectionTitle>{t('capabilities.depthAr')}</SectionTitle>
      <Note tone="neutral">{t('capabilities.depthArNote')}</Note>
      {capabilities ? (
        <Card>
          <KeyValue label={t('capabilities.arcore')} value={capabilities.arcoreSupported} />
          <KeyValue label={t('capabilities.depth')} value={capabilities.depthSupported} />
          <KeyValue label={t('capabilities.tof')} value={capabilities.tofAccessible} />
        </Card>
      ) : null}
    </Screen>
  );
}
