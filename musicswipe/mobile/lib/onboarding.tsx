import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import * as api from './api';
import { useAuth } from './auth';

type Status = 'checking' | 'needs-playlist' | 'ready';

interface OnboardingValue {
  status: Status;
  /** Перепроверить состояние (после импорта из профиля). */
  refresh: () => Promise<void>;
  /** Импорт только что прошёл — пускаем в ленту, не дожидаясь запроса. */
  markImported: () => void;
}

const OnboardingContext = createContext<OnboardingValue | null>(null);

/**
 * Отвечает на один вопрос: есть ли у пользователя разобранный плейлист.
 * Пока ответа нет — держим 'checking', чтобы не мигать экраном импорта
 * перед тем, как показать ленту.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [status, setStatus] = useState<Status>('checking');

  const refresh = useCallback(async () => {
    if (!session) {
      setStatus('checking');
      return;
    }
    try {
      const list = await api.playlists();
      setStatus(list.some((playlist) => playlist.status === 'ready') ? 'ready' : 'needs-playlist');
    } catch {
      // Не смогли проверить — предлагаем импорт: он всё равно первый шаг.
      setStatus('needs-playlist');
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<OnboardingValue>(
    () => ({ status, refresh, markImported: () => setStatus('ready') }),
    [status, refresh],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding(): OnboardingValue {
  const value = useContext(OnboardingContext);
  if (!value) throw new Error('useOnboarding вызван вне OnboardingProvider');
  return value;
}
