-- =============================================================================
-- MusicSwipe — начальная схема
-- Tinder для музыки: импорт плейлиста с любой платформы -> анализ вкуса ->
-- лента рекомендаций со свайпами.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Типы
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'playlist_status') then
    create type public.playlist_status as enum ('pending', 'importing', 'ready', 'failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'swipe_direction') then
    create type public.swipe_direction as enum ('like', 'pass', 'superlike');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Утилита: обновление updated_at
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Профили пользователей
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  avatar_url    text,
  onboarded     boolean     not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- Автосоздание профиля при регистрации
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(coalesce(new.email, ''), '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.taste_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- Каталог: исполнители и треки
-- Каталог общий для всех пользователей (справочник), пишет только service_role.
-- -----------------------------------------------------------------------------
create table if not exists public.artists (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null default 'deezer',
  provider_id  text not null,
  name         text not null,
  picture_url  text,
  genres       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  unique (provider, provider_id)
);

create index if not exists artists_name_idx on public.artists (lower(name));

create table if not exists public.tracks (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null default 'deezer',
  provider_id   text not null,
  isrc          text,
  title         text not null,
  artist_name   text not null,
  artist_id     uuid references public.artists (id) on delete set null,
  album_title   text,
  artwork_url   text,
  preview_url   text,
  external_url  text,
  duration_sec  int,
  release_year  int,
  bpm           numeric,
  explicit      boolean not null default false,
  genres        text[] not null default '{}',
  popularity    int     not null default 0,
  created_at    timestamptz not null default now(),
  unique (provider, provider_id)
);

create index if not exists tracks_match_idx on public.tracks (lower(artist_name), lower(title));
create index if not exists tracks_genres_idx on public.tracks using gin (genres);
create index if not exists tracks_artist_idx on public.tracks (artist_id);

-- -----------------------------------------------------------------------------
-- Плейлисты пользователя
-- -----------------------------------------------------------------------------
create table if not exists public.playlists (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  source_url    text not null,
  platform      text not null,                 -- spotify | apple_music | youtube | deezer | yandex | soundcloud
  external_id   text,
  title         text,
  cover_url     text,
  owner_name    text,
  status        public.playlist_status not null default 'pending',
  error_message text,
  track_count   int not null default 0,
  matched_count int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists playlists_user_idx on public.playlists (user_id, created_at desc);

drop trigger if exists playlists_touch_updated_at on public.playlists;
create trigger playlists_touch_updated_at
  before update on public.playlists
  for each row execute function public.touch_updated_at();

create table if not exists public.playlist_tracks (
  playlist_id  uuid not null references public.playlists (id) on delete cascade,
  position     int  not null,
  raw_title    text not null,
  raw_artist   text not null,
  raw_album    text,
  isrc         text,
  track_id     uuid references public.tracks (id) on delete set null,
  primary key (playlist_id, position)
);

create index if not exists playlist_tracks_track_idx on public.playlist_tracks (track_id);

-- -----------------------------------------------------------------------------
-- Вкусовой профиль
-- genre_weights / artist_weights — { "ключ": вес } в jsonb.
-- -----------------------------------------------------------------------------
create table if not exists public.taste_profiles (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  genre_weights  jsonb   not null default '{}'::jsonb,
  artist_weights jsonb   not null default '{}'::jsonb,
  decade_weights jsonb   not null default '{}'::jsonb,
  avg_bpm        numeric,
  avg_year       numeric,
  seed_artists   text[]  not null default '{}',
  likes_count    int     not null default 0,
  passes_count   int     not null default 0,
  version        int     not null default 1,
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Свайпы
-- -----------------------------------------------------------------------------
create table if not exists public.swipes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  track_id   uuid not null references public.tracks (id) on delete cascade,
  direction  public.swipe_direction not null,
  listened_ms int not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, track_id)
);

create index if not exists swipes_user_idx on public.swipes (user_id, created_at desc);
create index if not exists swipes_liked_idx on public.swipes (user_id, direction);

-- -----------------------------------------------------------------------------
-- Очередь рекомендаций
-- -----------------------------------------------------------------------------
create table if not exists public.recommendations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  track_id   uuid not null references public.tracks (id) on delete cascade,
  score      numeric not null default 0,
  reason     jsonb   not null default '{}'::jsonb,
  batch      int     not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, track_id)
);

create index if not exists recommendations_queue_idx
  on public.recommendations (user_id, score desc, created_at desc);

