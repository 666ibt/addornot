import type { CatalogTrack } from "./types.ts";

/**
 * Анализ плейлиста: из списка треков собираем вкусовой профиль —
 * веса жанров, исполнителей и десятилетий плюс средние bpm/год.
 *
 * Веса нормируются так, чтобы максимальный был равен 1. Это делает профиль
 * независимым от размера плейлиста: у 20 и у 500 треков шкала одна и та же,
 * и накопленные позже поправки от свайпов остаются сопоставимыми по величине.
 */

export interface TasteProfile {
  genre_weights: Record<string, number>;
  artist_weights: Record<string, number>;
  decade_weights: Record<string, number>;
  avg_bpm: number | null;
  avg_year: number | null;
  seed_artists: string[];
}

export function buildTasteProfile(tracks: CatalogTrack[]): TasteProfile {
  const genres = new Map<string, number>();
  const artists = new Map<string, number>();
  const decades = new Map<string, number>();
  const artistIds = new Map<string, number>();

  let bpmSum = 0;
  let bpmCount = 0;
  let yearSum = 0;
  let yearCount = 0;

  for (const track of tracks) {
    // Трек с пятью жанрами не должен «перевешивать» трек с одним.
    const genreShare = track.genres.length > 0 ? 1 / track.genres.length : 0;
    for (const genre of track.genres) {
      genres.set(genre, (genres.get(genre) ?? 0) + genreShare);
    }

    const artistKey = track.artist_name.toLowerCase();
    artists.set(artistKey, (artists.get(artistKey) ?? 0) + 1);

    if (track.artist_provider_id) {
      artistIds.set(
        track.artist_provider_id,
        (artistIds.get(track.artist_provider_id) ?? 0) + 1,
      );
    }

    if (track.release_year) {
      const decade = String(Math.floor(track.release_year / 10) * 10);
      decades.set(decade, (decades.get(decade) ?? 0) + 1);
      yearSum += track.release_year;
      yearCount++;
    }

    if (track.bpm && track.bpm > 0) {
      bpmSum += Number(track.bpm);
      bpmCount++;
    }
  }

  return {
    genre_weights: normalize(genres),
    artist_weights: normalize(artists),
    decade_weights: normalize(decades),
    avg_bpm: bpmCount > 0 ? round(bpmSum / bpmCount, 1) : null,
    avg_year: yearCount > 0 ? round(yearSum / yearCount, 1) : null,
    seed_artists: [...artistIds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([id]) => id),
  };
}

function normalize(counts: Map<string, number>): Record<string, number> {
  const max = Math.max(...counts.values(), 0);
  if (max <= 0) return {};

  const result: Record<string, number> = {};
  for (const [key, value] of counts) {
    result[key] = round(value / max, 4);
  }
  return result;
}

function round(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/** Топ ключей профиля по убыванию веса (отрицательные отбрасываем). */
export function topKeys(weights: Record<string, number>, limit: number): string[] {
  return Object.entries(weights)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}
