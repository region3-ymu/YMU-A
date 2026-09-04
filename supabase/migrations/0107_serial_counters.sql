-- ===========================================================================
-- 0107 — serials say who owns the instrument, and each owner counts its own
-- ===========================================================================
--
-- YMU 2026-09-04: the label on an instrument should say whose it is —
-- MDCPS-VLN-000037, not YMU-VLN-000037 for something MDCPS paid for. And each
-- owner counts from one, so "MDCPS violins 1 through 40" is a real statement
-- about a real set rather than a range with other people's numbers missing
-- from the middle.
--
-- Ownership does not change (confirmed). If it ever did, the answer is to
-- delete the row and re-enter it under the new owner with a fresh label —
-- which the schema already allows for anything that has not moved yet, and
-- which is honest, because relabelling is a physical act either way.
--
-- Counting across owners is unaffected: "how many violins do we have" is a
-- query over inv_items and never touches these counters. What the counters
-- decide is only what gets printed on the sticker.
--
-- THE COUNTER MOVES OUT OF inv_item_types. 0101 put next_sequence there, one
-- per type, which cannot express one per owner per type. Leaving the column
-- behind would be worse than moving it: two places claiming to hold the same
-- number, one of them silently stale. It is dropped below.
-- ===========================================================================

create table public.inv_serial_counters (
  owner         public.owner_type not null,
  item_type_id  uuid not null references public.inv_item_types (id) on delete restrict,
  next_sequence integer not null default 1 check (next_sequence >= 1),
  updated_at    timestamptz not null default now(),

  primary key (owner, item_type_id)
);

comment on table public.inv_serial_counters is
  'One serial counter per owner per item type. Server-owned: the only thing '
  'that may move next_sequence is inv_generate_serial(), which increments and '
  'returns in a single statement so two people adding a violin at the same '
  'moment cannot be handed the same number.';

-- Nobody reaches this table through the API. It is bookkeeping for the
-- function below, and a client that could write it could mint a duplicate
-- serial — which inv_items.serial's unique constraint would then reject at the
-- worst possible moment, after the label was printed.
alter table public.inv_serial_counters enable row level security;

create policy inv_serial_counters_select on public.inv_serial_counters
  for select to authenticated using (public.inventory_manager());

-- No insert, update or delete policy at all, deliberately. The generating
-- function is SECURITY DEFINER and bypasses this.

alter table public.inv_item_types drop column next_sequence;

-- ---------------------------------------------------------------------------
-- Minting a serial.
--
-- The whole point is the single statement in the middle. Read-then-write would
-- hand two simultaneous callers the same number; `insert ... on conflict do
-- update ... returning` takes the row lock, increments, and reports what the
-- caller got, atomically. This is the same trick the inventory app used and
-- the reason its serials never collided under load.
--
-- On the insert path next_sequence lands at 2 and the caller gets 1; on the
-- conflict path it becomes old+1 and the caller gets old. Either way
-- `next_sequence` means "the next one to hand out", which is what it is called.
-- ---------------------------------------------------------------------------

create or replace function public.inv_generate_serial(
  p_owner        public.owner_type,
  p_item_type_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_abbr text;
  v_seq  integer;
begin
  -- Managers add items; so do teachers, counting their own rooms. Anyone else
  -- calling this would only burn a sequence number, but a number burned is a
  -- gap in a printed range somebody will later ask about.
  if not public.inventory_manager()
     and public.current_app_role() is distinct from 'teacher' then
    raise exception 'Your role cannot create inventory items';
  end if;

  select abbreviation into v_abbr
    from public.inv_item_types
   where id = p_item_type_id and active;

  if v_abbr is null then
    raise exception 'That item type does not exist, or is no longer in use';
  end if;

  insert into public.inv_serial_counters as c (owner, item_type_id, next_sequence)
  values (p_owner, p_item_type_id, 2)
  on conflict (owner, item_type_id)
    do update set next_sequence = c.next_sequence + 1,
                  updated_at    = now()
  returning c.next_sequence - 1 into v_seq;

  -- MDCPS-VLN-000037. Owner uppercased so 'Other' does not print as a word in
  -- the middle of a code.
  return upper(p_owner::text) || '-' || v_abbr || '-' || lpad(v_seq::text, 6, '0');
end;
$$;

revoke execute on function public.inv_generate_serial(public.owner_type, uuid)
  from public, anon;
grant execute on function public.inv_generate_serial(public.owner_type, uuid)
  to authenticated;

comment on function public.inv_generate_serial(public.owner_type, uuid) is
  'Reserves and returns the next serial for an owner and item type. Reserving '
  'is the point: calling this consumes a number whether or not the item is '
  'ultimately saved, which is why the app should call it as late as possible '
  'in the add flow rather than to preview a label.';
