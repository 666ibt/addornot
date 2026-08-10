/**
 * Тесты чистой логики: разбор ссылок, названий и построение вкусового профиля.
 * Сеть не нужна — запускаются так:
 *
 *   deno test supabase/functions/
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { detectPlaylist } from "./providers/detect.ts";
import { splitVideoTitle } from "./providers/youtube.ts";
import { cleanTitle } from "./deezer.ts";
import { buildTasteProfile, evenSample, mergeWeights, topKeys } from "./taste.ts";
import { extractJsonAfter, extractScriptJson } from "./http.ts";
import { collectNodes } from "./jsonwalk.ts";
import { ImportError, type CatalogTrack } from "./types.ts";

// ---------------------------------------------------------------------------
// Разбор ссылок
// ---------------------------------------------------------------------------

Deno.test("detectPlaylist: Spotify по ссылке и по URI", () => {
  const fromUrl = detectPlaylist("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc");
  assertEquals(fromUrl.platform, "spotify");
  assertEquals(fromUrl.externalId, "37i9dQZF1DXcBWIGoYBM5M");

  const fromUri = detectPlaylist("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
  assertEquals(fromUri.platform, "spotify");
  assertEquals(fromUri.externalId, "37i9dQZF1DXcBWIGoYBM5M");
});

Deno.test("detectPlaylist: Apple Music запоминает витрину", () => {
  const ref = detectPlaylist("https://music.apple.com/ru/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb");
  assertEquals(ref.platform, "apple_music");
  assertEquals(ref.externalId, "pl.f4d106fed2bd41149aaacabb233eb5eb");
  assertEquals(ref.extra.storefront, "ru");
});

Deno.test("detectPlaylist: YouTube Music берёт параметр list", () => {
  const ref = detectPlaylist("https://music.youtube.com/playlist?list=PLabc123&si=xyz");
  assertEquals(ref.platform, "youtube");
  assertEquals(ref.externalId, "PLabc123");
});

Deno.test("detectPlaylist: Deezer, Яндекс и SoundCloud", () => {
  assertEquals(detectPlaylist("https://www.deezer.com/ru/playlist/1234567").externalId, "1234567");

  const yandex = detectPlaylist("https://music.yandex.ru/users/masha/playlists/1015");
  assertEquals(yandex.platform, "yandex");
  assertEquals(yandex.extra.owner, "masha");
  assertEquals(yandex.extra.kind, "1015");

  const soundcloud = detectPlaylist("https://soundcloud.com/user/sets/my-mix?in=abc");
  assertEquals(soundcloud.platform, "soundcloud");
  assertEquals(soundcloud.externalId, "user/my-mix");
});

Deno.test("detectPlaylist: понятные ошибки вместо молчаливого падения", () => {
  // Ссылка на альбом, а не на плейлист.
  assertThrows(
    () => detectPlaylist("https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3"),
    ImportError,
  );
  // Ссылка на видео без параметра list.
  assertThrows(() => detectPlaylist("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), ImportError);
  // Незнакомая платформа.
  assertThrows(() => detectPlaylist("https://example.com/playlist/1"), ImportError);
  // Вообще не ссылка.
  assertThrows(() => detectPlaylist("просто текст"), ImportError);
});

// ---------------------------------------------------------------------------
// Названия треков
// ---------------------------------------------------------------------------

Deno.test("splitVideoTitle: делит заголовок ролика на исполнителя и название", () => {
  assertEquals(
    splitVideoTitle("Daft Punk - Around the World (Official Video)"),
    { artist: "Daft Punk", title: "Around the World" },
  );

  // Длинное тире вместо дефиса.
  assertEquals(
    splitVideoTitle("Radiohead — Creep"),
    { artist: "Radiohead", title: "Creep" },
  );
});

Deno.test("splitVideoTitle: без разделителя берёт исполнителя из канала", () => {
  // Служебные каналы YouTube Music называются «Исполнитель - Topic».
  assertEquals(
    splitVideoTitle("Bohemian Rhapsody", "Queen - Topic"),
    { artist: "Queen", title: "Bohemian Rhapsody" },
  );

  assertEquals(
    splitVideoTitle("Live at Wembley", "Queen Official"),
    { artist: "Queen Official", title: "Live at Wembley" },
  );

  // Ни разделителя, ни канала — трек распознать нечем.
  assertEquals(splitVideoTitle("Untitled"), null);
});

Deno.test("cleanTitle: убирает приписки, мешающие поиску в каталоге", () => {
  assertEquals(cleanTitle("Numb (feat. Jay-Z)"), "Numb");
  assertEquals(cleanTitle("Come Together - Remastered 2009"), "Come Together");
  assertEquals(cleanTitle("Yesterday"), "Yesterday");
});

// ---------------------------------------------------------------------------
// Вкусовой профиль
// ---------------------------------------------------------------------------

function track(overrides: Partial<CatalogTrack>): CatalogTrack {
  return {
    provider: "deezer",
    provider_id: "1",
    isrc: null,
    title: "Track",
    artist_name: "Artist",
    artist_provider_id: null,
    artist_picture_url: null,
    album_title: null,
    artwork_url: null,
    preview_url: null,
    external_url: null,
    duration_sec: 200,
    release_year: null,
    bpm: null,
    explicit: false,
    genres: [],
    popularity: 0,
    ...overrides,
  };
}

Deno.test("buildTasteProfile: веса нормируются к максимуму", () => {
  const profile = buildTasteProfile([
    track({ provider_id: "1", genres: ["Rock"] }),
    track({ provider_id: "2", genres: ["Rock"] }),
    track({ provider_id: "3", genres: ["Jazz"] }),
  ]);

  assertEquals(profile.genre_weights["Rock"], 1);
  assertEquals(profile.genre_weights["Jazz"], 0.5);
});

Deno.test("buildTasteProfile: трек с несколькими жанрами делит свой голос", () => {
  // Иначе сборник с пятью жанрами перевесил бы пять отдельных треков.
  const profile = buildTasteProfile([
    track({ provider_id: "1", genres: ["Rock", "Pop"] }),
    track({ provider_id: "2", genres: ["Rock"] }),
  ]);

  // Rock: 0.5 + 1 = 1.5 (максимум), Pop: 0.5 -> 0.3333
  assertEquals(profile.genre_weights["Rock"], 1);
  assertEquals(profile.genre_weights["Pop"], 0.3333);
});

Deno.test("buildTasteProfile: десятилетия, средний год и опорные исполнители", () => {
  const profile = buildTasteProfile([
    track({ provider_id: "1", release_year: 1994, artist_provider_id: "27", bpm: 120 }),
    track({ provider_id: "2", release_year: 1997, artist_provider_id: "27", bpm: 130 }),
    track({ provider_id: "3", release_year: 2005, artist_provider_id: "13" }),
  ]);

  assertEquals(profile.decade_weights["1990"], 1);
  assertEquals(profile.decade_weights["2000"], 0.5);
  assertEquals(profile.avg_year, 1998.7);
  assertEquals(profile.avg_bpm, 125);
  // Самый частый исполнитель идёт первым — с него начинается подбор похожих.
  assertEquals(profile.seed_artists, ["27", "13"]);
});

Deno.test("buildTasteProfile: пустой список не ломает профиль", () => {
  const profile = buildTasteProfile([]);
  assertEquals(profile.genre_weights, {});
  assertEquals(profile.avg_year, null);
  assertEquals(profile.seed_artists, []);
});

Deno.test("topKeys: отрицательные веса не попадают в подбор", () => {
  // Минус набегает от свайпов влево — такие жанры искать не нужно.
  assertEquals(topKeys({ Rock: 1, Jazz: 0.4, Techno: -2 }, 5), ["Rock", "Jazz"]);
});

Deno.test("mergeWeights: импорт дополняет профиль, а не затирает его", () => {
  const merged = mergeWeights({ Rock: 1, Jazz: 0.5 }, { Rock: 0.5, Pop: 1 });
  assertEquals(merged, { Rock: 1.5, Jazz: 0.5, Pop: 1 });

  // Профиля ещё нет — берём новые веса как есть.
  assertEquals(mergeWeights(null, { Rock: 1 }), { Rock: 1 });
});

Deno.test("evenSample: выборка размазана по всему плейлисту", () => {
  assertEquals(evenSample(5, 10), [0, 1, 2, 3, 4]);
  assertEquals(evenSample(10, 5), [0, 2, 4, 6, 8]);
  assertEquals(evenSample(0, 5), []);

  const sample = evenSample(500, 100);
  assertEquals(sample.length, 100);
  assertEquals(sample[0], 0);
  assertEquals(sample[99], 495);
});

// ---------------------------------------------------------------------------
// Разбор HTML-страниц
// ---------------------------------------------------------------------------

Deno.test("extractScriptJson: достаёт данные из тега script по id", () => {
  const html = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">{"a":{"b":[1,2]}}</script>
  </body></html>`;

  assertEquals(extractScriptJson(html, "__NEXT_DATA__"), { a: { b: [1, 2] } });
  assertEquals(extractScriptJson(html, "missing"), null);
});

Deno.test("extractJsonAfter: читает объект после префикса, не спотыкаясь о скобки в строках", () => {
  const source = 'var ytInitialData = {"title":"a } b","items":[{"id":1}]};var x = 2;';
  assertEquals(extractJsonAfter(source, "var ytInitialData ="), {
    title: "a } b",
    items: [{ id: 1 }],
  });
});

Deno.test("collectNodes: находит треки в дереве произвольной формы", () => {
  // Так выглядят данные embed-страницы Spotify: нужные узлы лежат глубоко
  // и их путь меняется от релиза к релизу.
  const payload = {
    props: {
      state: {
        data: {
          entity: {
            uri: "spotify:playlist:1",
            trackList: [
              { uri: "spotify:track:a", title: "First", subtitle: "Artist A" },
              { uri: "spotify:track:b", title: "Second", subtitle: "Artist B" },
            ],
          },
        },
      },
    },
  };

  const nodes = collectNodes(
    payload,
    (node) => typeof node.uri === "string" && (node.uri as string).startsWith("spotify:track:"),
  );

  assertEquals(nodes.length, 2);
  assertEquals(nodes.map((node) => node.title), ["First", "Second"]);
});
