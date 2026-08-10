import type { SupabaseClient } from "./db.ts";
import * as deezer from "./deezer.ts";
import type { CatalogTrack, RawTrack } from "./types.ts";

/**
 * Сопоставление треков исходного плейлиста с каталогом Deezer и запись
 * результата в БД. Возвращает соответствие «позиция в плейлисте -> track_id».
 */

export interface ResolvedTrack {
  position: number;
  raw: RawTrack;
  catalog: CatalogTrack | null;
  trackId: string | null;
}

/** Ищет треки в каталоге. Запросы к Deezer уже троттлятся внутри клиента. */
export async function resolveRawTracks(
  rawTracks: RawTrack[],
  options: { concurrency?: number; albumDetail?: boolean } = {},
): Promise<Array<{ position: number; raw: RawTrack; catalog: CatalogTrack | null }>> {
  const concurrency = options.concurrency ?? 6;
  const albumDetail = options.albumDetail ?? true;
  const results: Array<{ position: number; raw: RawTrack; catalog: CatalogTrack | null }> = [];

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, rawTracks.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= rawTracks.length) return;
      const raw = rawTracks[index];
      try {
        const found = await deezer.searchTrack(raw);
        const catalog = found ? await deezer.toCatalogTrack(found, { albumDetail }) : null;
        results.push({ position: index, raw, catalog });
      } catch (error) {
        console.warn(`Не удалось сопоставить «${raw.artist} — ${raw.title}»:`, error);
        results.push({ position: index, raw, catalog: null });
      }
    }
  });

  await Promise.all(workers);
  results.sort((a, b) => a.position - b.position);
  return results;
}

/**
 * Записывает исполнителей и треки в каталог.
 * Возвращает соответствие «deezer id трека -> uuid в нашей БД».
 */
export async function upsertCatalog(
  admin: SupabaseClient,
  tracks: CatalogTrack[],
): Promise<Map<string, string>> {
  const trackIds = new Map<string, string>();
  if (tracks.length === 0) return trackIds;

  const unique = new Map<string, CatalogTrack>();
  for (const track of tracks) {
    if (!unique.has(track.provider_id)) unique.set(track.provider_id, track);
  }
  const deduped = [...unique.values()];

  // --- исполнители ---------------------------------------------------------
  const artistRows = new Map<string, { provider: string; provider_id: string; name: string; picture_url: string | null }>();
  for (const track of deduped) {
    if (!track.artist_provider_id || artistRows.has(track.artist_provider_id)) continue;
    artistRows.set(track.artist_provider_id, {
      provider: "deezer",
      provider_id: track.artist_provider_id,
      name: track.artist_name,
      picture_url: track.artist_picture_url,
    });
  }

  const artistIds = new Map<string, string>();
  for (const chunk of chunked([...artistRows.values()], 200)) {
    const { data, error } = await admin
      .from("artists")
      .upsert(chunk, { onConflict: "provider,provider_id" })
      .select("id, provider_id");
    if (error) throw new Error(`Не удалось сохранить исполнителей: ${error.message}`);
    for (const row of data ?? []) artistIds.set(row.provider_id as string, row.id as string);
  }

  // --- треки ---------------------------------------------------------------
  const trackRows = deduped.map((track) => ({
    provider: track.provider,
    provider_id: track.provider_id,
    isrc: track.isrc,
    title: track.title,
    artist_name: track.artist_name,
    artist_id: track.artist_provider_id ? artistIds.get(track.artist_provider_id) ?? null : null,
    album_title: track.album_title,
    artwork_url: track.artwork_url,
    preview_url: track.preview_url,
    external_url: track.external_url,
    duration_sec: track.duration_sec,
    release_year: track.release_year,
    bpm: track.bpm,
    explicit: track.explicit,
    genres: track.genres,
    popularity: track.popularity,
  }));

  for (const chunk of chunked(trackRows, 200)) {
    const { data, error } = await admin
      .from("tracks")
      .upsert(chunk, { onConflict: "provider,provider_id" })
      .select("id, provider_id");
    if (error) throw new Error(`Не удалось сохранить треки: ${error.message}`);
    for (const row of data ?? []) trackIds.set(row.provider_id as string, row.id as string);
  }

  return trackIds;
}

export function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
