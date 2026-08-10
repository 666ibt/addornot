export type Platform =
  | "spotify"
  | "apple_music"
  | "youtube"
  | "deezer"
  | "yandex"
  | "soundcloud";

/** Трек в том виде, в каком его отдала исходная платформа. */
export interface RawTrack {
  title: string;
  artist: string;
  album?: string;
  isrc?: string;
  durationSec?: number;
}

/** Нормализованный результат разбора плейлиста. */
export interface ParsedPlaylist {
  platform: Platform;
  externalId: string | null;
  title: string | null;
  coverUrl: string | null;
  ownerName: string | null;
  tracks: RawTrack[];
}

/** Трек из каталога Deezer, приведённый к нашей схеме. */
export interface CatalogTrack {
  provider: "deezer";
  provider_id: string;
  isrc: string | null;
  title: string;
  artist_name: string;
  artist_provider_id: string | null;
  artist_picture_url: string | null;
  album_title: string | null;
  artwork_url: string | null;
  preview_url: string | null;
  external_url: string | null;
  duration_sec: number | null;
  release_year: number | null;
  bpm: number | null;
  explicit: boolean;
  genres: string[];
  popularity: number;
}

export class ImportError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ImportError";
  }
}
