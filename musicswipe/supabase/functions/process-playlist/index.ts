import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { adminClient, type SupabaseClient } from "../_shared/db.ts";
import { invokeFunction, isServiceRequest, runInBackground } from "../_shared/background.ts";
import { resolveRawTracks, upsertCatalog } from "../_shared/catalog.ts";
import { buildTasteProfile, mergeWeights } from "../_shared/taste.ts";
import { generateRecommendations } from "../_shared/engine.ts";
import type { CatalogTrack, RawTrack } from "../_shared/types.ts";

/**
 * POST /functions/v1/process-playlist  { "playlist_id": "..." }   (только сервис)
 *
 * Разбирает одну порцию плейлиста и, если осталось ещё, вызывает себя снова.
 * Так снимается потолок на размер плейлиста: каждая порция получает свой
 * лимит времени выполнения, а пользователь всё это время видит прогресс.
 *
 * Функция не для клиента: она ходит под service_role и никак не проверяет,
 * чей это плейлист.
 */

const CHUNK_SIZE = 60;
// Страховка от бесконечного самовызова, если позиция вдруг перестанет расти.
const MAX_CHUNKS = 12;
const FIRST_DECK_SIZE = 30;

interface PlaylistRow {
  id: string;
  user_id: string;
  status: string;
  track_count: number;
  next_position: number;
  analyzed_count: number;
  matched_count: number;
  chunks_done: number;
}

Deno.serve(async (req) => {
  const options = preflight(req);
  if (options) return options;

  if (req.method !== "POST") {
    return errorResponse("Поддерживается только POST", 405, "method_not_allowed");
  }

  if (!isServiceRequest(req)) {
    return errorResponse("Функция вызывается только сервисом", 403, "forbidden");
  }

  let playlistId: string;
  try {
    const body = await req.json();
    playlistId = String(body?.playlist_id ?? "");
  } catch {
    return errorResponse("Ожидается { \"playlist_id\": \"...\" }", 400, "bad_request");
  }

  if (!playlistId) {
    return errorResponse("Не передан playlist_id", 400, "missing_playlist_id");
  }

  const admin = adminClient();

  // Порция обрабатывается в фоне: ответ отдаём сразу, чтобы вызывающая
  // сторона не ждала и не упиралась в свой таймаут.
  runInBackground(processChunk(admin, playlistId));

  return jsonResponse({ accepted: true, playlist_id: playlistId });
});

