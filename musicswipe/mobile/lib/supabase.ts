import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

import { secureStorage } from './secure-storage';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Настроено ли приложение. Без ключей не падаем, а показываем экран
 * с инструкцией — так проект можно склонировать и запустить,
 * не гадая, почему пустой экран.
 */
export const isConfigured =
  url.length > 0 &&
  anonKey.length > 0 &&
  !url.includes('ВАШ_') &&
  !anonKey.includes('ВАШ_');

export const supabase = createClient(
  isConfigured ? url : 'https://placeholder.supabase.co',
  isConfigured ? anonKey : 'placeholder',
  {
    auth: {
      storage: secureStorage,
      autoRefreshToken: true,
      persistSession: true,
      // В мобильном приложении нет адресной строки, из которой можно было бы
      // вытащить токен, — эта проверка только мешает.
      detectSessionInUrl: false,
    },
  },
);

// Пока приложение свёрнуто, обновлять токен незачем: таймер всё равно
// не отработает надёжно, а на возврате библиотека обновит его сама.
AppState.addEventListener('change', (state) => {
  if (!isConfigured) return;
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});

export interface ParsedError {
  message: string;
  code: string | null;
}

/**
 * Ошибки приходят в трёх форматах: PostgREST, GoTrue и наш собственный
 * `{ error: { code, message } }` из Edge Functions. Приводим к одному виду.
 *
 * Тело ответа читается через clone(): поток можно вычитать только раз,
 * а разбирать одну и ту же ошибку экраны могут не единожды.
 */
export async function parseError(error: unknown): Promise<ParsedError> {
  if (!error) return { message: 'Неизвестная ошибка', code: null };

  // FunctionsHttpError прячет ответ функции в context.
  const context = (error as { context?: Response }).context;
  if (context && typeof context.clone === 'function') {
    try {
      const body = await context.clone().json();
      if (body?.error?.message) {
        return { message: body.error.message, code: body.error.code ?? null };
      }
      if (body?.message) {
        return { message: body.message, code: body.code ?? null };
      }
    } catch {
      // тело не JSON — упадём на общий разбор ниже
    }
  }

  const message = (error as { message?: string }).message;
  const code = (error as { code?: string }).code ?? null;

  return { message: message ?? String(error), code };
}

/** Короткий вариант, когда код ошибки не нужен. */
export async function describeError(error: unknown): Promise<string> {
  return (await parseError(error)).message;
}
