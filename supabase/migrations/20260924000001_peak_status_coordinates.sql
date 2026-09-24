-- A tagged peak has to be drawable on its own.
--
-- Until now a status carried only a name and an elevation, and the map found
-- its position in data/peaks.geojson. That works while every peak you can tag
-- is in that file, and stops working the moment one is not — a summit in the
-- Andes taken from the basemap's own tiles, or a dream on a continent the
-- snapshot does not cover.
alter table public.peak_status
  add column if not exists lat    double precision,
  add column if not exists lon    double precision,
  add column if not exists source text;

comment on column public.peak_status.lat is 'Summit position, so the peak can be drawn without any snapshot.';
comment on column public.peak_status.source is
  'Where the peak came from: osm, tile (the basemap vector tiles), or geonames.';

comment on column public.peak_status.peak_id is
  'OpenStreetMap node id where one is known. Peaks from other sources get a '
  'deterministic id derived from their coordinates, above 1e15 — far beyond '
  'any real OSM node id, so the two can never collide.';
