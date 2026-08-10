import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ConfigurationNeeded, Loader } from '../components/ui';
import { AuthProvider, useAuth } from '../lib/auth';
import { OnboardingProvider, useOnboarding } from '../lib/onboarding';
import { configProblem, isConfigured } from '../lib/supabase';
import { theme } from '../lib/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar style="light" />
        {isConfigured ? (
          <AuthProvider>
            <OnboardingProvider>
              <Navigation />
            </OnboardingProvider>
          </AuthProvider>
        ) : (
          <ConfigurationNeeded problem={configProblem} />
        )}
      </View>
    </SafeAreaProvider>
  );
}

/**
 * Развилка приложения: вход -> импорт плейлиста -> лента.
 *
 * Переходы делаются редиректами, а не подменой дерева экранов: так адресная
 * строка и кнопка «назад» остаются согласованными с тем, что видит человек.
 */
function Navigation() {
  const { session, loading } = useAuth();
  const { status } = useOnboarding();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const current = segments[0];

    if (!session) {
      if (current !== 'sign-in') router.replace('/sign-in');
      return;
    }

    // Ждём ответа на вопрос «есть ли плейлист» — иначе экран импорта
    // мигнёт перед лентой.
    if (status === 'checking') return;

    if (status === 'needs-playlist') {
      if (current !== 'import') router.replace('/import');
      return;
    }

    if (current !== '(tabs)' && current !== 'import') {
      router.replace('/(tabs)/discover');
    }
  }, [loading, session, status, segments, router]);

  if (loading || (session && status === 'checking')) {
    return <Loader />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.background },
        animation: 'fade',
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="import" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.background },
});