async function processChunk(admin: SupabaseClient, playlistId: string): Promise<void> {
  const { data, error } = await admin
    .from("playlists")
    .select("id, user_id, status, track_count, next_position, analyzed_count, matched_count, chunks_done")
    .eq("id", playlistId)
    .maybeSingle();

  if (error || !data) {
    console.error(`Плейлист ${playlistId} не найден: ${error?.message}`);
    return;
  }

  const playlist = data as PlaylistRow;

  if (playlist.status === "ready" || playlist.status === "failed") {
    return;
  }

  if (playlist.chunks_done >= MAX_CHUNKS) {
    await finish(admin, playlist, "Разбор занял слишком много порций — остановились на достигнутом.");
    return;
  }

  try {
    const { data: rows, error: rowsError } = await admin
      .from("playlist_tracks")
      .select("position, raw_title, raw_artist, raw_album, isrc")
      .eq("playlist_id", playlistId)
      .is("track_id", null)
      .gte("position", playlist.next_position)
      .order("position", { ascending: true })
      .limit(CHUNK_SIZE);

    if (rowsError) throw new Error(rowsError.message);

    const chunk = (rows ?? []) as Array<{
      position: number;
      raw_title: string;
      raw_artist: string;
      raw_album: string | null;
      isrc: string | null;
    }>;

    if (chunk.length === 0) {
      await finish(admin, playlist, null);
      return;
    }

    const rawTracks: RawTrack[] = chunk.map((row) => ({
      title: row.raw_title,
      artist: row.raw_artist,
      album: row.raw_album ?? undefined,
      isrc: row.isrc ?? undefined,
    }));

    const resolved = await resolveRawTracks(rawTracks, { concurrency: 6, albumDetail: true });

    const catalogTracks: CatalogTrack[] = resolved
      .map((item) => item.catalog)
      .filter((track): track is CatalogTrack => track !== null);

    const trackIds = await upsertCatalog(admin, catalogTracks);

    // Привязываем найденные треки к позициям плейлиста.
    let matched = 0;
    for (let i = 0; i < resolved.length; i++) {
      const catalog = resolved[i].catalog;
      if (!catalog) continue;

      const trackId = trackIds.get(catalog.provider_id);
      if (!trackId) continue;

      const { error: linkError } = await admin
        .from("playlist_tracks")
        .update({ track_id: trackId })
        .eq("playlist_id", playlistId)
        .eq("position", chunk[i].position);

      if (linkError) {
        console.warn(`Не удалось связать позицию ${chunk[i].position}: ${linkError.message}`);
        continue;
      }
      matched++;
    }

    // Вклад порции во вкусовой профиль добавляем сразу: если разбор
    // прервётся, накопленное не пропадёт.
    await addToTasteProfile(admin, playlist.user_id, catalogTracks);

    const lastPosition = chunk[chunk.length - 1].position;

    await admin
      .from("playlists")
      .update({
        next_position: lastPosition + 1,
        analyzed_count: playlist.analyzed_count + chunk.length,
        matched_count: playlist.matched_count + matched,
        chunks_done: playlist.chunks_done + 1,
      })
      .eq("id", playlistId);

    const processed = playlist.analyzed_count + chunk.length;

    if (chunk.length < CHUNK_SIZE || processed >= playlist.track_count) {
      await finish(admin, { ...playlist, matched_count: playlist.matched_count + matched }, null);
      return;
    }

    // Следующая порция — отдельным вызовом со своим лимитом времени.
    await invokeFunction("process-playlist", { playlist_id: playlistId });
  } catch (error) {
    console.error(`Разбор плейлиста ${playlistId} упал:`, error);
    await admin
      .from("playlists")
      .update({
        status: "failed",
        error_message: String((error as Error).message).slice(0, 500),
      })
      .eq("id", playlistId);
  }
}

/** Добавляет вклад порции в накопленный вкусовой профиль. */
async function addToTasteProfile(
  admin: SupabaseClient,
  userId: string,
  tracks: CatalogTrack[],
): Promise<void> {
  if (tracks.length === 0) return;

  const taste = buildTasteProfile(tracks);

  const { data: existing } = await admin
    .from("taste_profiles")
    .select("genre_weights, artist_weights, decade_weights, seed_artists, avg_bpm, avg_year, version")
    .eq("user_id", userId)
    .maybeSingle();

  const previousSeeds: string[] = existing?.seed_artists ?? [];
  const seeds = [...new Set([...previousSeeds, ...taste.seed_artists])].slice(0, 40);

  const { error } = await admin
    .from("taste_profiles")
    .upsert({
      user_id: userId,
      genre_weights: mergeWeights(existing?.genre_weights, taste.genre_weights),
      artist_weights: mergeWeights(existing?.artist_weights, taste.artist_weights),
      decade_weights: mergeWeights(existing?.decade_weights, taste.decade_weights),
      // Средние значения по порции — приближение, зато без хранения сумм.
      avg_bpm: taste.avg_bpm ?? existing?.avg_bpm ?? null,
      avg_year: taste.avg_year ?? existing?.avg_year ?? null,
      seed_artists: seeds,
      version: (existing?.version ?? 0) + 1,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });

  if (error) {
    throw new Error(`Не удалось сохранить вкусовой профиль: ${error.message}`);
  }
}

/** Завершает импорт: помечает плейлист готовым и наполняет ленту. */
async function finish(
  admin: SupabaseClient,
  playlist: PlaylistRow,
  warning: string | null,
): Promise<void> {
  await admin.from("profiles").update({ onboarded: true }).eq("id", playlist.user_id);

  let deckError: string | null = null;
  try {
    await generateRecommendations(admin, playlist.user_id, FIRST_DECK_SIZE);
  } catch (error) {
    // Плейлист разобран — это уже результат. Ленту доберём по запросу клиента.
    deckError = String((error as Error).message).slice(0, 300);
    console.error(`Не удалось собрать ленту для ${playlist.user_id}:`, error);
  }

  await admin
    .from("playlists")
    .update({
      status: "ready",
      error_message: warning ?? deckError,
    })
    .eq("id", playlist.id);
}
