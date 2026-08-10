import { LinearGradient } from 'expo-linear-gradient';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { theme } from '../lib/theme';
import { reasonText, type Track } from '../lib/types';
import { Artwork, GenreChip } from './ui';
import { PlaybackBar } from './PlaybackBar';

interface PlayerState {
  playing: boolean;
  loading: boolean;
  progress: number;
  toggle: () => void;
}

/** Карточка трека. */
export function SwipeCard({
  track,
  isTop,
  dragX,
  dragY,
  player,
}: {
  track: Track;
  isTop: boolean;
  dragX: Animated.Value;
  dragY: Animated.Value;
  player: PlayerState | null;
}) {
  // Штампы проявляются по мере перетаскивания — это единственная подсказка
  // о том, что произойдёт, если отпустить палец сейчас.
  const likeOpacity = dragX.interpolate({
    inputRange: [0, 110],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const passOpacity = dragX.interpolate({
    inputRange: [-110, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const superOpacity = dragY.interpolate({
    inputRange: [-140, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  const subtitle = [track.album_title, track.release_year].filter(Boolean).join(' · ');

  return (
    <View style={styles.card}>
      <Artwork uri={track.artwork_url} radius={theme.cardRadius} />

      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.88)']}
        locations={[0.35, 0.65, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {isTop ? (
        <>
          <Animated.View style={[styles.stamp, styles.stampLeft, { opacity: likeOpacity, borderColor: theme.like }]}>
            <Text style={[styles.stampText, { color: theme.like }]}>НРАВИТСЯ</Text>
          </Animated.View>

          <Animated.View style={[styles.stamp, styles.stampRight, { opacity: passOpacity, borderColor: theme.pass }]}>
            <Text style={[styles.stampText, { color: theme.pass }]}>МИМО</Text>
          </Animated.View>

          <Animated.View
            style={[styles.stamp, styles.stampTop, { opacity: superOpacity, borderColor: theme.superlike }]}
          >
            <Text style={[styles.stampText, { color: theme.superlike }]}>В ИЗБРАННОЕ</Text>
          </Animated.View>
        </>
      ) : null}

      <View style={styles.content}>
        {reasonText(track.reason) ? (
          <View style={styles.reason}>
            <Text style={styles.reasonText}>✦ {reasonText(track.reason)}</Text>
          </View>
        ) : null}

        <View style={{ gap: 6 }}>
          <Text style={styles.title} numberOfLines={2}>
            {track.title}
          </Text>

          <View style={styles.artistRow}>
            <Text style={styles.artist} numberOfLines={1}>
              {track.artist_name}
            </Text>
            {track.explicit ? (
              <View style={styles.explicit}>
                <Text style={styles.explicitText}>E</Text>
              </View>
            ) : null}
          </View>

          {subtitle.length > 0 ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {track.genres.length > 0 ? (
          <View style={styles.genres}>
            {track.genres.slice(0, 4).map((genre) => (
              <GenreChip key={genre} title={genre} />
            ))}
          </View>
        ) : null}

        <PlaybackBar
          hasPreview={Boolean(track.preview_url)}
          playing={player?.playing}
          loading={player?.loading}
          progress={player?.progress ?? 0}
          onToggle={player?.toggle}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: theme.cardRadius,
    overflow: 'hidden',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  content: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 22,
    gap: 14,
  },

  reason: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  reasonText: { color: '#fff', fontSize: 12, fontWeight: '500' },

  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  artistRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  artist: { color: 'rgba(255,255,255,0.85)', fontSize: 17, fontWeight: '600', flexShrink: 1 },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 14 },

  explicit: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  explicitText: { color: '#000', fontSize: 10, fontWeight: '800' },

  genres: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },

  stamp: {
    position: 'absolute',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 4,
  },
  stampLeft: { top: 28, left: 24, transform: [{ rotate: '-14deg' }] },
  stampRight: { top: 28, right: 24, transform: [{ rotate: '14deg' }] },
  stampTop: { top: 110, alignSelf: 'center' },
  stampText: { fontSize: 24, fontWeight: '900' },
});
