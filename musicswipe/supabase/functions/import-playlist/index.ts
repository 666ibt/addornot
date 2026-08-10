import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { adminClient, AuthError, requireUser } from "../_shared/db.ts";
import { invokeFunction, runInBackground } from "../_shared/background.ts";
import { fetchPlaylist } from "../_shared/providers/index.ts";
import { ImportError } from "../_shared/types.ts";

/**
 * POST /functions/v1/import-playlist  { "url": "https://open.spotify.com/playlist/..." }
 *
 * Забирает плейлист с исходной платформы, сохраняет его состав и сразу
 * отвечает клиенту. Сопоставление с каталогом идёт отдельно, порциями
 * (см. process-playlist): оно упирается во внешнее API и на большом плейлисте
 * заведомо не уложится в один запрос.
 *
 * Клиент получает id плейлиста и следит за ходом разбора через RPC
 * playlist_progress().
 */

const MAX_STORED_TRACKS = 500;

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
    // 1. Забираем треки с исходной платформы. Это единственная медленная
    //    часть, которую нельзя отложить: без списка треков нечего показывать.
    const { ref, playlist } = await fetchPlaylist(url);

    if (playlist.tracks.length === 0) {
      throw new ImportError("В плейлисте нет треков", "empty_playlist", 422);
    }

    const stored = playlist.tracks.slice(0, MAX_STORED_TRACKS);

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
        track_count: stored.length,
      })
      .select("id")
      .single();

    if (createError || !created) {
      throw new Error(`Не удалось создать плейлист: ${createError?.message}`);
    }
    playlistId = created.id as string;

    // 3. Сохраняем состав целиком. Даже несопоставленные треки полезны:
    //    по ним лента отсеивает то, что у пользователя уже есть.
    const rows = stored.map((raw, index) => ({
      playlist_id: playlistId,
      position: index,
      raw_title: raw.title,
      raw_artist: raw.artist,
      raw_album: raw.album ?? null,
      isrc: raw.isrc ?? null,
      track_id: null,
    }));

    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from("playlist_tracks").insert(rows.slice(i, i + 200));
      if (error) throw new Error(`Не удалось сохранить треки плейлиста: ${error.message}`);
    }

    // 4. Разбор уходит в фон, ответ отдаём сейчас.
    const startedId = playlistId;
    runInBackground(invokeFunction("process-playlist", { playlist_id: startedId }));

    return jsonResponse({
      playlist: {
        id: playlistId,
        platform: ref.platform,
        title: playlist.title,
        cover_url: playlist.coverUrl,
        owner_name: playlist.ownerName,
        track_count: stored.length,
        status: "importing",
      },
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
