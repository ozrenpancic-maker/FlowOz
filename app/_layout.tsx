import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MeasurementProvider } from '../state/measurement-context';
import { SettingsProvider, useSettings } from '../state/settings-context';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { colors } from '../ui/theme';

function Routes() {
  const { t, settings } = useSettings();

  return (
    <MeasurementProvider defaultAlpha={settings.defaultAlpha}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.text,
          headerTitleStyle: { fontSize: 15, fontWeight: '700' },
          contentStyle: { backgroundColor: colors.background },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="measure" options={{ title: t('home.newMeasurement') }} />
        <Stack.Screen name="video" options={{ title: t('video.title') }} />
        <Stack.Screen name="level-camera" options={{ title: t('level.camera.title') }} />
        <Stack.Screen name="sites/index" options={{ title: t('sites.title') }} />
        <Stack.Screen name="sites/[id]" options={{ title: t('sites.title') }} />
        <Stack.Screen name="saved/index" options={{ title: t('saved.title') }} />
        <Stack.Screen name="saved/[id]" options={{ title: t('saved.title') }} />
        <Stack.Screen name="calibration" options={{ title: t('calibration.title') }} />
        <Stack.Screen name="validation" options={{ title: t('validation.title') }} />
        <Stack.Screen name="settings" options={{ title: t('settings.title') }} />
        <Stack.Screen name="live-flow" options={{ title: t('live.title') }} />
      </Stack>
    </MeasurementProvider>
  );
}

function BoundaryWithStrings() {
  const { t } = useSettings();
  return (
    <ErrorBoundary
      title={t('error.boundary.title')}
      body={t('error.boundary.body')}
      reloadLabel={t('error.boundary.reload')}
      detailLabel={t('common.technicalDetail')}
    >
      <Routes />
    </ErrorBoundary>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SettingsProvider>
        <BoundaryWithStrings />
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
