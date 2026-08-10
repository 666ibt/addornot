import { fetchJson, fetchText, extractScriptJson } from "../http.ts";
import { asNumber, asString, collectNodes } from "../jsonwalk.ts";
import { ImportError, type ParsedPlaylist, type RawTrack } from "../types.ts";
import type { PlaylistRef } from "./detect.ts";

/**
 * Apple Music.
 *
 * Основной путь — Apple Music API с developer token (секрет
 * APPLE_MUSIC_DEVELOPER_TOKEN, JWT, подписанный ключом MusicKit).
 * Запасной путь — публичная страница плейлиста: Apple встраивает данные
 * в <script id="serialized-server-data">, откуда мы вытаскиваем пары
 * «название + исполнитель».
 */
export async function fetchAppleMusicPlaylist(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const token = Deno.env.get("APPLE_MUSIC_DEVELOPER_TOKEN");

  if (token) {
    try {
      return await viaApi(ref, token);
    } catch (error) {
      console.warn("Apple Music API не сработал, пробуем страницу:", error);
    }
  }

  return await viaPublicPage(ref);
}

interface AppleTrackAttributes {
  name?: string;
  artistName?: string;
  albumName?: string;
  durationInMillis?: number;
  isrc?: string;
}

interface ApplePlaylistResponse {
  data?: Array<{
    attributes?: { name?: string; artwork?: { url?: string }; curatorName?: string };
    relationships?: {
      tracks?: {
        data?: Array<{ attributes?: AppleTrackAttributes }>;
        next?: string;
      };
    };
  }>;
}

async function viaApi(ref: PlaylistRef, token: string): Promise<ParsedPlaylist> {
  const storefront = ref.extra.storefront || "us";
  const headers = { Authorization: `Bearer ${token}` };
  const base = "https://api.music.apple.com";

  const head = await fetchJson<ApplePlaylistResponse>(
    `${base}/v1/catalog/${storefront}/playlists/${ref.externalId}`,
    { headers },
  );

  const playlist = head.data?.[0];
  if (!playlist) {
    throw new ImportError("Плейлист Apple Music не найден", "apple_not_found", 404);
  }

  const tracks: RawTrack[] = [];
  const pushAll = (items: Array<{ attributes?: AppleTrackAttributes }> | undefined) => {
    for (const item of items ?? []) {
      const attrs = item.attributes;
      if (!attrs?.name || !attrs.artistName) continue;
      tracks.push({
        title: attrs.name,
        artist: attrs.artistName,
        album: attrs.albumName,
        isrc: attrs.isrc,
        durationSec: attrs.durationInMillis
          ? Math.round(attrs.durationInMillis / 1000)
          : undefined,
      });
    }
  };

  pushAll(playlist.relationships?.tracks?.data);

  let next = playlist.relationships?.tracks?.next;
  while (next && tracks.length < 500) {
    const page = await fetchJson<{
      data?: Array<{ attributes?: AppleTrackAttributes }>;
      next?: string;
    }>(`${base}${next}`, { headers });
    pushAll(page.data);
    next = page.next;
  }

  const artwork = playlist.attributes?.artwork?.url
    ?.replace("{w}", "600")
    .replace("{h}", "600")
    .replace("{f}", "jpg") ?? null;

  return {
    platform: "apple_music",
    externalId: ref.externalId,
    title: playlist.attributes?.name ?? null,
    coverUrl: artwork,
    ownerName: playlist.attributes?.curatorName ?? null,
    tracks,
  };
}

async function viaPublicPage(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const storefront = ref.extra.storefront || "us";
  const url = `https://music.apple.com/${storefront}/playlist/playlist/${ref.externalId}`;
  const html = await fetchText(url);

  const raw = extractScriptJson<unknown>(html, "serialized-server-data") ??
    extractScriptJson<unknown>(html, "shoebox-media-api-cache-amp-music");

  // Apple иногда кладёт в script строку с JSON внутри JSON.
  const payload = typeof raw === "string" ? safeParse(raw) : raw;

  if (!payload) {
    throw new ImportError(
      "Не удалось прочитать плейлист Apple Music. Добавьте APPLE_MUSIC_DEVELOPER_TOKEN " +
        "в секреты Supabase или проверьте, что плейлист публичный.",
      "apple_scrape_failed",
      502,
    );
  }

  const nodes = collectNodes(payload, (node) =>
    typeof node.name === "string" && typeof node.artistName === "string");

  const tracks: RawTrack[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const title = asString(node.name);
    const artist = asString(node.artistName);
    if (!title || !artist) continue;
    const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const durationMs = asNumber(node.durationInMillis);
    tracks.push({
      title,
      artist,
      album: asString(node.albumName),
      isrc: asString(node.isrc),
      durationSec: durationMs ? Math.round(durationMs / 1000) : undefined,
    });
  }

  if (tracks.length === 0) {
    throw new ImportError(
      "В плейлисте Apple Music не нашлось треков — возможно, он приватный.",
      "apple_empty",
      422,
    );
  }

  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  const coverMatch = html.match(/<meta property="og:image" content="([^"]+)"/);

  return {
    platform: "apple_music",
    externalId: ref.externalId,
    title: titleMatch?.[1] ?? null,
    coverUrl: coverMatch?.[1] ?? null,
    ownerName: null,
    tracks: tracks.slice(0, 500),
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
