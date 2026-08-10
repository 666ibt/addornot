import { fetchJson, fetchText } from "../http.ts";
import { ImportError, type ParsedPlaylist, type RawTrack } from "../types.ts";
import { splitVideoTitle } from "./youtube.ts";
import type { PlaylistRef } from "./detect.ts";

/**
 * SoundCloud.
 *
 * Публичного API без регистрации нет, но у веб-плеера есть client_id,
 * который лежит в его же JS-бандлах. Если задан SOUNDCLOUD_CLIENT_ID —
 * используем его, иначе достаём из страницы.
 */
export async function fetchSoundCloudPlaylist(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const clientId = Deno.env.get("SOUNDCLOUD_CLIENT_ID") ?? await discoverClientId();

  if (!clientId) {
    throw new ImportError(
      "Не удалось получить доступ к SoundCloud. Добавьте SOUNDCLOUD_CLIENT_ID в секреты Supabase.",
      "soundcloud_no_client_id",
      502,
    );
  }

  const resolveUrl = `https://api-v2.soundcloud.com/resolve?url=${
    encodeURIComponent(ref.url)
  }&client_id=${clientId}`;

  let playlist: SoundCloudPlaylist;
  try {
    playlist = await fetchJson<SoundCloudPlaylist>(resolveUrl, { browserLike: true });
  } catch (error) {
    throw new ImportError(
      `SoundCloud не отдал плейлист: ${(error as Error).message}`,
      "soundcloud_fetch_failed",
      502,
    );
  }

  const tracks: RawTrack[] = [];

  for (const track of playlist.tracks ?? []) {
    // В ответе часть треков приходит «заглушками» — только с id.
    if (!track.title) continue;
    const channel = track.user?.username;
    const parsed = splitVideoTitle(track.title, channel);
    if (!parsed) continue;
    tracks.push({
      ...parsed,
      durationSec: track.duration ? Math.round(track.duration / 1000) : undefined,
    });
  }

  if (tracks.length === 0) {
    throw new ImportError(
      "В сете SoundCloud не нашлось треков с распознаваемыми названиями.",
      "soundcloud_empty",
      422,
    );
  }

  return {
    platform: "soundcloud",
    externalId: ref.externalId,
    title: playlist.title ?? null,
    coverUrl: playlist.artwork_url ?? null,
    ownerName: playlist.user?.username ?? null,
    tracks: tracks.slice(0, 500),
  };
}

async function discoverClientId(): Promise<string | null> {
  try {
    const html = await fetchText("https://soundcloud.com/discover");
    const scripts = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)]
      .map((match) => match[1]);

    for (const src of scripts.reverse()) {
      const bundle = await fetchText(src);
      const match = bundle.match(/client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/);
      if (match) return match[1];
    }
  } catch {
    // ниже вернём null и покажем понятную ошибку
  }
  return null;
}

interface SoundCloudPlaylist {
  title?: string;
  artwork_url?: string;
  user?: { username?: string };
  tracks?: Array<{
    title?: string;
    duration?: number;
    user?: { username?: string };
  }>;
}
