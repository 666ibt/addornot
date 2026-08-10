import * as deezer from "./deezer.ts";
import { trackKey } from "./matching.ts";
import { topKeys } from "./taste.ts";
import type { CatalogTrack } from "./types.ts";

/**
 * Движок рекомендаций.
 *
 * Работает в два прохода, чтобы уложиться в лимиты внешнего API:
 *
 *  1. Дёшево набираем кандидатов — «похожие исполнители» для опорных артистов
 *     и чарты по любимым жанрам. Здесь у треков ещё нет жанров и года.
 *  2. Отбираем лучших по предварительной оценке, дотягиваем им альбом
 *     (жанры + год выхода) и пересчитываем итоговый скор.
 *
 * Такой порядок даёт примерно один HTTP-запрос на финальную карточку вместо
 * запроса на каждого кандидата.
 */

export interface ProfileWeights {
  genre_weights: Record<string, number>;
  artist_weights: Record<string, number>;
  decade_weights: Record<string, number>;
  avg_bpm: number | null;
  avg_year: number | null;
}

export interface SeedArtist {
  provider_id: string;
  weight: number;
}

export interface Recommendation {
  track: CatalogTrack;
  score: number;
  reason: {
    kind: "related_artist" | "genre_chart" | "favourite_artist";
    via?: string;
    genres?: string[];
  };
}

interface Candidate {
  track: deezer.DeezerTrack;
  kind: Recommendation["reason"]["kind"];
  via?: string;
  seedWeight: number;
}

const MAX_SEEDS = 8;
const RELATED_PER_SEED = 6;
const TRACKS_PER_ARTIST = 4;
const MAX_GENRES = 4;
const GENRE_CHART_SIZE = 25;
const SHORTLIST = 70;
const MAX_PER_ARTIST = 2;