-- -----------------------------------------------------------------------------
-- Обратная связь: свайп двигает вкусовой профиль
-- -----------------------------------------------------------------------------
create or replace function public.apply_swipe_feedback()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t              public.tracks%rowtype;
  g              text;
  delta          numeric;
  genre_w        jsonb;
  artist_w       jsonb;
  decade_w       jsonb;
  decade_key     text;
  artist_key     text;
begin
  select * into t from public.tracks where id = new.track_id;
  if not found then
    return new;
  end if;

  delta := case new.direction
             when 'superlike' then 2.0
             when 'like'      then 1.0
             else                 -0.6
           end;

  insert into public.taste_profiles (user_id) values (new.user_id)
  on conflict (user_id) do nothing;

  select genre_weights, artist_weights, decade_weights
    into genre_w, artist_w, decade_w
    from public.taste_profiles
   where user_id = new.user_id
     for update;

  foreach g in array coalesce(t.genres, '{}'::text[]) loop
    genre_w := jsonb_set(
      genre_w,
      array[g],
      to_jsonb(round(coalesce((genre_w ->> g)::numeric, 0) + delta, 4)),
      true
    );
  end loop;

  artist_key := lower(t.artist_name);
  artist_w := jsonb_set(
    artist_w,
    array[artist_key],
    to_jsonb(round(coalesce((artist_w ->> artist_key)::numeric, 0) + delta, 4)),
    true
  );

  if t.release_year is not null then
    decade_key := ((t.release_year / 10) * 10)::text;
    decade_w := jsonb_set(
      decade_w,
      array[decade_key],
      to_jsonb(round(coalesce((decade_w ->> decade_key)::numeric, 0) + delta, 4)),
      true
    );
  end if;

  update public.taste_profiles
     set genre_weights  = genre_w,
         artist_weights = artist_w,
         decade_weights = decade_w,
         likes_count    = likes_count  + case when delta > 0 then 1 else 0 end,
         passes_count   = passes_count + case when delta < 0 then 1 else 0 end,
         updated_at     = now()
   where user_id = new.user_id;

  return new;
end;
$$;

drop trigger if exists swipes_apply_feedback on public.swipes;
create trigger swipes_apply_feedback
  after insert or update of direction on public.swipes
  for each row execute function public.apply_swipe_feedback();

-- -----------------------------------------------------------------------------
-- RPC для клиента
-- -----------------------------------------------------------------------------

