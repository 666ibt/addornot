import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { adminClient, AuthError, requireUser } from "../_shared/db.ts";
import { buildTasteProfile } from "../_shared/taste.ts";
import { generateRecommendations } from "../_shared/engine.ts";
import type { CatalogTrack } from "../_shared/types.ts";

/**
 * POST /functions/v1/rebuild-profile
 *
 * Пересобирает вкусовой профиль с нуля по уже сохранённым данным:
 * треки импортированных плейлистов + лайки (лайкнутый трек весит вдвое).
 * Внешние API не дёргаются — только то, что уже есть в каталоге.
 *
 * Нужна, когда профиль «поплыл» после серии случайных свайпов или после
 * нескольких импортов, чьи веса сложились.
 */
Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method !== "POST") {
    return errorResponse("Поддерживается только POST", 405, "method_not_allowed");
  }

  let userId: string;
  try {
    userId = (await requireUser(req)).id;
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.message, 401, "unauthorized");
    throw error;
  }

  const admin = adminClient();

  try {
    const { data: playlistRows, error: playlistError } = await admin
      .from("playlist_tracks")
      .select("tracks!inner(*, artists(provider_id, picture_url)), playlists!inner(user_id)")
      .eq("playlists.user_id", userId)
      .limit(1000);

    if (playlistError) throw new Error(playlistError.message);

    const { data: likedRows, error: likedError } = await admin
      .from("swipes")
      .select("direction, tracks!inner(*, artists(provider_id, picture_url))")
      .eq("user_id", userId)
      .in("direction", ["like", "superlike"])
      .limit(1000);

    if (likedError) throw new Error(likedError.message);

    const corpus: CatalogTrack[] = [];
    for (const row of playlistRows ?? []) {
      const track = toCatalogTrack(row.tracks);
      if (track) corpus.push(track);
    }
    for (const row of likedRows ?? []) {
      const track = toCatalogTrack(row.tracks);
      if (!track) continue;
      // Лайк — более сильный сигнал, чем «просто был в плейлисте».
      const repeats = row.direction === "superlike" ? 3 : 2;
      for (let i = 0; i < repeats; i++) corpus.push(track);
    }

    if (corpus.length === 0) {
      return errorResponse(
        "Нечего пересобирать: нет ни импортированных плейлистов, ни лайков.",
        409,
        "empty_corpus",
      );
    }

    const taste = buildTasteProfile(corpus);

    const { error: upsertError } = await admin
      .from("taste_profiles")
      .upsert({
        user_id: userId,
        genre_weights: taste.genre_weights,
        artist_weights: taste.artist_weights,
        decade_weights: taste.decade_weights,
        avg_bpm: taste.avg_bpm,
        avg_year: taste.avg_year,
        seed_artists: taste.seed_artists,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    if (upsertError) throw new Error(upsertError.message);

    // Старая очередь построена по прежнему профилю — выбрасываем всё,
    // что пользователь ещё не успел посмотреть.
    const { data: swiped } = await admin
      .from("swipes")
      .select("track_id")
      .eq("user_id", userId);

    const swipedIds = (swiped ?? []).map((row: { track_id: string }) => row.track_id);
    let cleanup = admin.from("recommendations").delete().eq("user_id", userId);
    if (swipedIds.length > 0) {
      cleanup = cleanup.not("track_id", "in", `(${swipedIds.join(",")})`);
    }
    await cleanup;

    const deck = await generateRecommendations(admin, userId, 30);

    return jsonResponse({
      corpus_size: corpus.length,
      top_genres: Object.entries(taste.genre_weights)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([genre, weight]) => ({ genre, weight })),
      deck_prepared: deck.inserted,
    });
  } catch (error) {
    console.error("rebuild-profile упал:", error);
    return errorResponse(
      `Не удалось пересобрать профиль: ${(error as Error).message}`,
      500,
      "rebuild_failed",
    );
  }
});

/** Строка таблицы tracks -> CatalogTrack (нужны только поля, влияющие на вкус). */
// deno-lint-ignore no-explicit-any
function toCatalogTrack(row: any): CatalogTrack | null {
  if (!row || typeof row !== "object") return null;
  return {
    provider: "deezer",
    provider_id: String(row.provider_id ?? ""),
    isrc: row.isrc ?? null,
    title: row.title ?? "",
    artist_name: row.artist_name ?? "",
    artist_provider_id: row.artists?.provider_id ? String(row.artists.provider_id) : null,
    artist_picture_url: row.artists?.picture_url ?? null,
    album_title: row.album_title ?? null,
    artwork_url: row.artwork_url ?? null,
    preview_url: row.preview_url ?? null,
    external_url: row.external_url ?? null,
    duration_sec: row.duration_sec ?? null,
    release_year: row.release_year ?? null,
    bpm: row.bpm != null ? Number(row.bpm) : null,
    explicit: Boolean(row.explicit),
    genres: Array.isArray(row.genres) ? row.genres : [],
    popularity: row.popularity ?? 0,
  };
}
