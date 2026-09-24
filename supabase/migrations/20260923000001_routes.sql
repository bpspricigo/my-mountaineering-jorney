-- An outing: one walk, done or planned, with its track and everything that
-- hangs off it.
--
-- Separate from peak_status because the two are not the same shape. A status
-- is one row per peak; a walk can take in several summits — "Brunnensteinspitze
-- und Rotwandlspitze" is one day and two peaks — and a peak collects many
-- walks over the years. So routes and peaks meet in route_peak.
--
-- The track is stored as an encoded polyline, not a file. A 600 KB GPX
-- simplified to 5 m keeps every switchback and costs about 1 KB, which fits in
-- the row, needs no storage bucket, and draws without a second request. The
-- stats are computed from the full-resolution file at import, so simplifying
-- the line never costs accuracy in a number anyone reads.

do $$ begin
  create type public.route_kind as enum ('done', 'planned');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.route (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,

  kind        public.route_kind not null default 'planned',
  title       text not null,
  -- The day it was walked, or the day it is meant for. Null for "someday".
  date        date,

  location    text,
  country     text,
  description text,
  -- Gear, conditions, hut bookings: prose, because it is never the same twice.
  notes       text,

  -- Measured from the raw track where one exists, otherwise typed in by hand.
  distance_m     integer,
  ascent_m       integer,
  moving_seconds integer,
  difficulty     text,

  -- The two links that always exist get their own columns; everything else —
  -- Komoot, a trip report, a webcam, a weather station — goes in links as
  -- [{"label": "...", "url": "..."}], so a new kind needs no migration.
  strava_url  text,
  photos_url  text,
  links       jsonb not null default '[]'::jsonb,

  -- Google's encoded polyline, precision 5. Null for a route with no track yet.
  track          text,
  track_points   integer,
  -- [west, south, east, north], so the map can fit the line without decoding it.
  bounds         double precision[],

  -- Where an imported route came from, e.g. 'gpx/20250810'. Keeps a re-import
  -- from silently duplicating what is already here.
  source      text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.route is
  'One outing, done or planned. The track is an encoded polyline, not a file.';

create index if not exists route_user_kind_idx on public.route (user_id, kind, date desc);
create unique index if not exists route_user_source_idx
  on public.route (user_id, source) where source is not null;

-- Which summits a walk takes in. A row per pair, so both directions are cheap:
-- the peaks of a route, and the routes of a peak.
create table if not exists public.route_peak (
  route_id  uuid   not null references public.route (id) on delete cascade,
  peak_id   bigint not null,
  user_id   uuid   not null references auth.users (id) on delete cascade,
  -- Denormalised so a route lists its summits without the snapshot loaded.
  name      text,
  ele       integer,
  primary key (route_id, peak_id)
);

comment on table public.route_peak is
  'Which peaks an outing takes in. Many-to-many: one walk, several summits.';

create index if not exists route_peak_peak_idx on public.route_peak (user_id, peak_id);

-- ─── Row level security ──────────────────────────────────────────────────────

alter table public.route enable row level security;
alter table public.route_peak enable row level security;

-- The same rule as peak_status: you reach your own rows and nobody else's.
-- auth.uid() is wrapped in a subquery so Postgres evaluates it once per
-- statement rather than once per row.

drop policy if exists "own routes are readable" on public.route;
create policy "own routes are readable"
  on public.route for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own routes are insertable" on public.route;
create policy "own routes are insertable"
  on public.route for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "own routes are updatable" on public.route;
create policy "own routes are updatable"
  on public.route for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own routes are deletable" on public.route;
create policy "own routes are deletable"
  on public.route for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own route peaks are readable" on public.route_peak;
create policy "own route peaks are readable"
  on public.route_peak for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own route peaks are insertable" on public.route_peak;
create policy "own route peaks are insertable"
  on public.route_peak for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "own route peaks are updatable" on public.route_peak;
create policy "own route peaks are updatable"
  on public.route_peak for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own route peaks are deletable" on public.route_peak;
create policy "own route peaks are deletable"
  on public.route_peak for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ─── Housekeeping ────────────────────────────────────────────────────────────

drop trigger if exists route_touch on public.route;
create trigger route_touch
  before update on public.route
  for each row execute function public.touch_updated_at();
