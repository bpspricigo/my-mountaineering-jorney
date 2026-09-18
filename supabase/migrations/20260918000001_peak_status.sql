-- One row per person per tagged peak.
--
-- The 9,479 peaks themselves are NOT in the database. They are static
-- reference data in data/peaks.geojson: identical for every user, regenerated
-- from OpenStreetMap by scripts/fetch-peaks.mjs, served from the CDN and
-- usable with no account and no network once cached. Copying 2.2 MB into
-- Postgres would buy nothing and cost a bulk import on every refresh.
--
-- So only the part that is genuinely per-person lives here, referring to peaks
-- by their OpenStreetMap node id. Name and elevation are denormalised
-- alongside it so a row is legible on its own, and so a peak dropped from a
-- future snapshot still shows up in your list rather than becoming an orphan
-- id. peaks.geojson stays the source of truth for position and ranking.

do $$ begin
  create type public.peak_status_kind as enum ('dream', 'planned', 'attempted', 'done');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.peak_status (
  user_id     uuid   not null references auth.users (id) on delete cascade,

  -- OpenStreetMap node id: the key already used by data/peak-status.json, so
  -- existing lists migrate without remapping anything.
  peak_id     bigint not null,
  status      public.peak_status_kind not null,

  -- Enough to render the list without loading the snapshot.
  name        text,
  ele         integer,
  country     text,

  -- When it was climbed, as opposed to when the row was written.
  climbed_on  date,
  note        text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One status per person per peak. Clearing a peak deletes its row, which is
  -- why there is no 'none' in the enum: absence is the untagged state.
  primary key (user_id, peak_id)
);

comment on table public.peak_status is
  'One row per person per tagged peak. Peaks live in data/peaks.geojson, not here.';

create index if not exists peak_status_user_status_idx
  on public.peak_status (user_id, status);

-- ─── Row level security ──────────────────────────────────────────────────────

alter table public.peak_status enable row level security;

-- Every policy is the same rule: you reach your own rows and nobody else's.
-- auth.uid() is wrapped in a subquery so Postgres evaluates it once per
-- statement rather than once per row.

drop policy if exists "own statuses are readable" on public.peak_status;
create policy "own statuses are readable"
  on public.peak_status for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own statuses are insertable" on public.peak_status;
create policy "own statuses are insertable"
  on public.peak_status for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "own statuses are updatable" on public.peak_status;
create policy "own statuses are updatable"
  on public.peak_status for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own statuses are deletable" on public.peak_status;
create policy "own statuses are deletable"
  on public.peak_status for delete
  to authenticated
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