export async function recommend(options: {
  profile: ProfileWeights;
  seeds: SeedArtist[];
  knownProviderIds: Set<string>;
  /**
   * Ключи «исполнитель + название» того, что пользователь уже знает.
   * Нужны, потому что совпадение по идентификатору Deezer ловит не всё:
   * в плейлисте трек мог не дойти до каталога, а тот же трек в другом
   * издании имеет другой идентификатор.
   */
  knownTrackKeys: Set<string>;
  limit: number;
}): Promise<Recommendation[]> {
  const { profile, seeds, knownProviderIds, knownTrackKeys, limit } = options;

  const candidates = await collectCandidates(profile, seeds);

  // --- проход 1: отсев без обогащения --------------------------------------
  const byProviderId = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const id = String(candidate.track.id);
    if (knownProviderIds.has(id)) continue;
    if (!candidate.track.preview) continue;

    const key = trackKey(candidate.track.artist?.name ?? "", candidate.track.title);
    if (knownTrackKeys.has(key)) continue;

    const existing = byProviderId.get(id);
    if (!existing || candidate.seedWeight > existing.seedWeight) {
      byProviderId.set(id, candidate);
    }
  }

  const shortlist = [...byProviderId.values()]
    .map((candidate) => ({ candidate, score: preliminaryScore(candidate, profile) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST);

  // --- проход 2: обогащение и финальный скор -------------------------------
  const enriched: Recommendation[] = [];
  for (const slice of chunked(shortlist, 8)) {
    const batch = await Promise.all(slice.map(async ({ candidate }) => {
      const track = await deezer.toCatalogTrack(candidate.track, {
        albumDetail: true,
        trackDetail: false,
      });
      return { candidate, track };
    }));

    for (const { candidate, track } of batch) {
      if (!track.preview_url) continue;
      enriched.push({
        track,
        score: finalScore(track, candidate, profile),
        reason: { kind: candidate.kind, via: candidate.via, genres: track.genres },
      });
    }
  }

  enriched.sort((a, b) => b.score - a.score);

  // --- разнообразие: не больше двух треков одного исполнителя --------------
  const perArtist = new Map<string, number>();
  const result: Recommendation[] = [];

  for (const item of enriched) {
    const key = item.track.artist_name.toLowerCase();
    const used = perArtist.get(key) ?? 0;
    if (used >= MAX_PER_ARTIST) continue;
    perArtist.set(key, used + 1);
    result.push(item);
    if (result.length >= limit) break;
  }

  return result;
}

async function collectCandidates(
  profile: ProfileWeights,
  seeds: SeedArtist[],
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const topSeeds = seeds.slice(0, MAX_SEEDS);
  const maxSeedWeight = Math.max(...topSeeds.map((s) => s.weight), 1);

  // Похожие исполнители — основной источник открытий.
  const seedResults = await Promise.all(topSeeds.map(async (seed) => {
    const artistId = Number(seed.provider_id);
    if (!Number.isFinite(artistId)) return [];
    const related = await deezer.relatedArtists(artistId, RELATED_PER_SEED);
    return related.map((artist) => ({ artist, seed }));
  }));

  const relatedArtists = new Map<number, { name: string; seedWeight: number; via: string }>();
  for (const group of seedResults) {
    for (const { artist, seed } of group) {
      const normalizedWeight = seed.weight / maxSeedWeight;
      const existing = relatedArtists.get(artist.id);
      if (!existing || normalizedWeight > existing.seedWeight) {
        relatedArtists.set(artist.id, {
          name: artist.name,
          seedWeight: normalizedWeight,
          via: artist.name,
        });
      }
    }
  }

  const artistTracks = await Promise.all(
    [...relatedArtists.entries()].map(async ([artistId, meta]) => {
      const tracks = await deezer.artistTopTracks(artistId, TRACKS_PER_ARTIST);
      return tracks.map((track): Candidate => ({
        track,
        kind: "related_artist",
        via: meta.via,
        seedWeight: meta.seedWeight,
      }));
    }),
  );
  for (const group of artistTracks) candidates.push(...group);

  // Чарты по любимым жанрам — подстраховка, когда похожих мало.
  const genreIndex = await deezer.getGenreIndex();
  const favouriteGenres = topKeys(profile.genre_weights, MAX_GENRES);

  const genreTracks = await Promise.all(favouriteGenres.map(async (genre) => {
    const genreId = genreIndex.get(genre.toLowerCase());
    if (genreId === undefined) return [];
    const tracks = await deezer.genreChartTracks(genreId, GENRE_CHART_SIZE);
    return tracks.map((track): Candidate => ({
      track,
      kind: "genre_chart",
      via: genre,
      seedWeight: profile.genre_weights[genre] ?? 0.5,
    }));
  }));
  for (const group of genreTracks) candidates.push(...group);

  return candidates;
}

function preliminaryScore(candidate: Candidate, profile: ProfileWeights): number {
  const artistKey = candidate.track.artist?.name?.toLowerCase() ?? "";
  const familiarity = profile.artist_weights[artistKey] ?? 0;

  // Знакомого исполнителя не выкидываем, но и вперёд не пускаем:
  // задача ленты — показывать новое.
  const affinity = familiarity > 0 ? 0.45 : candidate.seedWeight;
  const popularity = Math.min((candidate.track.rank ?? 0) / 500_000, 1);
  const sourceBonus = candidate.kind === "related_artist" ? 0.15 : 0;

  return affinity * 0.6 + popularity * 0.25 + sourceBonus + Math.random() * 0.05;
}

function finalScore(
  track: CatalogTrack,
  candidate: Candidate,
  profile: ProfileWeights,
): number {
  const genreScore = track.genres.length > 0
    ? track.genres.reduce((sum, genre) => sum + (profile.genre_weights[genre] ?? 0), 0) /
      track.genres.length
    : 0.15;

  const artistKey = track.artist_name.toLowerCase();
  const familiarity = profile.artist_weights[artistKey] ?? 0;
  const artistScore = familiarity > 0 ? 0.5 : Math.min(candidate.seedWeight + 0.2, 1);

  const decadeScore = track.release_year
    ? profile.decade_weights[String(Math.floor(track.release_year / 10) * 10)] ?? 0.1
    : 0.1;

  const popularity = Math.min(track.popularity / 500_000, 1);

  let bpmScore = 0.5;
  if (profile.avg_bpm && track.bpm) {
    const diff = Math.abs(Number(track.bpm) - profile.avg_bpm);
    bpmScore = Math.max(0, 1 - diff / 60);
  }

  const score = genreScore * 0.38 +
    artistScore * 0.27 +
    decadeScore * 0.12 +
    popularity * 0.13 +
    bpmScore * 0.05 +
    Math.random() * 0.05;

  return Math.round(score * 10_000) / 10_000;
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
