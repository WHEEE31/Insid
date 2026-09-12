-- Backfill v4 geo/compass columns for walks uploaded before the columns
-- existed. Values come from the ORIGINAL recordings in web/data/*.json, which
-- still carry the startLatLon / startHeading the upload path used to drop.
-- Run AFTER the v4 ALTER block in schema.sql. Safe to re-run (plain UPDATEs).
-- Rows not present in the table are simply no-ops.

update public.walks set
  start_lat = 40.4416703, start_lon = -79.94745092, gps_accuracy = 17.31508443,
  start_heading = 353.91516113, heading_accuracy = 15.34633064
where id = 'walk-1789181272';

update public.walks set
  start_lat = 40.44168353, start_lon = -79.94723471, gps_accuracy = 19.42969088,
  start_heading = 144.02378845, heading_accuracy = 15.50014114
where id = 'walk-1789181434';

update public.walks set
  start_lat = 40.44175683, start_lon = -79.94718222, gps_accuracy = 15.45501528,
  start_heading = 169.09889221, heading_accuracy = 20.89736938
where id = 'walk-1789182659';

update public.walks set
  start_lat = 40.44168636, start_lon = -79.94723136, gps_accuracy = 19.38936159,
  start_heading = 167.61654663, heading_accuracy = 26.04378891
where id = 'walk-1789183028';

