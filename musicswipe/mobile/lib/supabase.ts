import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { AppState } from 'react-native';

import { secureStorage } from './secure-storage';

/**
 * Настройки берём из манифеста (`extra`, заполняется в app.config.js),
 * а `process.env` оставляем запасным вариантом.
 *
 * Манифест приезжает при каждом запуске дев-сервера, тогда как значения
 * `process.env.EXPO_PUBLIC_*` вшиваются в бандл и залипают в кэше Metro.
 */
const extra = (Constants.expoConfig?.extra ?? {}) as {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
};

const url = (extra.supabaseUrl || process.env.EXPO_PUBLIC_SUPABASE_URL || '').trim();
const anonKey = (extra.supabaseAnonKey || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '').trim();

/**
 * Что именно не так с настройками, если не так.
 *
 * Без ключей приложение не падает, а показывает экран с инструкцией. Экран
 * называет конкретную причину: «переменные не подставились» и «в них остались
 * заглушки» лечатся по-разному, а внешне выглядят одинаково.
 *
 * Значение ключа наружу не выводим — только факт его наличия.
 */
function detectConfigProblem(): string | null {
  if (url.length === 0 && anonKey.length === 0) {
    return 'Ни одна переменная не подставилась — файл .env не найден, пуст или лежит не в папке mobile.';
  }
  if (url.length === 0) {
    return 'Не задана EXPO_PUBLIC_SUPABASE_URL.';
  }
  if (anonKey.length === 0) {
    return 'Не задана EXPO_PUBLIC_SUPABASE_ANON_KEY.';
  }
  if (url.includes('ВАШ_') || anonKey.includes('ВАШ_')) {
    return 'В .env остались значения-заглушки из .env.example — их нужно заменить на свои.';
  }
  if (!url.startsWith('http')) {
    return `EXPO_PUBLIC_SUPABASE_URL должна начинаться с https:// — сейчас там «${url}».`;
  }
  return null;
}

export const configProblem = detectConfigProblem();
export const isConfigured = configProblem === null;

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
