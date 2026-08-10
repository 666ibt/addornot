import { fetchJson } from "../http.ts";
import { ImportError, type ParsedPlaylist, type RawTrack } from "../types.ts";
import type { PlaylistRef } from "./detect.ts";

/**
 * Яндекс Музыка.
 *
 * Публичного документированного API нет. Веб-плеер ходит в
 * /handlers/playlist.jsx — этим же эндпоинтом пользуемся и мы.
 * Работает только для публичных плейлистов.
 */
export async function fetchYandexPlaylist(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const owner = ref.extra.owner;
  const kind = ref.extra.kind;

  const url = `https://music.yandex.ru/handlers/playlist.jsx?owner=${
    encodeURIComponent(owner)
  }&kinds=${encodeURIComponent(kind)}&light=false&madeFor=&lang=ru`;

  let payload: YandexPlaylistResponse;
  try {
    payload = await fetchJson<YandexPlaylistResponse>(url, {
      browserLike: true,
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "X-Retpath-Y": ref.url,
        Referer: ref.url,
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
    });
  } catch (error) {
    throw new ImportError(
      "Яндекс Музыка не отдала плейлист. Убедитесь, что он публичный " +
        `(${(error as Error).message})`,
      "yandex_fetch_failed",
      502,
    );
  }

  const playlist = payload.playlist;
  if (!playlist) {
    throw new ImportError("Плейлист Яндекс Музыки не найден", "yandex_not_found", 404);
  }

  const tracks: RawTrack[] = [];
  for (const track of playlist.tracks ?? []) {
    const title = track.title?.trim();
    const artist = (track.artists ?? []).map((a) => a.name).filter(Boolean).join(", ");
    if (!title || !artist) continue;
    tracks.push({
      title: track.version ? `${title} (${track.version})` : title,
      artist,
      album: track.albums?.[0]?.title,
      durationSec: track.durationMs ? Math.round(track.durationMs / 1000) : undefined,
    });
  }

  if (tracks.length === 0) {
    throw new ImportError(
      "В плейлисте Яндекс Музыки не нашлось треков — возможно, он приватный.",
      "yandex_empty",
      422,
    );
  }

  return {
    platform: "yandex",
    externalId: ref.externalId,
    title: playlist.title ?? null,
    coverUrl: playlist.cover?.uri
      ? `https://${playlist.cover.uri.replace("%%", "400x400")}`
      : null,
    ownerName: playlist.owner?.name ?? null,
    tracks: tracks.slice(0, 500),
  };
}

interface YandexPlaylistResponse {
  playlist?: {
    title?: string;
    cover?: { uri?: string };
    owner?: { name?: string };
    tracks?: Array<{
      title?: string;
      version?: string;
      durationMs?: number;
      artists?: Array<{ name?: string }>;
      albums?: Array<{ title?: string }>;
    }>;
  };
}
