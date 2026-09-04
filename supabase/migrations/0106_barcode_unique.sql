-- ===========================================================================
-- 0106 — a barcode identifies one instrument
-- ===========================================================================
--
-- inv_items.barcode is the number already on the instrument when it arrived:
-- an MDCPS asset tag, a manufacturer's sticker, a school's own label. It is
-- what gets scanned in the field, whoever owns the thing (YMU 2026-09-04).
--
-- 0102 indexed it but did not make it unique, so two rows could carry the same
-- code and a scan would return both. The app cannot resolve that: it either
-- picks one — silently relocating or repairing the wrong instrument — or it
-- shows a chooser for something the person scanning believed was unambiguous.
-- Neither is acceptable for the action the scanner exists to perform.
--
-- Partial, on `barcode is not null`: most instruments have no external code,
-- and a plain unique constraint would be fine there too (Postgres allows many
-- nulls) but the partial index is smaller and states the intent.
--
-- Not scoped to non-retired items on purpose. A retired instrument keeps its
-- code, and reusing it on something else would make the history ambiguous in
-- exactly the way this prevents — scanning a label should not depend on when
-- you scan it.
--
-- Safe to run on this table today because it is empty. If it ever needs
-- running against real rows, find the collisions first:
--   select barcode, count(*) from public.inv_items
--    where barcode is not null group by barcode having count(*) > 1;
-- ===========================================================================

drop index if exists public.inv_items_barcode_idx;

create unique index inv_items_barcode_uidx
  on public.inv_items (barcode)
  where barcode is not null;

comment on column public.inv_items.barcode is
  'The code already on the instrument — MDCPS asset tag, manufacturer sticker, '
  'school label. Unique when present: this is what the scanner reads, and a '
  'scan has to resolve to one instrument. Distinct from `serial`, which is the '
  'identifier this app issues and every item has.';
