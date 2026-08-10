#!/usr/bin/env node
/**
 * Сквозная проверка бэкенда MusicSwipe без Xcode и симулятора.
 *
 * Проходит тот же путь, что и приложение: вход -> импорт плейлиста -> лента ->
 * свайпы -> лайки -> догрузка рекомендаций, и проверяет инварианты, на которых
 * держится экран свайпов.
 *
 * Запуск (нужен Node 18+):
 *
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   node supabase/scripts/smoke-test.mjs "https://www.deezer.com/playlist/1313621735"
 *
 * По умолчанию заводит анонимного пользователя (Authentication -> Anonymous
 * sign-ins должен быть включён). Чтобы войти обычным аккаунтом, задайте
 * TEST_EMAIL и TEST_PASSWORD.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const PLAYLIST_URL = process.argv[2] ?? "https://www.deezer.com/playlist/1313621735";

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Задайте SUPABASE_URL и SUPABASE_ANON_KEY в переменных окружения.");
  process.exit(2);
}

// --- вывод -------------------------------------------------------------------

const results = [];
let indent = "";

function step(name) {
  process.stdout.write(`\n▸ ${name}\n`);
  indent = "  ";
}

function pass(message) {
  results.push(true);
  console.log(`${indent}✓ ${message}`);
}

function fail(message) {
  results.push(false);
  console.log(`${indent}✗ ${message}`);
}

function check(condition, okMessage, failMessage) {
  condition ? pass(okMessage) : fail(failMessage ?? okMessage);
  return condition;
}

function info(message) {
  console.log(`${indent}  ${message}`);
}

// --- HTTP --------------------------------------------------------------------

let accessToken = null;

async function call(path, { method = "POST", body, auth = true } = {}) {
  const headers = { apikey: ANON_KEY, "Content-Type": "application/json" };
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const started = Date.now();

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // Сетевую ошибку возвращаем как обычный неуспех: скрипт должен
    // сообщить, что именно не открылось, а не падать стектрейсом.
    const cause = error.cause?.message ?? error.message;
    return { status: 0, ok: false, payload: { message: `сеть недоступна (${cause})` }, ms: Date.now() - started };
  }

  const text = await response.text();
  let payload = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  return { status: response.status, ok: response.ok, payload, ms: Date.now() - started };
}

function describeError(result) {
  const payload = result.payload;
  if (payload?.error?.message) return payload.error.message;
  if (payload?.message) return payload.message;
  if (payload?.error_description) return payload.error_description;
  if (payload?.msg) return payload.msg;
  if (typeof payload === "string" && payload.length > 0) return payload.slice(0, 200);
  return `HTTP ${result.status}`;
}

/** Та же нормализация, что в supabase/functions/_shared/matching.ts. */
function trackKey(artist, title) {
  const normalize = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/[’'`]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();

  const cleanTitle = String(title ?? "")
    .replace(/\s*[\(\[](feat\.?|ft\.?|with)[^\)\]]*[\)\]]/gi, "")
    .replace(/\s*-\s*(remaster(ed)?|single version|album version)\b.*$/gi, "")
    .trim();

  const primary = String(artist ?? "").split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0] ?? artist;
  return `${normalize(primary)}|${normalize(cleanTitle)}`;
}

// --- сценарий ----------------------------------------------------------------

async function signIn() {
  step("Вход");

  const email = process.env.TEST_EMAIL;
  const password = process.env.TEST_PASSWORD;

  const result = email && password
    ? await call("/auth/v1/token?grant_type=password", { body: { email, password }, auth: false })
    : await call("/auth/v1/signup", { body: {}, auth: false });

  if (!result.ok || !result.payload?.access_token) {
    fail(`не удалось войти: ${describeError(result)}`);
    if (!email) {
      info("для анонимного входа включите Authentication -> Sign In / Providers -> Anonymous sign-ins");
      info("или задайте TEST_EMAIL и TEST_PASSWORD");
    }
    return false;
  }

  accessToken = result.payload.access_token;
  pass(email ? `вошли как ${email}` : "анонимный пользователь создан");
  info(`user_id: ${result.payload.user?.id}`);
  return true;
}

