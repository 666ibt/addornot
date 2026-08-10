export type SwipeDirection = 'like' | 'pass' | 'superlike';

export interface RecommendationReason {
  kind?: 'related_artist' | 'genre_chart' | 'favourite_artist';
  via?: string;
  genres?: string[];
}

/** Карточка ленты — строка из RPC `get_deck`. */
export interface Track {
  id: string;
  title: string;
  artist_name: string;
  album_title: string | null;
  artwork_url: string | null;
  preview_url: string | null;
  external_url: string | null;
  duration_sec: number | null;
  release_year: number | null;
  genres: string[];
  explicit: boolean;
  score: number | null;
  reason: RecommendationReason | null;
}

/** Понравившийся трек — строка из RPC `liked_tracks`. */
export interface LikedTrack {
  id: string;
  title: string;
  artist_name: string;
  album_title: string | null;
  artwork_url: string | null;
  preview_url: string | null;
  external_url: string | null;
  duration_sec: number | null;
  release_year: number | null;
  genres: string[];
  superliked: boolean;
  liked_at: string;
}

export interface TasteGenre {
  genre: string;
  weight: number;
}

export interface PlaylistSummary {
  id: string;
  platform: string;
  title: string | null;
  cover_url: string | null;
  owner_name: string | null;
  status: string;
  track_count: number;
  matched_count: number;
  error_message: string | null;
  created_at: string;
}

/**
 * Ответ Edge Function `import-playlist`.
 *
 * Функция отвечает сразу после сохранения состава плейлиста — разбор идёт
 * в фоне, за ним следят через `playlistProgress`.
 */
export interface ImportPlaylistResult {
  playlist: {
    id: string;
    platform: string;
    title: string | null;
    cover_url: string | null;
    owner_name: string | null;
    track_count: number;
    status: string;
  };
}

/** Ход разбора — ответ RPC `playlist_progress`. */
export interface PlaylistProgress {
  id: string;
  status: 'pending' | 'importing' | 'ready' | 'failed';
  platform: string;
  title: string | null;
  cover_url: string | null;
  track_count: number;
  analyzed_count: number;
  matched_count: number;
  error_message: string | null;
}

export interface RecommendResult {
  inserted: number;
  reason: string | null;
}

export interface RebuildProfileResult {
  corpus_size: number;
  top_genres: Array<{ genre: string; weight: number }>;
  deck_prepared: number;
}

/** Пояснение на карточке: почему трек попал в ленту. */
export function reasonText(reason: RecommendationReason | null): string | null {
  if (!reason?.kind) return null;

  switch (reason.kind) {
    case 'related_artist':
      return reason.via ? `Похоже на ${reason.via}` : 'Похоже на то, что вы слушаете';
    case 'genre_chart':
      return reason.via ? `Из вашего жанра: ${reason.via}` : 'Из ваших жанров';
    case 'favourite_artist':
      return 'Любимый исполнитель';
  }
}

/** 214 -> «3:34» */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
