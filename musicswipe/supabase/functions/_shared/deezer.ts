/**
 * Клиент публичного API Deezer.
 *
 * Deezer выбран «общим знаменателем» каталога: у него открытый API без ключей,
 * 30-секундные превью для проигрывания в карточках и жанры на уровне альбома.
 * Треки из любого исходного плейлиста мы сопоставляем с этим каталогом, чтобы
 * дальше работать с одной моделью данных.
 */

import { fetchJson, RateLimiter } from "./http.ts";
import type { CatalogTrack, RawTrack } from "./types.ts";

const API = "https://api.deezer.com";

// Deezer разрешает ~50 запросов за 5 секунд. Держим запас.
const limiter = new RateLimiter(8);

interface DeezerError {
  error?: { type: string; message: string; code: number };
}

export interface DeezerArtist {
  id: number;
  name: string;
  picture_medium?: string;
  picture_big?: string;
}

export interface DeezerAlbum {
  id: number;
  title: string;
  cover_medium?: string;
  cover_big?: string;
  release_date?: string;
  genres?: { data: Array<{ id: number; name: string }> };
}

export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  isrc?: string;
  link?: string;
  duration?: number;
  rank?: number;
  bpm?: number;
  explicit_lyrics?: boolean;
  release_date?: string;
  preview?: string;
  artist?: DeezerArtist;
  album?: DeezerAlbum;
}

async function call<T>(path: string): Promise<T> {
  return await limiter.run(async () => {
    const data = await fetchJson<T & DeezerError>(`${API}${path}`, { retries: 2 });
    if (data && typeof data === "object" && "error" in data && data.error) {
      throw new Error(`Deezer: ${data.error.message ?? data.error.type}`);
    }
    return data as T;
  });
}

// --- Кэши в пределах одного вызова функции ----------------------------------
const albumCache = new Map<number, DeezerAlbum | null>();
const trackCache = new Map<number, DeezerTrack | null>();

export async function getAlbum(albumId: number): Promise<DeezerAlbum | null> {
  if (albumCache.has(albumId)) return albumCache.get(albumId)!;
  try {
    const album = await call<DeezerAlbum>(`/album/${albumId}`);
    albumCache.set(albumId, album);
    return album;
  } catch {
    albumCache.set(albumId, null);
    return null;
  }
}

export async function getTrack(trackId: number): Promise<DeezerTrack | null> {
  if (trackCache.has(trackId)) return trackCache.get(trackId)!;
  try {
    const track = await call<DeezerTrack>(`/track/${trackId}`);
    trackCache.set(trackId, track);
    return track;
  } catch {
    trackCache.set(trackId, null);
    return null;
  }
}

export async function getPlaylist(playlistId: string, maxTracks = 400): Promise<{
  title: string | null;
  coverUrl: string | null;
  ownerName: string | null;
  tracks: DeezerTrack[];
}> {
  const head = await call<{
    title?: string;
    picture_medium?: string;
    creator?: { name?: string };
    tracks?: { data?: DeezerTrack[]; next?: string };
  }>(`/playlist/${playlistId}`);

  const tracks: DeezerTrack[] = [...(head.tracks?.data ?? [])];
  let index = tracks.length;

  while (tracks.length < maxTracks) {
    const page = await call<{ data?: DeezerTrack[] }>(
      `/playlist/${playlistId}/tracks?index=${index}&limit=100`,
    );
    const batch = page.data ?? [];
    if (batch.length === 0) break;
    tracks.push(...batch);
    index += batch.length;
  }

  return {
    title: head.title ?? null,
    coverUrl: head.picture_medium ?? null,
    ownerName: head.creator?.name ?? null,
    tracks: tracks.slice(0, maxTracks),
  };
}

export async function searchTrack(raw: RawTrack): Promise<DeezerTrack | null> {
  const queries: string[] = [];

  if (raw.artist && raw.title) {
    queries.push(`artist:"${escapeQuery(raw.artist)}" track:"${escapeQuery(raw.title)}"`);
    queries.push(`${escapeQuery(raw.artist)} ${escapeQuery(raw.title)}`);
    // Второй заход — с очищенным названием («... (feat. X)», «- Remastered» и т.п.)
    const cleaned = cleanTitle(raw.title);
    if (cleaned !== raw.title) {
      queries.push(`artist:"${escapeQuery(raw.artist)}" track:"${escapeQuery(cleaned)}"`);
    }
  } else {
    queries.push(escapeQuery(`${raw.artist} ${raw.title}`.trim()));
  }

  for (const q of queries) {
    try {
      const res = await call<{ data?: DeezerTrack[] }>(
        `/search?q=${encodeURIComponent(q)}&limit=5`,
      );
      const best = pickBestMatch(res.data ?? [], raw);
      if (best) return best;
    } catch {
      // пробуем следующий вариант запроса
    }
  }
  return null;
}

export async function relatedArtists(artistId: number, limit = 8): Promise<DeezerArtist[]> {
  try {
    const res = await call<{ data?: DeezerArtist[] }>(`/artist/${artistId}/related?limit=${limit}`);
    return res.data ?? [];
  } catch {
    return [];
  }
}

