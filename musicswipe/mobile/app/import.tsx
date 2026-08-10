import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  Artwork,
  Background,
  Card,
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
  TasteBars,
} from '../components/ui';
import * as api from '../lib/api';
import { useOnboarding } from '../lib/onboarding';
import { detectPlatform, PLATFORMS, platformName } from '../lib/platforms';
import { describeError } from '../lib/supabase';
import { theme } from '../lib/theme';
import type { ImportPlaylistResult } from '../lib/types';

/**
 * Импорт идёт одним запросом и занимает десятки секунд. Прогресс-бар был бы
 * обманом, поэтому показываем, чем сервер занят прямо сейчас — по таймингам,
 * которые повторяют шаги Edge Function.
 */
const STAGES = [
  'Открываем плейлист…',
  'Читаем список треков…',
  'Ищем треки в музыкальном каталоге…',
  'Определяем жанры и годы…',
  'Собираем ваш вкусовой профиль…',
  'Подбираем первые рекомендации…',
];

export default function ImportScreen() {
  const router = useRouter();
  const { markImported, refresh } = useOnboarding();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const isOnboarding = from !== 'profile';

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(STAGES[0]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportPlaylistResult | null>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const platform = detectPlatform(url);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  function startStages() {
    timers.current.forEach(clearTimeout);
    timers.current = STAGES.slice(1).map((text, index) =>
      setTimeout(() => setStage(text), (index + 1) * 6000),
    );
    setStage(STAGES[0]);
  }

  async function runImport() {
    const link = url.trim();
    if (link.length === 0) return;

    setBusy(true);
    setError(null);
    setResult(null);
    startStages();

    try {
      const imported = await api.importPlaylist(link);
      setResult(imported);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (cause) {
      setError(await describeError(cause));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      timers.current.forEach(clearTimeout);
      setBusy(false);
    }
  }

  async function finish() {
    markImported();
    await refresh();
    router.replace('/(tabs)/discover');
  }

  return (
    <Background>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.headerRow}>
            <View style={styles.flex}>
              <Text style={styles.title}>
                {isOnboarding ? 'С чего начнём' : 'Добавить плейлист'}
              </Text>
              <Text style={styles.subtitle}>
                Пришлите ссылку на плейлист с любой платформы. Мы разберём его, поймём ваш
                вкус и соберём ленту из треков, которых там ещё нет.
              </Text>
            </View>

            {!isOnboarding ? (
              <Pressable onPress={() => router.back()} hitSlop={10}>
                <Ionicons name="close" size={26} color={theme.textSecondary} />
              </Pressable>
            ) : null}
          </View>

          {result ? (
            <ResultCard result={result} onContinue={finish} />
          ) : (
            <>
              <View style={{ gap: 14 }}>
                <View style={styles.field}>
                  <Ionicons
                    name={platform ? 'checkmark-circle' : 'link'}
                    size={20}
                    color={platform ? theme.like : theme.textTertiary}
                  />
                  <TextInput
                    value={url}
                    onChangeText={setUrl}
                    placeholder="https://open.spotify.com/playlist/…"
                    placeholderTextColor={theme.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    multiline
                    style={styles.input}
                  />
                  {url.length > 0 ? (
                    <Pressable onPress={() => setUrl('')} hitSlop={8}>
                      <Ionicons name="close-circle" size={20} color={theme.textTertiary} />
                    </Pressable>
                  ) : null}
                </View>

                {platform ? (
                  <Text style={styles.detected}>
                    Определили платформу: {platformName(platform)}
                  </Text>
                ) : null}

                <SecondaryButton
                  title="Вставить"
                  icon="clipboard-outline"
                  onPress={async () => {
                    const text = (await Clipboard.getStringAsync()).trim();
                    if (text.length > 0) setUrl(text);
                  }}
                />

                <PrimaryButton
                  title="Анализировать плейлист"
                  icon="sparkles"
                  loading={busy}
                  disabled={url.trim().length === 0}
                  onPress={runImport}
                />

                <Text style={styles.note}>
                  Разбор большого плейлиста занимает до минуты — мы обращаемся к музыкальным
                  каталогам и подбираем первые тридцать карточек.
                </Text>
              </View>

              <View style={{ gap: 12 }}>
                <Text style={styles.sectionTitle}>Поддерживаемые сервисы</Text>
                <View style={styles.platforms}>
                  {PLATFORMS.map((item) => (
                    <Card key={item.id} style={styles.platformCard}>
                      <Ionicons name={item.icon} size={16} color={theme.textSecondary} />
                      <Text style={styles.platformName}>{item.name}</Text>
                    </Card>
                  ))}
                </View>
              </View>
            </>
          )}

          {error ? <ErrorBanner message={error} onRetry={() => setError(null)} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {busy ? (
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <ActivityIndicator size="large" color={theme.accent} />
            <Text style={styles.overlayText}>{stage}</Text>
          </View>
        </View>
      ) : null}
    </Background>
  );
}

function ResultCard({
  result,
  onContinue,
}: {
  result: ImportPlaylistResult;
  onContinue: () => void;
}) {
  return (
    <Card style={{ padding: 20, gap: 18 }}>
      <View style={styles.resultHeader}>
        <Artwork uri={result.playlist.cover_url} size={72} />
        <View style={styles.flex}>
          <Text style={styles.resultTitle} numberOfLines={2}>
            {result.playlist.title ?? 'Ваш плейлист'}
          </Text>
          <Text style={styles.resultMeta}>
            {platformName(result.playlist.platform)} · {result.playlist.track_count} треков
          </Text>
        </View>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={styles.sectionTitle}>Что мы поняли о вашем вкусе</Text>
        {result.taste.top_genres.length > 0 ? (
          <TasteBars values={result.taste.top_genres} />
        ) : (
          <Text style={styles.note}>
            Жанры определить не удалось — лента соберётся по исполнителям.
          </Text>
        )}
        {result.taste.avg_year ? (
          <Text style={styles.note}>
            Средний год выпуска: {Math.round(result.taste.avg_year)}
          </Text>
        ) : null}
      </View>

      <View style={styles.stats}>
        <Stat value={result.playlist.matched_count} caption="распознано" />
        <Stat value={result.deck_prepared} caption="карточек готово" />
      </View>

      <PrimaryButton title="Начать свайпать" icon="flame" onPress={onContinue} />
    </Card>
  );
}

function Stat({ value, caption }: { value: number; caption: string }) {
  return (
    <View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statCaption}>{caption}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 24, paddingTop: 64, gap: 24 },

  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title: { color: theme.textPrimary, fontSize: 32, fontWeight: '800', marginBottom: 10 },
  subtitle: { color: theme.textSecondary, fontSize: 15, lineHeight: 21 },
  sectionTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: '600' },
  note: { color: theme.textTertiary, fontSize: 12, lineHeight: 17 },

  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    borderRadius: theme.radius,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  input: { flex: 1, color: theme.textPrimary, fontSize: 15, maxHeight: 80 },
  detected: { color: theme.like, fontSize: 12 },

  platforms: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  platformCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    minWidth: '46%',
    flexGrow: 1,
  },
  platformName: { color: theme.textSecondary, fontSize: 14 },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 40,
  },
  overlayCard: {
    padding: 28,
    borderRadius: 20,
    backgroundColor: theme.surface,
    alignItems: 'center',
    gap: 18,
  },
  overlayText: { color: theme.textPrimary, fontSize: 15, textAlign: 'center' },

  resultHeader: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  resultTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: '700' },
  resultMeta: { color: theme.textSecondary, fontSize: 12, marginTop: 4 },

  stats: { flexDirection: 'row', gap: 28 },
  statValue: { color: theme.accent, fontSize: 22, fontWeight: '800' },
  statCaption: { color: theme.textSecondary, fontSize: 12 },
});
