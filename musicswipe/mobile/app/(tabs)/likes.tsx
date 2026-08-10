import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Artwork, Background, Card, EmptyState, ErrorBanner, Loader } from '../../components/ui';
import { usePreviewPlayer } from '../../hooks/usePreviewPlayer';
import * as api from '../../lib/api';
import { describeError } from '../../lib/supabase';
import { theme } from '../../lib/theme';
import { formatDuration, type LikedTrack } from '../../lib/types';

export default function Likes() {
  const insets = useSafeAreaInsets();

  const [tracks, setTracks] = useState<LikedTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);

  const playing = tracks.find((track) => track.id === playingId) ?? null;
  const player = usePreviewPlayer(playing?.preview_url ?? null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTracks(await api.likedTracks());
    } catch (cause) {
      setError(await describeError(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    (track: LikedTrack) => {
      if (!track.preview_url) return;
      if (playingId === track.id) {
        player.toggle();
      } else {
        setPlayingId(track.id);
      }
    },
    [playingId, player],
  );

  return (
    <Background>
      <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.title}>Любимое</Text>

        {loading && tracks.length === 0 ? (
          <Loader />
        ) : error && tracks.length === 0 ? (
          <View style={styles.padded}>
            <ErrorBanner message={error} onRetry={load} />
          </View>
        ) : tracks.length === 0 ? (
          <EmptyState
            icon="heart-outline"
            title="Пока пусто"
            message="Свайпайте карточки вправо — понравившиеся треки соберутся здесь."
          />
        ) : (
          <FlatList
            data={tracks}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.list}
            refreshing={loading}
            onRefresh={load}
            renderItem={({ item }) => (
              <Row
                track={item}
                playing={playingId === item.id && player.playing}
                onToggle={() => toggle(item)}
              />
            )}
          />
        )}
      </View>
    </Background>
  );
}

function Row({
  track,
  playing,
  onToggle,
}: {
  track: LikedTrack;
  playing: boolean;
  onToggle: () => void;
}) {
  const meta = [track.genres[0], formatDuration(track.duration_sec), track.release_year]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card style={styles.row}>
      <Pressable onPress={onToggle} style={styles.artwork}>
        <Artwork uri={track.artwork_url} size={58} radius={10} />
        {track.preview_url ? (
          <View style={styles.playOverlay}>
            <Ionicons name={playing ? 'pause' : 'play'} size={14} color="#fff" />
          </View>
        ) : null}
      </Pressable>

      <View style={styles.info}>
        <View style={styles.titleRow}>
          <Text style={styles.trackTitle} numberOfLines={1}>
            {track.title}
          </Text>
          {track.superliked ? <Ionicons name="star" size={12} color={theme.superlike} /> : null}
        </View>

        <Text style={styles.artist} numberOfLines={1}>
          {track.artist_name}
        </Text>

        {meta.length > 0 ? <Text style={styles.meta}>{meta}</Text> : null}
      </View>

      {track.external_url ? (
        <Pressable onPress={() => Linking.openURL(track.external_url!)} hitSlop={8}>
          <Ionicons name="open-outline" size={20} color={theme.textSecondary} />
        </Pressable>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: {
    color: theme.textPrimary,
    fontSize: 32,
    fontWeight: '800',
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  padded: { padding: 20 },
  list: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 10, borderRadius: 16 },
  artwork: { width: 58, height: 58 },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderRadius: 10,
  },

  info: { flex: 1, gap: 3 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  trackTitle: { color: theme.textPrimary, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  artist: { color: theme.textSecondary, fontSize: 12 },
  meta: { color: theme.textTertiary, fontSize: 11 },
});
