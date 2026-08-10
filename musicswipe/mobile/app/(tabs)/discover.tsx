import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef } from 'react';
import { ActivityIndicator, Animated, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SwipeCard } from '../../components/SwipeCard';
import { Background, EmptyState, ErrorBanner, Loader } from '../../components/ui';
import { useDeck } from '../../hooks/useDeck';
import { usePreviewPlayer } from '../../hooks/usePreviewPlayer';
import { theme } from '../../lib/theme';
import type { SwipeDirection } from '../../lib/types';

const SWIPE_THRESHOLD = 120;
const SUPERLIKE_THRESHOLD = 150;
const FLY_DURATION = 280;

export default function Discover() {
  const insets = useSafeAreaInsets();
  const { cards, loading, refilling, error, swipe, reset } = useDeck();

  const top = cards[0] ?? null;
  const player = usePreviewPlayer(top?.preview_url ?? null);

  const pan = useRef(new Animated.ValueXY()).current;
  const committing = useRef(false);

  const commit = useCallback(
    (direction: SwipeDirection) => {
      if (!top || committing.current) return;

      committing.current = true;
      void Haptics.impactAsync(
        direction === 'superlike'
          ? Haptics.ImpactFeedbackStyle.Heavy
          : Haptics.ImpactFeedbackStyle.Medium,
      );

      const listened = player.listenedMs();
      const target =
        direction === 'like'
          ? { x: 620, y: -60 }
          : direction === 'pass'
            ? { x: -620, y: -60 }
            : { x: 0, y: -900 };

      Animated.timing(pan, {
        toValue: target,
        duration: FLY_DURATION,
        useNativeDriver: false,
      }).start(() => {
        // Сбрасываем смещение и убираем карточку в одном такте, иначе
        // следующая карточка «прилетит» из-за края экрана.
        pan.setValue({ x: 0, y: 0 });
        swipe(top.id, direction, listened);
        committing.current = false;
      });
    },
    [top, player, pan, swipe],
  );

  // PanResponder создаётся один раз, поэтому актуальный обработчик держим
  // в ref — иначе жест замкнёт на себе первую карточку навсегда.
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) =>
        Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6,

      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], {
        useNativeDriver: false,
      }),

      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy < -SUPERLIKE_THRESHOLD && Math.abs(gesture.dx) < SWIPE_THRESHOLD) {
          commitRef.current('superlike');
        } else if (gesture.dx > SWIPE_THRESHOLD) {
          commitRef.current('like');
        } else if (gesture.dx < -SWIPE_THRESHOLD) {
          commitRef.current('pass');
        } else {
          Animated.spring(pan, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
            friction: 6,
          }).start();
        }
      },
    }),
  ).current;

  const rotate = pan.x.interpolate({
    inputRange: [-320, 0, 320],
    outputRange: ['-16deg', '0deg', '16deg'],
    extrapolate: 'clamp',
  });

  return (
    <Background>
      <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Лента</Text>
            <Text style={styles.subtitle}>
              {cards.length === 0 ? 'Подбираем треки' : `Осталось карточек: ${cards.length}`}
            </Text>
          </View>
          {refilling ? <ActivityIndicator color={theme.accent} /> : null}
        </View>

        <View style={styles.deck}>
          {loading && cards.length === 0 ? (
            <Loader label={refilling ? 'Собираем рекомендации…' : 'Загружаем ленту…'} />
          ) : error && cards.length === 0 ? (
            <View style={styles.centered}>
              <ErrorBanner message={error} onRetry={reset} />
            </View>
          ) : cards.length === 0 ? (
            <EmptyState
              icon="sparkles"
              title="Карточки закончились"
              message="Мы подберём новую порцию по вашим последним свайпам."
              actionTitle="Подобрать ещё"
              onAction={reset}
            />
          ) : (
            cards
              .slice(0, 3)
              .map((track, index) => {
                const isTop = index === 0;

                return (
                  <Animated.View
                    key={track.id}
                    style={[
                      styles.cardWrapper,
                      isTop
                        ? {
                            transform: [
                              { translateX: pan.x },
                              { translateY: pan.y },
                              { rotate },
                            ],
                          }
                        : {
                            transform: [
                              { scale: 1 - index * 0.04 },
                              { translateY: index * 12 },
                            ],
                          },
                    ]}
                    {...(isTop ? responder.panHandlers : {})}
                  >
                    <SwipeCard
                      track={track}
                      isTop={isTop}
                      dragX={pan.x}
                      dragY={pan.y}
                      player={isTop ? player : null}
                    />
                  </Animated.View>
                );
              })
              // Первая карточка должна оказаться сверху стопки.
              .reverse()
          )}
        </View>

        <View style={styles.actions}>
          <CircleButton icon="close" color={theme.pass} size={60} onPress={() => commit('pass')} />
          <CircleButton icon="star" color={theme.superlike} size={50} onPress={() => commit('superlike')} />
          <CircleButton icon="heart" color={theme.like} size={60} onPress={() => commit('like')} />
        </View>
      </View>
    </Background>
  );
}

function CircleButton({
  icon,
  color,
  size,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  size: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: `${color}80`,
          opacity: pressed ? 0.6 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={size * 0.4} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 20 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  title: { color: theme.textPrimary, fontSize: 32, fontWeight: '800' },
  subtitle: { color: theme.textSecondary, fontSize: 12, marginTop: 2 },

  deck: { flex: 1, justifyContent: 'center' },
  centered: { flex: 1, justifyContent: 'center' },
  cardWrapper: { ...StyleSheet.absoluteFillObject },

  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 26,
    paddingVertical: 18,
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1.5,
  },
});
