import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Кнопка воспроизведения и полоса прогресса превью.
 *
 * Верхняя карточка получает живые значения, нижние — статичную заглушку:
 * прогресс обновляется постоянно, и перерисовывать из-за него всю стопку
 * не нужно.
 */
export function PlaybackBar({
  hasPreview,
  playing = false,
  loading = false,
  progress = 0,
  onToggle,
}: {
  hasPreview: boolean;
  playing?: boolean;
  loading?: boolean;
  progress?: number;
  onToggle?: () => void;
}) {
  return (
    <View style={styles.container}>
      <Pressable
        onPress={onToggle}
        disabled={!hasPreview || !onToggle}
        style={[styles.button, !hasPreview && styles.dimmed]}
        hitSlop={8}
      >
        {loading ? (
          <ActivityIndicator size="small" color="#000" />
        ) : (
          <Ionicons name={playing ? 'pause' : 'play'} size={16} color="#000" />
        )}
      </Pressable>

      <View style={styles.right}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
        <Text style={styles.caption}>
          {hasPreview ? '30-секундный фрагмент' : 'Превью недоступно'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  button: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dimmed: { opacity: 0.4 },
  right: { flex: 1, gap: 5 },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  fill: { height: 4, borderRadius: 2, backgroundColor: '#fff' },
  caption: { color: 'rgba(255,255,255,0.55)', fontSize: 11 },
});
