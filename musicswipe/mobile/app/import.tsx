import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { PlaylistProgress, TasteGenre } from '../lib/types';

const POLL_INTERVAL_MS = 2000;

export default function ImportScreen() {
  const router = useRouter();
  const { markImported, refresh } = useOnboarding();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const isOnboarding = from !== 'profile';

  const [url, setUrl] = useState('');
  const [starting, setStarting] = useState(false);
  const [progress, setProgress] = useState<PlaylistProgress | null>(null);
  const [taste, setTaste] = useState<TasteGenre[]>([]);
  const [error, setError] = useState<string | null>(null);

  const playlistId = useRef<string | null>(null);
  const platform = detectPlatform(url);

  const done = progress?.status === 'ready';
  const running = starting || progress?.status === 'importing' || progress?.status === 'pending';

  /**
   * Разбор идёт на сервере порциями, поэтому клиент опрашивает состояние.
   * Это честный прогресс: сколько треков реально прошло через каталог.
   */
  const poll = useCallback(async () => {
    const id = playlistId.current;
    if (!id) return;

    try {
      const next = await api.playlistProgress(id);
      if (!next) return;

      setProgress(next);

      if (next.status === 'ready') {
        setTaste(await api.tasteSummary().catch(() => []));
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else if (next.status === 'failed') {
        setError(next.error_message ?? 'Не удалось разобрать плейлист');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (cause) {
      setError(await describeError(cause));
    }
  }, []);

  useEffect(() => {
    if (!running || starting) return;
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [running, starting, poll]);

  async function startImport() {
    const link = url.trim();
    if (link.length === 0) return;

    setStarting(true);
    setError(null);
    setProgress(null);
    setTaste([]);

    try {
      const started = await api.importPlaylist(link);
      playlistId.current = started.playlist.id;

      setProgress({
        id: started.playlist.id,
        status: 'importing',
        platform: started.playlist.platform,
        title: started.playlist.title,
        cover_url: started.playlist.cover_url,
        track_count: started.playlist.track_count,
        analyzed_count: 0,
        matched_count: 0,
        error_message: null,
      });
    } catch (cause) {
      setError(await describeError(cause));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setStarting(false);
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

            {!isOnboarding && !running ? (
              <Pressable onPress={() => router.back()} hitSlop={10}>
                <Ionicons name="close" size={26} color={theme.textSecondary} />
              </Pressable>
            ) : null}
          </View>

          {progress ? (
            <ProgressCard
              progress={progress}
              taste={taste}
              done={done}
              onContinue={finish}
            />
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
                  loading={starting}
                  disabled={url.trim().length === 0}
                  onPress={startImport}
                />
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
    </Background>
  );
}

function ProgressCard({
  progress,
  taste,
  done,
  onContinue,
}: {
  progress: PlaylistProgress;
  taste: TasteGenre[];
  done: boolean;
  onContinue: () => void;
}) {
  const share = progress.track_count > 0
    ? Math.min(progress.analyzed_count / progress.track_count, 1)
    : 0;

  return (
    <Card style={{ padding: 20, gap: 18 }}>
      <View style={styles.resultHeader}>
        <Artwork uri={progress.cover_url} size={72} />
        <View style={styles.flex}>
          <Text style={styles.resultTitle} numberOfLines={2}>
            {progress.title ?? 'Ваш плейлист'}
          </Text>
          <Text style={styles.resultMeta}>
            {platformName(progress.platform)} · {progress.track_count} треков
          </Text>
        </View>
      </View>

      {done ? (
        <>
          <View style={{ gap: 8 }}>
            <Text style={styles.sectionTitle}>Что мы поняли о вашем вкусе</Text>
            {taste.length > 0 ? (
              <TasteBars values={taste} />
            ) : (
              <Text style={styles.note}>
                Жанры определить не удалось — лента соберётся по исполнителям.
              </Text>
            )}
          </View>

          <View style={styles.stats}>
            <Stat value={progress.analyzed_count} caption="проанализировано" />
            <Stat value={progress.matched_count} caption="распознано" />
          </View>

          <PrimaryButton title="Начать свайпать" icon="flame" onPress={onContinue} />
        </>
      ) : (
        <>
          <View style={{ gap: 10 }}>
            <View style={styles.progressRow}>
              <ActivityIndicator color={theme.accent} />
              <Text style={styles.progressText}>
                Разбираем треки: {progress.analyzed_count} из {progress.track_count}
              </Text>
            </View>

            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(share * 100)}%` }]} />
            </View>

            <Text style={styles.note}>
              Мы ищем каждый трек в музыкальном каталоге, чтобы узнать его жанр и год.
              Большой плейлист занимает пару минут — экран можно не держать открытым,
              разбор идёт на сервере.
            </Text>
          </View>

          {progress.analyzed_count > 0 ? (
            <SecondaryButton
              title="Перейти в ленту"
              icon="arrow-forward"
              onPress={onContinue}
              tint={theme.textSecondary}
            />
          ) : null}
        </>
      )}
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

  resultHeader: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  resultTitle: { color: theme.textPrimary, fontSize: 17, fontWeight: '700' },
  resultMeta: { color: theme.textSecondary, fontSize: 12, marginTop: 4 },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  progressText: { color: theme.textPrimary, fontSize: 15, fontWeight: '500' },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: theme.accent },

  stats: { flexDirection: 'row', gap: 28 },
  statValue: { color: theme.accent, fontSize: 22, fontWeight: '800' },
  statCaption: { color: theme.textSecondary, fontSize: 12 },
});