export async function artistTopTracks(artistId: number, limit = 10): Promise<DeezerTrack[]> {
  try {
    const res = await call<{ data?: DeezerTrack[] }>(`/artist/${artistId}/top?limit=${limit}`);
    return res.data ?? [];
  } catch {
    return [];
  }
}

export async function searchArtist(name: string): Promise<DeezerArtist | null> {
  try {
    const res = await call<{ data?: DeezerArtist[] }>(
      `/search/artist?q=${encodeURIComponent(name)}&limit=1`,
    );
    return res.data?.[0] ?? null;
  } catch {
    return null;
  }
}

let genreIndex: Map<string, number> | null = null;

/** Список жанров Deezer: имя (в нижнем регистре) -> id. */
export async function getGenreIndex(): Promise<Map<string, number>> {
  if (genreIndex) return genreIndex;
  const index = new Map<string, number>();
  try {
    const res = await call<{ data?: Array<{ id: number; name: string }> }>("/genre");
    for (const g of res.data ?? []) {
      index.set(g.name.toLowerCase(), g.id);
    }
  } catch {
    // пустой индекс — просто не будем использовать чарты по жанрам
  }
  genreIndex = index;
  return index;
}

export async function genreChartTracks(genreId: number, limit = 25): Promise<DeezerTrack[]> {
  try {
    const res = await call<{ data?: DeezerTrack[] }>(`/chart/${genreId}/tracks?limit=${limit}`);
    return res.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Дополняет трек данными, которых нет в кратком ответе: ISRC, bpm, год, жанры.
 * Жанры лежат на альбоме, поэтому альбом дотягиваем и кэшируем.
 *
 * Каждый флаг — это дополнительный HTTP-запрос на трек, поэтому на больших
 * списках-кандидатах обогащение включают только для финальной выборки.
 */
export async function toCatalogTrack(
  track: DeezerTrack,
  options: { albumDetail?: boolean; trackDetail?: boolean } = {},
): Promise<CatalogTrack> {
  const albumDetail = options.albumDetail ?? true;
  const trackDetail = options.trackDetail ?? false;

  let full = track;
  if (trackDetail && (track.isrc === undefined || track.bpm === undefined)) {
    const detailed = await getTrack(track.id);
    if (detailed) full = { ...track, ...detailed };
  }

  let genres: string[] = [];
  let releaseDate = full.release_date ?? full.album?.release_date ?? null;

  const albumId = full.album?.id;
  if (albumDetail && albumId) {
    const album = await getAlbum(albumId);
    if (album) {
      genres = (album.genres?.data ?? []).map((g) => g.name).filter(Boolean);
      releaseDate = releaseDate ?? album.release_date ?? null;
    }
  }

  const year = releaseDate ? Number(releaseDate.slice(0, 4)) : null;

  return {
    provider: "deezer",
    provider_id: String(full.id),
    isrc: full.isrc ?? null,
    title: full.title_short ?? full.title,
    artist_name: full.artist?.name ?? "Unknown",
    artist_provider_id: full.artist?.id ? String(full.artist.id) : null,
    artist_picture_url: full.artist?.picture_medium ?? full.artist?.picture_big ?? null,
    album_title: full.album?.title ?? null,
    artwork_url: full.album?.cover_big ?? full.album?.cover_medium ?? null,
    preview_url: full.preview && full.preview.length > 0 ? full.preview : null,
    external_url: full.link ?? `https://www.deezer.com/track/${full.id}`,
    duration_sec: full.duration ?? null,
    release_year: year && Number.isFinite(year) ? year : null,
    bpm: full.bpm && full.bpm > 0 ? full.bpm : null,
    explicit: Boolean(full.explicit_lyrics),
    genres,
    popularity: full.rank ?? 0,
  };
}

// --- Вспомогательное ---------------------------------------------------------

function escapeQuery(value: string): string {
  return value.replace(/["\\]/g, " ").trim();
}

export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[\(\[](feat\.?|ft\.?|with)[^\)\]]*[\)\]]/gi, "")
    .replace(/\s*[\(\[][^\)\]]*(remaster|remastered|deluxe|bonus|explicit|lyric|audio|video|official)[^\)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(remaster(ed)?|single version|album version)\b.*$/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Похожесть по токенам — коэффициент Жаккара. */
function similarity(a: string, b: string): number {
  const setA = new Set(normalize(a).split(" ").filter(Boolean));
  const setB = new Set(normalize(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const token of setA) if (setB.has(token)) common++;
  return common / (setA.size + setB.size - common);
}

function pickBestMatch(candidates: DeezerTrack[], raw: RawTrack): DeezerTrack | null {
  let best: DeezerTrack | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const titleScore = similarity(candidate.title_short ?? candidate.title, cleanTitle(raw.title));
    const artistScore = similarity(candidate.artist?.name ?? "", raw.artist);
    let score = titleScore * 0.6 + artistScore * 0.4;

    if (raw.durationSec && candidate.duration) {
      const diff = Math.abs(raw.durationSec - candidate.duration);
      if (diff <= 3) score += 0.1;
      else if (diff > 25) score -= 0.1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= 0.45 ? best : null;
}
