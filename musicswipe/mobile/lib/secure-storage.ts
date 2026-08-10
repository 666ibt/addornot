import * as SecureStore from 'expo-secure-store';

/**
 * Хранилище сессии Supabase в Keychain.
 *
 * SecureStore не принимает значения длиннее ~2 КБ, а сессия с access- и
 * refresh-токенами в это не укладывается — поэтому режем её на куски и
 * храним рядом счётчик. Альтернатива, AsyncStorage, кладёт токены в обычный
 * файл, который попадает в резервные копии в открытом виде.
 */

const CHUNK_SIZE = 1800;

function chunkKey(key: string, index: number) {
  return `${key}_${index}`;
}

function countKey(key: string) {
  return `${key}_count`;
}

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    try {
      const rawCount = await SecureStore.getItemAsync(countKey(key));
      if (rawCount === null) return null;

      const count = Number(rawCount);
      if (!Number.isFinite(count) || count <= 0) return null;

      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const part = await SecureStore.getItemAsync(chunkKey(key, i));
        // Потеряли кусок — значение целиком непригодно, лучше начать заново.
        if (part === null) return null;
        parts.push(part);
      }
      return parts.join('');
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    await secureStorage.removeItem(key);

    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks.push(value.slice(i, i + CHUNK_SIZE));
    }

    for (let i = 0; i < chunks.length; i++) {
      await SecureStore.setItemAsync(chunkKey(key, i), chunks[i]);
    }
    await SecureStore.setItemAsync(countKey(key), String(chunks.length));
  },

  async removeItem(key: string): Promise<void> {
    try {
      const rawCount = await SecureStore.getItemAsync(countKey(key));
      const count = Number(rawCount ?? 0);

      if (Number.isFinite(count)) {
        for (let i = 0; i < count; i++) {
          await SecureStore.deleteItemAsync(chunkKey(key, i));
        }
      }
      await SecureStore.deleteItemAsync(countKey(key));
    } catch {
      // Нечего удалять — это нормальное состояние при первом запуске.
    }
  },
};
