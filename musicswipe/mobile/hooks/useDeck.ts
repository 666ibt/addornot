import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '../lib/api';
import { parseError } from '../lib/supabase';
import type { SwipeDirection, Track } from '../lib/types';

const REFILL_THRESHOLD = 5;

/**
 * Состояние колоды: загрузка, свайпы и догрузка новых карточек.
 *
 * Свайп применяется к экрану сразу, а запрос уходит следом: листание не должно
 * ждать сеть. Если запрос не дошёл, сервер просто не узнает об оценке — колода
 * фильтруется по уже оценённым трекам на его стороне, так что худшее
 * последствие это повторный показ карточки.
 */
export function useDeck() {
  const [cards, setCards] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [refilling, setRefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Сервер больше ничего не подобрал — автодогрузку останавливаем. */
  const [exhausted, setExhausted] = useState(false);

  const busyRef = useRef(false);
  const startedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExhausted(false);

    try {
      let deck = await api.fetchDeck();

      // Пусто на старте — значит, очередь ещё не наполняли.
      if (deck.length === 0) {
        setRefilling(true);
        await api.refillDeck();
        deck = await api.fetchDeck();
      }

      setCards(deck);
      if (deck.length === 0) setExhausted(true);
    } catch (cause) {
      const { message, code } = await parseError(cause);
      setError(
        code === 'no_taste_profile'
          ? 'Сначала импортируйте плейлист — по нему собирается лента.'
          : message,
      );
      setExhausted(true);
    } finally {
      setRefilling(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void load();
  }, [load]);

  const refill = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefilling(true);

    try {
      await api.refillDeck();
      const fresh = await api.fetchDeck();

      let added = 0;
      setCards((current) => {
        // Пока грузили, пользователь мог свайпнуть ещё — склеиваем без дублей.
        const known = new Set(current.map((track) => track.id));
        const unseen = fresh.filter((track) => !known.has(track.id));
        added = unseen.length;
        return unseen.length > 0 ? [...current, ...unseen] : current;
      });

      // Ничего нового — дальше долбить сервер бессмысленно, ждём действия
      // пользователя.
      if (added === 0) setExhausted(true);
    } catch (cause) {
      setError((await parseError(cause)).message);
      setExhausted(true);
    } finally {
      busyRef.current = false;
      setRefilling(false);
    }
  }, []);

  useEffect(() => {
    if (loading || refilling || exhausted) return;
    if (cards.length > REFILL_THRESHOLD) return;
    void refill();
  }, [cards.length, loading, refilling, exhausted, refill]);

  const swipe = useCallback(
    (trackId: string, direction: SwipeDirection, listenedMs: number) => {
      // Запрос отправляем снаружи обновления состояния: React может вызвать
      // функцию-обновитель дважды, и свайп ушёл бы на сервер два раза.
      setCards((current) => current.filter((track) => track.id !== trackId));

      api.recordSwipe(trackId, direction, listenedMs).catch((cause) => {
        console.warn('Не удалось записать свайп', cause);
      });
    },
    [],
  );

  const reset = useCallback(() => load(), [load]);

  return { cards, loading, refilling, error, exhausted, swipe, reset };
}
