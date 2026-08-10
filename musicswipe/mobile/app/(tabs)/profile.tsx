import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Artwork,
  Background,
  Card,
  ErrorBanner,
  PrimaryButton,
  SecondaryButton,
  TasteBars,
} from '../../components/ui';
import * as api from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { platformName } from '../../lib/platforms';
import { describeError } from '../../lib/supabase';
import { theme } from '../../lib/theme';
import type { PlaylistSummary, TasteGenre } from '../../lib/types';

export default function Profile() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { session, signOut } = useAuth();

  const [taste, setTaste] = useState<TasteGenre[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [likesCount, setLikesCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Запросы независимы — ждём их вместе, а не по очереди.
      const [tasteRows, playlistRows, liked] = await Promise.all([
        api.tasteSummary(),
        api.playlists(),
        api.likedTracks(500),
      ]);
      setTaste(tasteRows);
      setPlaylists(playlistRows);
      setLikesCount(liked.length);
    } catch (cause) {
      setError(await describeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function rebuild() {
    setRebuilding(true);
    setError(null);
    try {
      await api.rebuildProfile();
      await load();
    } catch (cause) {
      setError(await describeError(cause));
    } finally {
      setRebuilding(false);
    }
  }

  function confirmSignOut() {
    const anonymous = session?.user.is_anonymous === true;
    Alert.alert(
      'Выйти из аккаунта?',
      anonymous
        ? 'Аккаунт гостевой — после выхода лайки и профиль восстановить не получится.'
        : undefined,
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Выйти', style: 'destructive', onPress: () => void signOut() },
      ],
    );
  }

  return (
    <Background>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 8 }]}
        refreshControl={undefined}
      >
        <Text style={styles.title}>Профиль</Text>

        <Card style={styles.accountCard}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={24} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.email} numberOfLines={1}>
              {session?.user.email ?? 'Гостевой аккаунт'}
            </Text>
            <Text style={styles.caption}>Лайков: {likesCount}</Text>
          </View>
        </Card>

        <Card style={styles.section}>
          <Text style={styles.sectionTitle}>Ваш вкус</Text>
          {loading && taste.length === 0 ? (
            <ActivityIndicator color={theme.accent} />
          ) : taste.length === 0 ? (
            <Text style={styles.caption}>
              Профиль соберётся после импорта плейлиста и первых свайпов.
            </Text>
          ) : (
            <TasteBars values={taste} />
          )}
        </Card>

        <Card style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Плейлисты</Text>
            <Pressable onPress={() => router.push('/import?from=profile')} hitSlop={8}>
              <Text style={styles.addButton}>+ Добавить</Text>
            </Pressable>
          </View>

          {playlists.length === 0 ? (
            <Text style={styles.caption}>
              Пока ни одного. Добавьте ссылку — лента станет точнее.
            </Text>
          ) : (
            playlists.map((playlist) => <PlaylistRow key={playlist.id} playlist={playlist} />)
          )}
        </Card>

        {error ? <ErrorBanner message={error} onRetry={() => setError(null)} /> : null}

        <View style={{ gap: 12 }}>
          <PrimaryButton
            title="Пересобрать вкусовой профиль"
            icon="refresh"
            loading={rebuilding}
            onPress={rebuild}
          />
          <Text style={styles.note}>
            Пересборка заново считает веса по плейлистам и лайкам и обновляет очередь
            рекомендаций.
          </Text>

          <SecondaryButton title="Выйти" tint={theme.pass} onPress={confirmSignOut} />
        </View>
      </ScrollView>
    </Background>
  );
}

function PlaylistRow({ playlist }: { playlist: PlaylistSummary }) {
  const status =
    playlist.status === 'ready'
      ? { icon: 'checkmark-circle' as const, color: theme.like }
      : playlist.status === 'failed'
        ? { icon: 'alert-circle' as const, color: theme.pass }
        : { icon: 'time' as const, color: theme.accent };

  return (
    <View style={styles.playlistRow}>
      <Artwork uri={playlist.cover_url} size={46} radius={8} />

      <View style={{ flex: 1 }}>
        <Text style={styles.playlistTitle} numberOfLines={1}>
          {playlist.title ?? `Плейлист ${platformName(playlist.platform)}`}
        </Text>
        <Text style={styles.playlistMeta} numberOfLines={1}>
          {platformName(playlist.platform)} · {playlist.matched_count} из {playlist.track_count}{' '}
          распознано
        </Text>
      </View>

      <Ionicons name={status.icon} size={20} color={status.color} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 20, paddingBottom: 40 },
  title: { color: theme.textPrimary, fontSize: 32, fontWeight: '800' },

  accountCard: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: theme.accentSecondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  email: { color: theme.textPrimary, fontSize: 16, fontWeight: '600' },
  caption: { color: theme.textSecondary, fontSize: 13, marginTop: 3, lineHeight: 18 },
  note: { color: theme.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 17 },

  section: { padding: 16, gap: 14 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: theme.textPrimary, fontSize: 16, fontWeight: '600' },
  addButton: { color: theme.accent, fontSize: 13, fontWeight: '600' },

  playlistRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playlistTitle: { color: theme.textPrimary, fontSize: 14, fontWeight: '500' },
  playlistMeta: { color: theme.textSecondary, fontSize: 11, marginTop: 2 },
});
