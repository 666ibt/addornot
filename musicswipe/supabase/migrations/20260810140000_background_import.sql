-- =============================================================================
-- Фоновый импорт плейлиста и отсев уже известных треков
--
-- 1. Импорт перестаёт быть одним долгим запросом: плейлист сохраняется сразу,
--    а сопоставление с каталогом идёт порциями. Отсюда курсор и счётчик
--    прогресса в playlists.
-- 2. Из ленты исключаются треки, которые есть в плейлисте пользователя,
--    даже если их ещё не успели сопоставить с каталогом, — по названию
--    и исполнителю.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Прогресс разбора
-- --------------------------------------------------------------------------
alter table public.playlists
  add column if not exists analyzed_count int not null default 0,
  add column if not exists next_position  int not null default 0,
  add column if not exists chunks_done    int not null default 0;

comment on column public.playlists.analyzed_count is
  'Сколько треков уже прогнали через каталог';
comment on column public.playlists.next_position is
  'Позиция, с которой продолжит следующая порция';
comment on column public.playlists.chunks_done is
  'Счётчик порций — страховка от бесконечного самовызова функции';

-- --------------------------------------------------------------------------
-- Треки, которые пользователю показывать не нужно
--
-- Раньше исключение работало только по track_id, а он есть лишь у треков,
-- дошедших до каталога. Всё остальное из плейлиста могло вернуться
-- пользователю как «рекомендация». Сравнение по сырым названиям закрывает
-- эту дыру и не стоит ни одного обращения к внешнему API.
-- --------------------------------------------------------------------------
create or replace function public.known_track_titles(p_user_id uuid)
returns table (artist text, title text)
language sql
stable
security invoker
set search_path = public
as $$
  select pt.raw_artist, pt.raw_title
    from public.playlist_tracks pt
    join public.playlists p on p.id = pt.playlist_id
   where p.user_id = p_user_id
  union
  select t.artist_name, t.title
    from public.swipes s
    join public.tracks t on t.id = s.track_id
   where s.user_id = p_user_id
  union
  select t.artist_name, t.title
    from public.recommendations r
    join public.tracks t on t.id = r.track_id
   where r.user_id = p_user_id;
$$;

-- --------------------------------------------------------------------------
-- Ход импорта для экрана загрузки
-- --------------------------------------------------------------------------
create or replace function public.playlist_progress(p_playlist_id uuid)
returns table (
  id             uuid,
  status         public.playlist_status,
  platform       text,
  title          text,
  cover_url      text,
  track_count    int,
  analyzed_count int,
  matched_count  int,
  error_message  text
)
language sql
stable
security invoker
set search_path = public
as $$
  select p.id, p.status, p.platform, p.title, p.cover_url,
         p.track_count, p.analyzed_count, p.matched_count, p.error_message
    from public.playlists p
   where p.id = p_playlist_id
     and p.user_id = auth.uid();
$$;

grant execute on function public.playlist_progress(uuid) to authenticated;
