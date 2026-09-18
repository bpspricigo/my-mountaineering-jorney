-- Peak reference data, and each person's status for a peak.
--
-- Two kinds of data with opposite access rules:
--
--   peaks        9,479 rows of OpenStreetMap reference data, identical for
--                everyone. Readable by anybody, writable only by the importer.
--   peak_status  one row per person per peak. Private to its owner.
--
-- The split matters: peak_status rows carry only a peak_id, so a 2.2 MB
-- snapshot is never duplicated per user.

-- ─── Peaks ───────────────────────────────────────────────────────────────────

create table if not exists public.peaks (
  -- The OSM node id. Stable, already the key used by the static planner and by
  -- data/peak-status.json, so nothing needs remapping on import.
  id            bigint primary key,
  name          text    not null,
  ele           integer not null check (ele between 0 and 9000),
  lat           double precision not null check (lat between -90 and 90),
  lon           double precision not null check (lon between -180 and 180),

  -- "AT", "DE", or "AT/DE" for a summit on a border.
  country       text,

  -- Distance in metres to the nearest higher peak, and the zoom level it earns
  -- from that. Computed by scripts/fetch-peaks.mjs; null only for the highest
  -- peak in the set, which has no higher ground anywhere.
  isolation     integer,
  min_zoom      smallint not null default 0,

  prominence    integer,
  wikidata      text,
  wikipedia     text,

  updated_at    timestamptz not null default now()
);

comment on table public.peaks is
  'OpenStreetMap peak snapshot. Shared reference data: everyone reads, nobody writes.';
comment on column public.peaks.isolation is
  'Metres to the nearest higher peak. Separates a mountain from a secondary summit: Grossglockner 174880, Kleinglockner 70.';

-- The planner asks for peaks by area and by significance, in that order.
create index if not exists peaks_min_zoom_idx on public.peaks (min_zoom);
create index if not exists peaks_ele_idx      on public.peaks (ele desc);
create index if not exists peaks_country_idx  on public.peaks (country);

-- ─── Statuses ────────────────────────────────────────────────────────────────

do $$ begin
  create type public.peak_status_kind as enum ('dream', 'planned', 'attempted', 'done');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.peak_status (
  user_id     uuid not null references auth.users (id) on delete cascade,
  peak_id     bigint not null references public.peaks (id) on delete cascade,
  status      public.peak_status_kind not null,

  -- When it was climbed, as opposed to when the row was written.
  climbed_on  date,
  note        text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One status per person per peak. Clearing a status deletes the row, so
  -- there is no 'none' in the enum: absence is the untagged state.
  primary key (user_id, peak_id)
);

comment on table public.peak_status is
  'One row per person per tagged peak. Absence means untagged.';

create index if not exists peak_status_user_idx on public.peak_status (user_id, status);

-- ─── Row level security ──────────────────────────────────────────────────────

alter table public.peaks enable row level security;
alter table public.peak_status enable row level security;

-- Reference data is public: the planner must work before anyone signs in.
drop policy if exists "peaks are readable by everyone" on public.peaks;
create policy "peaks are readable by everyone"
  on public.peaks for select
  using (true);

-- No insert/update/delete policy for peaks on purpose. The importer runs with
-- the service role, which bypasses RLS; nothing reaching the browser can write
-- here even with a valid session.

drop policy if exists "own statuses are readable" on public.peak_status;
create policy "own statuses are readable"
  on public.peak_status for select
  using ((select auth.uid()) = user_id);

drop policy if exists "own statuses are insertable" on public.peak_status;
create policy "own statuses are insertable"
  on public.peak_status for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "own statuses are updatable" on public.peak_status;
create policy "own statuses are updatable"
  on public.peak_status for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own statuses are deletable" on public.peak_status;
create policy "own statuses are deletable"
  on public.peak_status for delete
  using ((select auth.uid()) = user_id);

-- ─── Housekeeping ────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists peak_status_touch on public.peak_status;
create trigger peak_status_touch
  before update on public.peak_status
  for each row execute function public.touch_updated_at();
