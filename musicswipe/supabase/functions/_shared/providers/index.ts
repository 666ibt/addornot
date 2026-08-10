import { detectPlaylist, resolveShortLink, type PlaylistRef } from "./detect.ts";
import { fetchSpotifyPlaylist } from "./spotify.ts";
import { fetchAppleMusicPlaylist } from "./applemusic.ts";
import { fetchYouTubePlaylist } from "./youtube.ts";
import { fetchYandexPlaylist } from "./yandex.ts";
import { fetchSoundCloudPlaylist } from "./soundcloud.ts";
import { getPlaylist as getDeezerPlaylist } from "../deezer.ts";
import { ImportError, type ParsedPlaylist } from "../types.ts";

export { detectPlaylist, resolveShortLink };
export type { PlaylistRef };

/** Разбирает ссылку и вытаскивает треки с исходной платформы. */
export async function fetchPlaylist(rawUrl: string): Promise<{
  ref: PlaylistRef;
  playlist: ParsedPlaylist;
}> {
  const resolvedUrl = await resolveShortLink(rawUrl.trim());
  const ref = detectPlaylist(resolvedUrl);

  switch (ref.platform) {
    case "spotify":
      return { ref, playlist: await fetchSpotifyPlaylist(ref) };
    case "apple_music":
      return { ref, playlist: await fetchAppleMusicPlaylist(ref) };
    case "youtube":
      return { ref, playlist: await fetchYouTubePlaylist(ref) };
    case "yandex":
      return { ref, playlist: await fetchYandexPlaylist(ref) };
    case "soundcloud":
      return { ref, playlist: await fetchSoundCloudPlaylist(ref) };
    case "deezer": {
      const data = await getDeezerPlaylist(ref.externalId);
      if (data.tracks.length === 0) {
        throw new ImportError("Плейлист Deezer пуст", "deezer_empty", 422);
      }
      return {
        ref,
        playlist: {
          platform: "deezer",
          externalId: ref.externalId,
          title: data.title,
          coverUrl: data.coverUrl,
          ownerName: data.ownerName,
          tracks: data.tracks.map((track) => ({
            title: track.title_short ?? track.title,
            artist: track.artist?.name ?? "",
            album: track.album?.title,
            durationSec: track.duration,
          })).filter((track) => track.artist.length > 0),
        },
      };
    }
  }
}