-- Следующая пачка карточек: рекомендации, которые ещё не свайпнуты
-- и у которых есть превью для прослушивания.
create or replace function public.get_deck(p_limit int default 20)
returns table (
  id           uuid,
  provider     text,
  provider_id  text,
  title        text,
  artist_name  text,
  album_title  text,
  artwork_url  text,
  preview_url  text,
  external_url text,
  duration_sec int,
  release_year int,
  genres       text[],
  explicit     boolean,
  score        numeric,
  reason       jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, t.provider, t.provider_id, t.title, t.artist_name, t.album_title,
         t.artwork_url, t.preview_url, t.external_url, t.duration_sec,
         t.release_year, t.genres, t.explicit, r.score, r.reason
    from public.recommendations r
    join public.tracks t on t.id = r.track_id
   where r.user_id = auth.uid()
     and t.preview_url is not null
     and not exists (
       select 1 from public.swipes s
        where s.user_id = r.user_id and s.track_id = r.track_id
     )
   order by r.score desc, r.created_at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

-- Запись свайпа (повторный свайп по треку перезаписывает направление).
create or replace function public.record_swipe(
  p_track_id    uuid,
  p_direction   text,
  p_listened_ms int default 0
)
returns void
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.swipes (user_id, track_id, direction, listened_ms)
  values (auth.uid(), p_track_id, p_direction::public.swipe_direction, greatest(coalesce(p_listened_ms, 0), 0))
  on conflict (user_id, track_id) do update
    set direction   = excluded.direction,
        listened_ms = greatest(swipes.listened_ms, excluded.listened_ms),
        created_at  = now();
$$;

-- Понравившиеся треки.
create or replace function public.liked_tracks(p_limit int default 100, p_offset int default 0)
returns table (
  id           uuid,
  title        text,
  artist_name  text,
  album_title  text,
  artwork_url  text,
  preview_url  text,
  external_url text,
  duration_sec int,
  release_year int,
  genres       text[],
  superliked   boolean,
  liked_at     timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id, t.title, t.artist_name, t.album_title, t.artwork_url, t.preview_url,
         t.external_url, t.duration_sec, t.release_year, t.genres,
         (s.direction = 'superlike') as superliked,
         s.created_at as liked_at
    from public.swipes s
    join public.tracks t on t.id = s.track_id
   where s.user_id = auth.uid()
     and s.direction in ('like', 'superlike')
   order by s.created_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500))
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Сводка вкуса для экрана профиля.
create or replace function public.taste_summary()
returns table (
  genre        text,
  weight       numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select kv.key as genre, kv.value::numeric as weight
    from public.taste_profiles tp
   cross join lateral jsonb_each_text(tp.genre_weights) as kv(key, value)
   where tp.user_id = auth.uid()
     and kv.value::numeric > 0
   order by kv.value::numeric desc
   limit 12;
$$;

-- -----------------------------------------------------------------------------
-- Служебные функции для движка рекомендаций (вызываются с service_role)
-- -----------------------------------------------------------------------------

-- Опорные исполнители: из импортированного плейлиста и из лайков.
create or replace function public.seed_artist_ids(p_user_id uuid, p_limit int default 12)
returns table (provider_id text, weight numeric)
language sql
stable
security invoker
set search_path = public
as $$
  with signals as (
    select t.artist_id,
           case s.direction when 'superlike' then 2.0 when 'like' then 1.0 else -0.6 end as w
      from public.swipes s
      join public.tracks t on t.id = s.track_id
     where s.user_id = p_user_id
    union all
    select t.artist_id, 1.0 as w
      from public.playlist_tracks pt
      join public.playlists p on p.id = pt.playlist_id
      join public.tracks t on t.id = pt.track_id
     where p.user_id = p_user_id
  )
  select a.provider_id, sum(s.w) as weight
    from signals s
    join public.artists a on a.id = s.artist_id
   where s.artist_id is not null
   group by a.provider_id
  having sum(s.w) > 0
   order by weight desc
   limit greatest(1, least(coalesce(p_limit, 12), 50));
$$;

-- Треки, которые пользователь уже видел: из плейлиста, из свайпов
-- и из ещё не показанной очереди рекомендаций.
create or replace function public.known_provider_ids(p_user_id uuid)
returns table (provider_id text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct t.provider_id
    from public.tracks t
   where t.id in (
     select pt.track_id
       from public.playlist_tracks pt
       join public.playlists p on p.id = pt.playlist_id
      where p.user_id = p_user_id and pt.track_id is not null
     union
     select s.track_id from public.swipes s where s.user_id = p_user_id
     union
     select r.track_id from public.recommendations r where r.user_id = p_user_id
   );
$$;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.playlists       enable row level security;
alter table public.playlist_tracks enable row level security;
alter table public.taste_profiles  enable row level security;
alter table public.swipes          enable row level security;
alter table public.recommendations enable row level security;
alter table public.tracks          enable row level security;
alter table public.artists         enable row level security;

-- profiles: владелец
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- playlists: владелец
drop policy if exists playlists_all_own on public.playlists;
create policy playlists_all_own on public.playlists
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- playlist_tracks: через владельца плейлиста
drop policy if exists playlist_tracks_select_own on public.playlist_tracks;
create policy playlist_tracks_select_own on public.playlist_tracks
  for select to authenticated using (
    exists (select 1 from public.playlists p
             where p.id = playlist_tracks.playlist_id and p.user_id = auth.uid())
  );

-- taste_profiles: владелец читает, пишет только сервер/триггер
drop policy if exists taste_profiles_select_own on public.taste_profiles;
create policy taste_profiles_select_own on public.taste_profiles
  for select to authenticated using (user_id = auth.uid());

-- swipes: владелец
drop policy if exists swipes_all_own on public.swipes;
create policy swipes_all_own on public.swipes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- recommendations: владелец только читает
drop policy if exists recommendations_select_own on public.recommendations;
create policy recommendations_select_own on public.recommendations
  for select to authenticated using (user_id = auth.uid());

-- каталог: читают все залогиненные, пишет только service_role (обходит RLS)
drop policy if exists tracks_read_all on public.tracks;
create policy tracks_read_all on public.tracks
  for select to authenticated using (true);

drop policy if exists artists_read_all on public.artists;
create policy artists_read_all on public.artists
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Гранты
-- -----------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on public.tracks, public.artists, public.taste_profiles, public.playlist_tracks to authenticated;
grant select, insert, update, delete on public.playlists, public.swipes to authenticated;
grant select on public.recommendations to authenticated;
grant select, insert, update on public.profiles to authenticated;

grant execute on function public.get_deck(int)                  to authenticated;
grant execute on function public.record_swipe(uuid, text, int)  to authenticated;
grant execute on function public.liked_tracks(int, int)         to authenticated;
grant execute on function public.taste_summary()                to authenticated;