async function importPlaylist() {
  step(`Импорт плейлиста (${PLAYLIST_URL})`);

  const started = await call("/functions/v1/import-playlist", { body: { url: PLAYLIST_URL } });

  if (!started.ok) {
    fail(`импорт не запустился: ${describeError(started)}`);
    return null;
  }

  const playlist = started.payload.playlist;
  pass(`запрос принят за ${(started.ms / 1000).toFixed(1)} с`);
  info(`платформа: ${playlist.platform}, треков: ${playlist.track_count}`);

  // Разбор идёт в фоне порциями — ждём, опрашивая прогресс.
  info("ждём разбор…");

  const deadlineAt = Date.now() + 8 * 60 * 1000;
  let progress = null;
  let lastAnalyzed = -1;

  while (Date.now() < deadlineAt) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const result = await call("/rest/v1/rpc/playlist_progress", {
      body: { p_playlist_id: playlist.id },
    });

    if (!result.ok) {
      fail(`playlist_progress вернул ошибку: ${describeError(result)}`);
      return null;
    }

    progress = result.payload[0] ?? null;
    if (!progress) {
      fail("плейлист не найден — проверьте RLS");
      return null;
    }

    if (progress.analyzed_count !== lastAnalyzed) {
      info(`разобрано ${progress.analyzed_count} из ${progress.track_count}`);
      lastAnalyzed = progress.analyzed_count;
    }

    if (progress.status === "ready" || progress.status === "failed") break;
  }

  if (!progress || progress.status === "importing") {
    fail("разбор не завершился за отведённое время");
    return null;
  }

  if (progress.status === "failed") {
    fail(`разбор упал: ${progress.error_message}`);
    return null;
  }

  pass("разбор завершён");

  check(
    progress.analyzed_count >= progress.track_count,
    `проанализированы все ${progress.track_count} треков`,
    `проанализировано только ${progress.analyzed_count} из ${progress.track_count}`,
  );

  check(
    progress.matched_count > 0,
    `распознано ${progress.matched_count} треков`,
    "ни один трек не удалось сопоставить с каталогом",
  );

  const taste = await call("/rest/v1/rpc/taste_summary", { body: {} });
  if (taste.ok) {
    check(
      taste.payload.length > 0,
      `жанры определены: ${taste.payload.slice(0, 4).map((row) => row.genre).join(", ")}`,
      "вкусовой профиль пуст — рекомендации пойдут только по исполнителям",
    );
  }

  return progress;
}

async function fetchDeck(limit = 10) {
  const result = await call("/rest/v1/rpc/get_deck", { body: { p_limit: limit } });
  if (!result.ok) {
    fail(`get_deck вернул ошибку: ${describeError(result)}`);
    return null;
  }
  return result.payload;
}

async function checkDeck() {
  step("Лента");

  let deck = await fetchDeck();

  // Ленту наполняет тот же фоновый процесс — она может появиться чуть позже.
  for (let attempt = 0; attempt < 5 && deck && deck.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    deck = await fetchDeck();
  }

  if (!deck) return null;

  if (!check(deck.length > 0, `в колоде ${deck.length} карточек`, "колода пуста")) {
    return null;
  }

  check(
    deck.every((track) => track.preview_url),
    "у всех карточек есть превью для прослушивания",
    "есть карточки без превью — их нельзя послушать",
  );

  check(
    new Set(deck.map((track) => track.id)).size === deck.length,
    "дубликатов в колоде нет",
    "в колоде встречаются повторы",
  );

  const artistCounts = new Map();
  for (const track of deck) {
    const key = track.artist_name.toLowerCase();
    artistCounts.set(key, (artistCounts.get(key) ?? 0) + 1);
  }
  check(
    [...artistCounts.values()].every((count) => count <= 2),
    "на исполнителя приходится не больше двух карточек",
    "один исполнитель занял больше двух карточек подряд",
  );

  check(
    deck.some((track) => track.reason?.kind),
    "карточки объясняют, почему попали в ленту",
    "у карточек нет объяснения подбора",
  );

  // Ключевой инвариант: в ленте не должно быть того, что уже есть в плейлисте.
  const playlistTracks = await call(
    "/rest/v1/playlist_tracks?select=raw_artist,raw_title&limit=1000",
    { method: "GET" },
  );

  if (playlistTracks.ok && Array.isArray(playlistTracks.payload)) {
    const known = new Set(
      playlistTracks.payload.map((row) => trackKey(row.raw_artist, row.raw_title)),
    );
    const collisions = deck.filter((track) => known.has(trackKey(track.artist_name, track.title)));

    check(
      collisions.length === 0,
      "в ленте нет треков из вашего плейлиста",
      `лента предлагает то, что уже есть в плейлисте: ${
        collisions.slice(0, 3).map((t) => `${t.artist_name} — ${t.title}`).join("; ")
      }`,
    );
  }

  info(`первая карточка: ${deck[0].artist_name} — ${deck[0].title}`);
  return deck;
}

