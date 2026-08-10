import { fetchJson, fetchText, extractScriptJson } from "../http.ts";
import { collectNodes, asNumber, asString } from "../jsonwalk.ts";
import { ImportError, type ParsedPlaylist, type RawTrack } from "../types.ts";
import type { PlaylistRef } from "./detect.ts";

/**
 * Spotify.
 *
 * Основной путь — Web API по client credentials (нужны SPOTIFY_CLIENT_ID и
 * SPOTIFY_CLIENT_SECRET). Если ключей нет, читаем публичную embed-страницу:
 * она отдаёт список треков в <script id="__NEXT_DATA__">. Второй путь работает
 * только для публичных плейлистов и ограничен первой сотней треков.
 */
export async function fetchSpotifyPlaylist(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const clientId = Deno.env.get("SPOTIFY_CLIENT_ID");
  const clientSecret = Deno.env.get("SPOTIFY_CLIENT_SECRET");

  if (clientId && clientSecret) {
    try {
      return await viaWebApi(ref, clientId, clientSecret);
    } catch (error) {
      console.warn("Spotify Web API не сработал, пробуем embed:", error);
    }
  }

  return await viaEmbedPage(ref);
}

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const auth = btoa(`${clientId}:${clientSecret}`);

  const data = await fetchJson<{ access_token?: string }>(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
  );

  if (!data.access_token) {
    throw new ImportError("Spotify не выдал токен доступа", "spotify_auth_failed", 502);
  }
  return data.access_token;
}

interface SpotifyPlaylistResponse {
  name?: string;
  images?: Array<{ url?: string }>;
  owner?: { display_name?: string };
}

interface SpotifyTracksPage {
  items?: Array<{
    track?: {
      name?: string;
      duration_ms?: number;
      external_ids?: { isrc?: string };
      album?: { name?: string };
      artists?: Array<{ name?: string }>;
    } | null;
  }>;
  next?: string | null;
}

async function viaWebApi(
  ref: PlaylistRef,
  clientId: string,
  clientSecret: string,
): Promise<ParsedPlaylist> {
  const token = await getAccessToken(clientId, clientSecret);
  const headers = { Authorization: `Bearer ${token}` };

  const head = await fetchJson<SpotifyPlaylistResponse>(
    `https://api.spotify.com/v1/playlists/${ref.externalId}?fields=name,images,owner(display_name)`,
    { headers },
  );

  const tracks: RawTrack[] = [];
  let next: string | null =
    `https://api.spotify.com/v1/playlists/${ref.externalId}/tracks` +
    `?limit=100&fields=next,items(track(name,duration_ms,album(name),artists(name),external_ids(isrc)))`;

  while (next && tracks.length < 500) {
    const page: SpotifyTracksPage = await fetchJson<SpotifyTracksPage>(next, { headers });
    for (const item of page.items ?? []) {
      const track = item.track;
      if (!track?.name) continue;
      const artist = (track.artists ?? []).map((a) => a.name).filter(Boolean).join(", ");
      if (!artist) continue;
      tracks.push({
        title: track.name,
        artist,
        album: track.album?.name,
        isrc: track.external_ids?.isrc,
        durationSec: track.duration_ms ? Math.round(track.duration_ms / 1000) : undefined,
      });
    }
    next = page.next ?? null;
  }

  return {
    platform: "spotify",
    externalId: ref.externalId,
    title: head.name ?? null,
    coverUrl: head.images?.[0]?.url ?? null,
    ownerName: head.owner?.display_name ?? null,
    tracks,
  };
}

async function viaEmbedPage(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const html = await fetchText(`https://open.spotify.com/embed/playlist/${ref.externalId}`);
  const nextData = extractScriptJson<unknown>(html, "__NEXT_DATA__");

  if (!nextData) {
    throw new ImportError(
      "Не удалось прочитать плейлист Spotify. Убедитесь, что он публичный, " +
        "или добавьте SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET в секреты Supabase.",
      "spotify_scrape_failed",
      502,
    );
  }

  // Узел трека в embed-данных: { uri: "spotify:track:...", title, subtitle }
  const nodes = collectNodes(nextData, (node) =>
    typeof node.uri === "string" &&
    (node.uri as string).startsWith("spotify:track:") &&
    typeof node.title === "string");

  const tracks: RawTrack[] = [];
  for (const node of nodes) {
    const title = asString(node.title);
    const artist = asString(node.subtitle) ?? asString(node.artistName);
    if (!title || !artist) continue;
    const durationMs = asNumber(node.duration);
    tracks.push({
      title,
      artist,
      durationSec: durationMs ? Math.round(durationMs / 1000) : undefined,
    });
  }

  if (tracks.length === 0) {
    throw new ImportError(
      "В плейлисте Spotify не нашлось треков — возможно, он приватный.",
      "spotify_empty",
      422,
    );
  }

  const entity = collectNodes(nextData, (node) =>
    typeof node.uri === "string" && (node.uri as string).startsWith("spotify:playlist:"))[0];

  return {
    platform: "spotify",
    externalId: ref.externalId,
    title: entity ? asString(entity.title) ?? asString(entity.name) ?? null : null,
    coverUrl: null,
    ownerName: entity ? asString(entity.subtitle) ?? null : null,
    tracks,
  };
}
