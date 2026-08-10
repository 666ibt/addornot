import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Проигрыватель 30-секундного превью для текущей карточки.
 *
 * Превью короткое, поэтому крутим его по кругу: пользователь успевает
 * распробовать трек, пока думает над свайпом.
 *
 * Отдельно считается фактическое время звучания — оно уходит вместе со
 * свайпом: «пролистал через две секунды» и «дослушал» это разные сигналы.
 */
export function usePreviewPlayer(uri: string | null) {
  const player = useAudioPlayer(uri ? { uri } : null);
  const status = useAudioPlayerStatus(player);

  const listenedRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  // .playback-режим: превью должно звучать и при включённом беззвучном.
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false }).catch(() => {
      // Без звука приложение всё ещё работоспособно — просто молчит.
    });
  }, []);

  useEffect(() => {
    player.loop = true;
  }, [player]);

  // Новая карточка — новый отсчёт и автозапуск.
  useEffect(() => {
    listenedRef.current = 0;
    startedAtRef.current = null;
    if (uri) {
      player.play();
    }
  }, [uri, player]);

  useEffect(() => {
    if (status.playing) {
      startedAtRef.current ??= Date.now();
    } else if (startedAtRef.current !== null) {
      listenedRef.current += Date.now() - startedAtRef.current;
      startedAtRef.current = null;
    }
  }, [status.playing]);

  // Свернули приложение — звук замолкает.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') player.pause();
    });
    return () => subscription.remove();
  }, [player]);

  const toggle = useCallback(() => {
    if (status.playing) {
      player.pause();
    } else {
      player.play();
    }
  }, [player, status.playing]);

  const pause = useCallback(() => player.pause(), [player]);

  /** Сколько миллисекунд трек звучал к этому моменту. */
  const listenedMs = useCallback(() => {
    const pending = startedAtRef.current === null ? 0 : Date.now() - startedAtRef.current;
    return listenedRef.current + pending;
  }, []);

  const duration = status.duration ?? 0;
  const progress = duration > 0 ? Math.min(Math.max(status.currentTime / duration, 0), 1) : 0;

  return {
    playing: status.playing,
    loading: !status.isLoaded && uri !== null,
    progress,
    toggle,
    pause,
    listenedMs,
  };
}
