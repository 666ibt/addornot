import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { adminClient, AuthError, requireUser } from "../_shared/db.ts";
import { fetchPlaylist } from "../_shared/providers/index.ts";
import { resolveRawTracks, upsertCatalog } from "../_shared/catalog.ts";
import { buildTasteProfile } from "../_shared/taste.ts";
import { generateRecommendations } from "../_shared/engine.ts";
import { ImportError, type CatalogTrack } from "../_shared/types.ts";

/**
 * POST /functions/v1/import-playlist  { "url": "https://open.spotify.com/playlist/..." }
 *
 * Полный цикл онбординга: разобрать ссылку -> вытащить треки -> сопоставить их
 * с каталогом -> построить вкусовой профиль -> набрать первую ленту карточек.
 */

// Сколько треков сохраняем и сколько из них реально анализируем.
// Анализ упирается во внешнее API, поэтому у длинных плейлистов берём
// равномерную выборку — вкус она описывает не хуже, чем весь список.
const MAX_STORED_TRACKS = 500;
const MAX_ANALYZED_TRACKS = 100;
const FIRST_DECK_SIZE = 30;

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

  let url: string;
  try {
    const body = await req.json();
    url = String(body?.url ?? "").trim();
  } catch {
    return errorResponse("Ожидается JSON вида { \"url\": \"...\" }", 400, "bad_request");
  }

  if (url.length === 0) {
    return errorResponse("Пришлите ссылку на плейлист", 400, "missing_url");
  }

  const admin = adminClient();
  let playlistId: string | null = null;

  try {
    // 1. Забираем треки с исходной платформы.
    const { ref, playlist } = await fetchPlaylist(url);

    if (playlist.tracks.length === 0) {
      throw new ImportError("В плейлисте нет треков", "empty_playlist", 422);
    }

    // 2. Заводим запись плейлиста.
    const { data: created, error: createError } = await admin
      .from("playlists")
      .insert({
        user_id: userId,
        source_url: ref.url,
        platform: ref.platform,
        external_id: ref.externalId,
        title: playlist.title,
        cover_url: playlist.coverUrl,
        owner_name: playlist.ownerName,
        status: "importing",
        track_count: playlist.tracks.length,
      })
      .select("id")
      .single();

    if (createError || !created) {
      throw new Error(`Не удалось создать плейлист: ${createError?.message}`);
    }
    playlistId = created.id as string;

    const stored = playlist.tracks.slice(0, MAX_STORED_TRACKS);

    // 3. Сопоставляем с каталогом (равномерная выборка для длинных плейлистов).
    const sampleIndexes = evenSample(stored.length, MAX_ANALYZED_TRACKS);
    const sample = sampleIndexes.map((index) => stored[index]);
    const resolved = await resolveRawTracks(sample, { concurrency: 6, albumDetail: true });

    const catalogTracks: CatalogTrack[] = resolved
      .map((item) => item.catalog)
      .filter((track): track is CatalogTrack => track !== null);

    const trackIds = await upsertCatalog(admin, catalogTracks);

    // 4. Пишем состав плейлиста.
    // resolved[i] соответствует sampleIndexes[i] — восстанавливаем связь
    // «позиция в плейлисте -> найденный трек».
    const catalogByPosition = new Map<number, CatalogTrack | null>();
    sampleIndexes.forEach((position, slot) => {
      catalogByPosition.set(position, resolved[slot]?.catalog ?? null);
    });

    const rows = stored.map((raw, index) => {
      const catalog = catalogByPosition.get(index) ?? null;
      return {
        playlist_id: playlistId,
        position: index,
        raw_title: raw.title,
        raw_artist: raw.artist,
        raw_album: raw.album ?? null,
        isrc: raw.isrc ?? null,
        track_id: catalog ? trackIds.get(catalog.provider_id) ?? null : null,
      };
    });

    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from("playlist_tracks").insert(rows.slice(i, i + 200));
      if (error) throw new Error(`Не удалось сохранить треки плейлиста: ${error.message}`);
    }

    // 5. Строим вкусовой профиль и складываем его с уже накопленным.
    const taste = buildTasteProfile(catalogTracks);

    const { data: existing } = await admin
      .from("taste_profiles")
      .select("genre_weights, artist_weights, decade_weights, seed_artists, version")
      .eq("user_id", userId)
      .maybeSingle();

    const { error: profileError } = await admin
      .from("taste_profiles")
      .upsert({
        user_id: userId,
        genre_weights: mergeWeights(existing?.genre_weights, taste.genre_weights),
        artist_weights: mergeWeights(existing?.artist_weights, taste.artist_weights),
        decade_weights: mergeWeights(existing?.decade_weights, taste.decade_weights),
        avg_bpm: taste.avg_bpm,
        avg_year: taste.avg_year,
        seed_artists: taste.seed_artists,
        version: (existing?.version ?? 0) + 1,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    if (profileError) {
      throw new Error(`Не удалось сохранить вкусовой профиль: ${profileError.message}`);
    }

    await admin.from("profiles").update({ onboarded: true }).eq("id", userId);

    // 6. Первая пачка карточек.
    const deck = await generateRecommendations(admin, userId, FIRST_DECK_SIZE);

    const matched = catalogTracks.length;
    await admin
      .from("playlists")
      .update({ status: "ready", matched_count: matched, error_message: null })
      .eq("id", playlistId);

    return jsonResponse({
      playlist: {
        id: playlistId,
        platform: ref.platform,
        title: playlist.title,
        cover_url: playlist.coverUrl,
        owner_name: playlist.ownerName,
        track_count: stored.length,
        analyzed_count: sample.length,
        matched_count: matched,
      },
      taste: {
        top_genres: Object.entries(taste.genre_weights)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([genre, weight]) => ({ genre, weight })),
        avg_year: taste.avg_year,
        avg_bpm: taste.avg_bpm,
      },
      deck_prepared: deck.inserted,
    });
  } catch (error) {
    if (playlistId) {
      await admin
        .from("playlists")
        .update({ status: "failed", error_message: String((error as Error).message).slice(0, 500) })
        .eq("id", playlistId);
    }

    if (error instanceof ImportError) {
      return errorResponse(error.message, error.status, error.code);
    }

    console.error("import-playlist упал:", error);
    return errorResponse(
      `Не удалось импортировать плейлист: ${(error as Error).message}`,
      500,
      "import_failed",
    );
  }
});

/** Равномерная выборка count индексов из диапазона 0..total-1. */
function evenSample(total: number, count: number): number[] {
  if (total <= count) return Array.from({ length: total }, (_, i) => i);
  const step = total / count;
  const indexes: number[] = [];
  for (let i = 0; i < count; i++) {
    indexes.push(Math.min(total - 1, Math.floor(i * step)));
  }
  return indexes;
}

/** Складывает старые и новые веса: импорт дополняет профиль, а не затирает его. */
function mergeWeights(
  existing: unknown,
  incoming: Record<string, number>,
): Record<string, number> {
  const base = (existing && typeof existing === "object" ? existing : {}) as Record<string, number>;
  const merged: Record<string, number> = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    merged[key] = Math.round(((merged[key] ?? 0) + value) * 10_000) / 10_000;
  }
  return merged;
}