async function checkSwipes(deck) {
  step("Свайпы");

  const liked = deck[0];
  const passed = deck[1] ?? null;

  const likeResult = await call("/rest/v1/rpc/record_swipe", {
    body: { p_track_id: liked.id, p_direction: "like", p_listened_ms: 12000 },
  });
  if (!check(likeResult.ok, "лайк записан", `лайк не записался: ${describeError(likeResult)}`)) {
    return null;
  }

  if (passed) {
    const passResult = await call("/rest/v1/rpc/record_swipe", {
      body: { p_track_id: passed.id, p_direction: "pass", p_listened_ms: 1500 },
    });
    check(passResult.ok, "пропуск записан", `пропуск не записался: ${describeError(passResult)}`);
  }

  const nextDeck = await fetchDeck();
  if (nextDeck) {
    const ids = new Set(nextDeck.map((track) => track.id));
    check(
      !ids.has(liked.id) && (!passed || !ids.has(passed.id)),
      "оценённые треки больше не показываются",
      "уже оценённый трек снова оказался в ленте",
    );
  }

  return liked;
}

async function checkLikes(liked) {
  step("Любимое и вкусовой профиль");

  const likesResult = await call("/rest/v1/rpc/liked_tracks", {
    body: { p_limit: 50, p_offset: 0 },
  });

  if (likesResult.ok) {
    const found = likesResult.payload.some((track) => track.id === liked.id);
    check(found, `лайкнутый трек в списке (всего ${likesResult.payload.length})`, "лайк не попал в список");
  } else {
    fail(`liked_tracks вернул ошибку: ${describeError(likesResult)}`);
  }

  const tasteResult = await call("/rest/v1/rpc/taste_summary", { body: {} });
  if (tasteResult.ok) {
    check(
      tasteResult.payload.length > 0,
      `вкусовой профиль: ${tasteResult.payload.slice(0, 3).map((row) => row.genre).join(", ")}`,
      "вкусовой профиль пуст",
    );
  } else {
    fail(`taste_summary вернул ошибку: ${describeError(tasteResult)}`);
  }
}

async function checkRefill() {
  step("Догрузка рекомендаций");

  const result = await call("/functions/v1/recommend", { body: { limit: 10 } });
  if (!result.ok) {
    fail(`recommend вернул ошибку: ${describeError(result)}`);
    return;
  }

  pass(`recommend отработал за ${(result.ms / 1000).toFixed(1)} с`);
  info(`добавлено записей: ${result.payload.inserted}${result.payload.reason ? ` (${result.payload.reason})` : ""}`);
}

async function checkIsolation() {
  step("Изоляция данных (RLS)");

  // Читаем таблицы напрямую под тем же токеном: свои строки видны,
  // чужих быть не должно. Полностью проверить это одним пользователем нельзя,
  // но пустой ответ без токена — уже сигнал, что политики включены.
  const savedToken = accessToken;
  accessToken = null;

  const anonymous = await call("/rest/v1/swipes?select=id", { method: "GET" });
  check(
    !anonymous.ok || (Array.isArray(anonymous.payload) && anonymous.payload.length === 0),
    "без токена свайпы недоступны",
    "без токена удалось прочитать чужие свайпы — проверьте RLS",
  );

  accessToken = savedToken;

  const own = await call("/rest/v1/swipes?select=id,direction", { method: "GET" });
  check(
    own.ok && Array.isArray(own.payload) && own.payload.length > 0,
    `свои свайпы читаются (${own.payload?.length ?? 0})`,
    `свои свайпы не читаются: ${describeError(own)}`,
  );
}

async function main() {
  console.log(`Проект: ${SUPABASE_URL}`);

  if (!await signIn()) return finish();

  const imported = await importPlaylist();
  if (!imported) return finish();

  const deck = await checkDeck();
  if (!deck) return finish();

  const liked = await checkSwipes(deck);
  if (liked) await checkLikes(liked);

  await checkRefill();
  await checkIsolation();

  finish();
}

function finish() {
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`\n${"─".repeat(46)}`);
  console.log(passed === total ? `Всё в порядке: ${passed}/${total}` : `Проблемы: ${passed}/${total} проверок прошло`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((error) => {
  console.error("\nСкрипт упал:", error);
  process.exit(1);
});
