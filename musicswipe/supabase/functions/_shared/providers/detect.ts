import type { Platform } from "../types.ts";
import { ImportError } from "../types.ts";
import { fetchWithRetry } from "../http.ts";

export interface PlaylistRef {
  platform: Platform;
  /** id плейлиста в терминах платформы */
  externalId: string;
  /** нормализованный url, уже после разворачивания коротких ссылок */
  url: string;
  /** дополнительные части адреса (например, storefront у Apple Music) */
  extra: Record<string, string>;
}

const SHORT_LINK_HOSTS = new Set([
  "spotify.link",
  "deezer.page.link",
  "dzr.page.link",
  "youtu.be",
  "music.yandex.com",
  "on.soundcloud.com",
  "l.music.apple.com",
]);

/** Разворачивает короткие ссылки (spotify.link, deezer.page.link и т.п.). */
export async function resolveShortLink(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ImportError("Некорректная ссылка", "invalid_url");
  }

  if (!SHORT_LINK_HOSTS.has(url.hostname)) return rawUrl;

  try {
    const res = await fetchWithRetry(rawUrl, {
      method: "GET",
      redirect: "follow",
      browserLike: true,
      retries: 1,
    });
    return res.url || rawUrl;
  } catch {
    return rawUrl;
  }
}

export function detectPlaylist(rawUrl: string): PlaylistRef {
  const trimmed = rawUrl.trim();

  // spotify:playlist:37i9dQ...
  const uriMatch = trimmed.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uriMatch) {
    return {
      platform: "spotify",
      externalId: uriMatch[1],
      url: `https://open.spotify.com/playlist/${uriMatch[1]}`,
      extra: {},
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ImportError("Не похоже на ссылку на плейлист", "invalid_url");
  }

  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;

  // --- Spotify -------------------------------------------------------------
  if (host.endsWith("spotify.com")) {
    const m = path.match(/\/playlist\/([A-Za-z0-9]+)/);
    if (m) {
      return { platform: "spotify", externalId: m[1], url: trimmed, extra: {} };
    }
    throw new ImportError(
      "В ссылке Spotify не найден идентификатор плейлиста",
      "unsupported_spotify_link",
    );
  }

  // --- Apple Music ---------------------------------------------------------
  if (host === "music.apple.com" || host === "embed.music.apple.com") {
    const m = path.match(/\/(?:([a-z]{2})\/)?playlist\/[^/]*\/?(pl\.[A-Za-z0-9-]+)/);
    if (m) {
      return {
        platform: "apple_music",
        externalId: m[2],
        url: trimmed,
        extra: { storefront: m[1] ?? "us" },
      };
    }
    throw new ImportError(
      "В ссылке Apple Music не найден идентификатор плейлиста",
      "unsupported_apple_link",
    );
  }

  // --- YouTube / YouTube Music --------------------------------------------
  if (host.endsWith("youtube.com") || host === "youtu.be") {
    const listId = url.searchParams.get("list");
    if (listId) {
      return { platform: "youtube", externalId: listId, url: trimmed, extra: {} };
    }
    throw new ImportError(
      "В ссылке YouTube нет параметра list — это ссылка не на плейлист",
      "unsupported_youtube_link",
    );
  }

  // --- Deezer --------------------------------------------------------------
  if (host.endsWith("deezer.com")) {
    const m = path.match(/\/playlist\/(\d+)/);
    if (m) {
      return { platform: "deezer", externalId: m[1], url: trimmed, extra: {} };
    }
    throw new ImportError(
      "В ссылке Deezer не найден идентификатор плейлиста",
      "unsupported_deezer_link",
    );
  }

  // --- Яндекс Музыка -------------------------------------------------------
  if (host.endsWith("music.yandex.ru") || host.endsWith("music.yandex.com") ||
      host.endsWith("music.yandex.by") || host.endsWith("music.yandex.kz") ||
      host.endsWith("music.yandex.uz")) {
    const m = path.match(/\/users\/([^/]+)\/playlists\/(\d+)/);
    if (m) {
      return {
        platform: "yandex",
        externalId: `${m[1]}:${m[2]}`,
        url: trimmed,
        extra: { owner: m[1], kind: m[2] },
      };
    }
    throw new ImportError(
      "Поддерживаются ссылки вида music.yandex.ru/users/<логин>/playlists/<номер>",
      "unsupported_yandex_link",
    );
  }

  // --- SoundCloud ----------------------------------------------------------
  if (host.endsWith("soundcloud.com")) {
    const m = path.match(/^\/([^/]+)\/sets\/([^/?#]+)/);
    if (m) {
      return {
        platform: "soundcloud",
        externalId: `${m[1]}/${m[2]}`,
        url: `https://soundcloud.com/${m[1]}/sets/${m[2]}`,
        extra: {},
      };
    }
    throw new ImportError(
      "Поддерживаются ссылки на сеты SoundCloud (/sets/...)",
      "unsupported_soundcloud_link",
    );
  }

  throw new ImportError(
    "Платформа не поддерживается. Пришлите ссылку на плейлист из Spotify, Apple Music, YouTube Music, Deezer, Яндекс Музыки или SoundCloud.",
    "unsupported_platform",
  );
}
