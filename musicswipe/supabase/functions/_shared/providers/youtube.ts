import { extractJsonAfter, fetchJson, fetchText } from "../http.ts";
import { asString, collectNodes } from "../jsonwalk.ts";
import { ImportError, type ParsedPlaylist, type RawTrack } from "../types.ts";
import type { PlaylistRef } from "./detect.ts";

/**
 * YouTube / YouTube Music.
 *
 * С ключом YOUTUBE_API_KEY используем Data API v3. Без ключа читаем публичную
 * страницу плейлиста и разбираем ytInitialData.
 *
 * У YouTube нет отдельных полей «исполнитель» и «название» — есть заголовок
 * ролика. Поэтому заголовки прогоняем через эвристику splitVideoTitle().
 */
export async function fetchYouTubePlaylist(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const apiKey = Deno.env.get("YOUTUBE_API_KEY");

  if (apiKey) {
    try {
      return await viaDataApi(ref, apiKey);
    } catch (error) {
      console.warn("YouTube Data API не сработал, пробуем страницу:", error);
    }
  }

  return await viaPublicPage(ref);
}

interface YouTubeItemsPage {
  items?: Array<{
    snippet?: {
      title?: string;
      videoOwnerChannelTitle?: string;
      channelTitle?: string;
    };
  }>;
  nextPageToken?: string;
}

async function viaDataApi(ref: PlaylistRef, apiKey: string): Promise<ParsedPlaylist> {
  const tracks: RawTrack[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", ref.externalId);
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await fetchJson<YouTubeItemsPage>(url.toString());

    for (const item of page.items ?? []) {
      const rawTitle = item.snippet?.title;
      if (!rawTitle || rawTitle === "Deleted video" || rawTitle === "Private video") continue;
      const channel = item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle;
      const parsed = splitVideoTitle(rawTitle, channel);
      if (parsed) tracks.push(parsed);
    }

    pageToken = page.nextPageToken;
  } while (pageToken && tracks.length < 500);

  const meta = await fetchPlaylistMeta(ref.externalId, apiKey);

  return {
    platform: "youtube",
    externalId: ref.externalId,
    title: meta.title,
    coverUrl: meta.coverUrl,
    ownerName: meta.ownerName,
    tracks,
  };
}

async function fetchPlaylistMeta(playlistId: string, apiKey: string) {
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", playlistId);
    url.searchParams.set("key", apiKey);
    const data = await fetchJson<{
      items?: Array<{
        snippet?: {
          title?: string;
          channelTitle?: string;
          thumbnails?: { high?: { url?: string } };
        };
      }>;
    }>(url.toString());
    const snippet = data.items?.[0]?.snippet;
    return {
      title: snippet?.title ?? null,
      ownerName: snippet?.channelTitle ?? null,
      coverUrl: snippet?.thumbnails?.high?.url ?? null,
    };
  } catch {
    return { title: null, ownerName: null, coverUrl: null };
  }
}

async function viaPublicPage(ref: PlaylistRef): Promise<ParsedPlaylist> {
  const html = await fetchText(
    `https://www.youtube.com/playlist?list=${encodeURIComponent(ref.externalId)}&hl=en`,
  );
  const initialData = extractJsonAfter<unknown>(html, "var ytInitialData =") ??
    extractJsonAfter<unknown>(html, 'window["ytInitialData"] =');

  if (!initialData) {
    throw new ImportError(
      "Не удалось прочитать плейлист YouTube. Добавьте YOUTUBE_API_KEY в секреты Supabase " +
        "или проверьте, что плейлист публичный.",
      "youtube_scrape_failed",
      502,
    );
  }

  const renderers = collectNodes(
    initialData,
    (node) => typeof node.playlistVideoRenderer === "object" && node.playlistVideoRenderer !== null,
  );

  const tracks: RawTrack[] = [];
  for (const wrapper of renderers) {
    const renderer = wrapper.playlistVideoRenderer as Record<string, unknown>;
    const title = readRuns(renderer.title);
    const channel = readRuns(renderer.shortBylineText);
    if (!title) continue;
    const parsed = splitVideoTitle(title, channel);
    if (parsed) tracks.push(parsed);
  }

  if (tracks.length === 0) {
    throw new ImportError(
      "В плейлисте YouTube не нашлось видео — возможно, он приватный.",
      "youtube_empty",
      422,
    );
  }

  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);

  return {
    platform: "youtube",
    externalId: ref.externalId,
    title: titleMatch?.[1] ?? null,
    coverUrl: null,
    ownerName: null,
    tracks: tracks.slice(0, 500),
  };
}

function readRuns(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  const simple = asString(node.simpleText);
  if (simple) return simple;
  const runs = node.runs;
  if (Array.isArray(runs)) {
    const text = runs
      .map((run) => (run && typeof run === "object" ? asString((run as Record<string, unknown>).text) : undefined))
      .filter(Boolean)
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

const NOISE = /\s*[\(\[][^\)\]]*(official|video|audio|lyrics?|hd|4k|mv|m\/v|visualizer|clip)[^\)\]]*[\)\]]/gi;

/**
 * «Artist - Title (Official Video)» -> { artist: "Artist", title: "Title" }.
 * Если разделителя нет, берём исполнителя из названия канала
 * («Artist - Topic» — служебные каналы YouTube Music).
 */
export function splitVideoTitle(rawTitle: string, channel?: string): RawTrack | null {
  const cleaned = rawTitle.replace(NOISE, "").replace(/\s{2,}/g, " ").trim();
  if (cleaned.length === 0) return null;

  const separators = [" - ", " – ", " — ", " ~ ", " | "];
  for (const separator of separators) {
    const index = cleaned.indexOf(separator);
    if (index > 0) {
      const artist = cleaned.slice(0, index).trim();
      const title = cleaned.slice(index + separator.length).trim();
      if (artist && title) return { artist, title };
    }
  }

  const topicArtist = channel?.replace(/\s*-\s*Topic$/i, "").trim();
  if (topicArtist && topicArtist !== channel) {
    return { artist: topicArtist, title: cleaned };
  }
  if (channel && channel.trim().length > 0) {
    return { artist: channel.trim(), title: cleaned };
  }
  return null;
}
