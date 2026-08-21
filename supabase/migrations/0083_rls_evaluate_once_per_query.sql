-- ===========================================================================
-- 0083 — the app is slow because RLS re-asks who you are for every row
-- ===========================================================================
--
-- YMU (2026-08-21): "siento que el app para abrir casi cualquier cosa está
-- lenta". Measured rather than guessed, from pg_stat_statements on production.
--
-- The /schedules calendar_events query: 6,396 calls, 158 ms mean, 5.4 s worst,
-- and 17,023 shared blocks PER CALL. A second calendar_events query averages
-- 358 ms at 23,985 blocks. 17,000 blocks is 136 MB of buffer reads to return a
-- fortnight of classes from a 57 MB table.
--
-- The same query with RLS out of the way:
--
--   Index Scan using calendar_events_start_at_idx
--   Buffers: shared hit=633
--   Execution Time: 3.711 ms
--
-- 3.7 ms and 633 blocks against 158 ms and 17,023. RLS is costing ~40x the
-- time and ~27x the reads, and it is not the policy's logic — it is WHEN the
-- policy is evaluated.
--
-- ── The mechanism ────────────────────────────────────────────────────────
--
-- calendar_events_select reads:
--
--   auth.uid() = any(teacher_ids)
--   or current_sees_all_regions()
--   or (current_app_role() = 'regional_manager' and ... exists (select 1 from schools ...))
--   or (current_app_role() = 'afterschool_manager' and ...)
--
-- Those four functions are STABLE, which permits Postgres to call them once —
-- it does not oblige it to. Written bare inside a policy they land in the
-- row filter, so each one runs PER ROW, and each one does its own
-- `select ... from profiles where id = auth.uid()`. A Regional Manager opening
-- a fortnight of classes pays a few thousand profile lookups and a schools
-- scan per row to be told the same answer every time.
--
-- Wrapping each in a scalar subquery — `(select current_app_role())` — moves it
-- into an InitPlan, which Postgres evaluates ONCE per statement and reuses.
-- Measured on the same query, same session:
--
--   bare calls          52.6 ms
--   wrapped in (select) 25.7 ms      -- plan shows InitPlan 1/2/3/8
--
-- and that is as service_role, where current_sees_all_regions() returns true
-- immediately and short-circuits the rest. For a Regional Manager, where it
-- returns false and every following branch has to be evaluated for real, the
-- gap is the 17,000 blocks above.
--
-- This is a pure evaluation-order change. `f()` and `(select f())` return the
-- same value for a STABLE zero-argument function; nothing about who can read
-- what moves. That is asserted below rather than asserted here.
--
-- ── Why a DO block and not 28 hand-written policies ──────────────────────
--
-- 28 policies across 21 tables call one of these four bare. Retyping the
-- security rules of the entire application by hand, to change only when a
-- function runs, is the more dangerous option by a wide margin — one mistyped
-- OR and a region boundary is gone.
--
-- So the rewrite is mechanical, and the safety comes from the invariant check
-- at the end: strip every `(select ...)` wrapper from the before and after
-- expressions and they must be character-identical. Any change the regex made
-- beyond re-wrapping fails the migration and rolls it back.
-- ===========================================================================

-- The rewrite, in one pass per policy.
--
-- regexp_replace, not replace(). A plain string replace of 'current_app_role()'
-- would also hit the inside of 'public.current_app_role()' and produce
-- 'public.(select current_app_role())', which is not valid SQL — the migration
-- would fail loudly, but only after touching some policies. The leading group
-- below refuses to match when the name is preceded by a dot or a word
-- character, so a schema-qualified call is matched whole or not at all.

create or replace function public.wrap_identity_calls(p_expr text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_expr is null then null else
    -- auth.uid() carries its own dot, so it needs its own pattern.
    regexp_replace(
      regexp_replace(
        p_expr,
        '(^|[^[:alnum:]_.])((?:public\.)?(?:current_app_role|current_sees_all_regions|current_app_region)\(\))',
        '\1(select \2)',
        'g'
      ),
      '(^|[^[:alnum:]_.])(auth\.uid\(\))',
      '\1(select \2)',
      'g'
    )
  end;
$$;

comment on function public.wrap_identity_calls(text) is
  'Wraps the four row-independent identity functions in a scalar subquery so Postgres evaluates them once per statement instead of once per row. Used by migration 0083 to rewrite RLS policies; safe to keep for the next one.';

do $$
declare
  v_policy record;
  v_using text;
  v_check text;
  v_before jsonb := '{}'::jsonb;
  v_after  jsonb := '{}'::jsonb;
  v_key text;
  v_bare integer;
  v_count_before integer;
  v_count_after integer;
  v_touched integer := 0;
begin
  -- Already applied? Then there is nothing to do, and re-running the wrap
  -- would nest a subquery inside a subquery. Cheaper and clearer than trying
  -- to make the rewrite reversible.
  select count(*) into v_bare
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')
          || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
         like '%SELECT current_app_role()%';
  if v_bare > 0 then
    raise notice '0083 already applied — leaving % policies alone.', v_bare;
    return;
  end if;

  select count(*) into v_count_before
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public';

  for v_policy in
    select p.polname,
           c.relname,
           pg_get_expr(p.polqual, p.polrelid)      as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
     order by c.relname, p.polname
  loop
    v_using := public.wrap_identity_calls(v_policy.using_expr);
    v_check := public.wrap_identity_calls(v_policy.check_expr);
    v_key := v_policy.relname || '.' || v_policy.polname;
    v_before := v_before || jsonb_build_object(
      v_key, coalesce(v_policy.using_expr, '') || ' ||| ' || coalesce(v_policy.check_expr, '')
    );

    -- A policy that never mentioned one of the four is left untouched, not
    -- rewritten to itself.
    if v_using is not distinct from v_policy.using_expr
       and v_check is not distinct from v_policy.check_expr then
      continue;
    end if;

    execute format(
      'alter policy %I on public.%I%s%s',
      v_policy.polname,
      v_policy.relname,
      case when v_using is null then '' else ' using (' || v_using || ')' end,
      case when v_check is null then '' else ' with check (' || v_check || ')' end
    );
    v_touched := v_touched + 1;
  end loop;

  -- ── Invariant 1: nothing was dropped ──────────────────────────────────
  select count(*) into v_count_after
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public';
  if v_count_after <> v_count_before then
    raise exception 'Policy count changed from % to %. Rolling back.', v_count_before, v_count_after;
  end if;

  -- ── Invariant 2: the ONLY change is where the parentheses are ─────────
  -- This is what makes a mechanical rewrite of the whole application's
  -- security rules defensible. Strip every wrapper Postgres rendered back out
  -- of the AFTER expression and it must be character-identical to BEFORE. If
  -- the transform altered a boolean, a column, a role or an OR, these diverge
  -- and the migration rolls back with both texts in the error.
  for v_policy in
    select p.polname, c.relname,
           pg_get_expr(p.polqual, p.polrelid)      as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
  loop
    v_after := v_after || jsonb_build_object(
      v_policy.relname || '.' || v_policy.polname,
      coalesce(v_policy.using_expr, '') || ' ||| ' || coalesce(v_policy.check_expr, '')
    );
  end loop;

  for v_key in select jsonb_object_keys(v_before) loop
    -- Postgres renders a wrapped call as "( SELECT f() AS f)". Undo exactly
    -- that shape and nothing else.
    -- Postgres names the subquery's output column after the function: "AS uid"
    -- for auth.uid(), "AS current_app_role" for the rest. The alias pattern
    -- allows a dot as well, so this holds whichever way the server renders it.
    if regexp_replace(v_before->>v_key, '\( SELECT ([a-z_.]+\(\)) AS [a-z_.]+\)', '\1', 'g')
       is distinct from
       regexp_replace(v_after->>v_key,  '\( SELECT ([a-z_.]+\(\)) AS [a-z_.]+\)', '\1', 'g')
    then
      raise exception
        'Policy % changed in more than its evaluation order. Rolling back.%before: %%after:  %',
        v_key, chr(10), v_before->>v_key, chr(10), v_after->>v_key;
    end if;
  end loop;

  -- ── Invariant 3: the thing we came to do actually happened ────────────
  -- No lookbehind in Postgres regex, so blank out the wrapped forms first and
  -- then look for anything still calling bare.
  select count(*) into v_bare
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and regexp_replace(
           coalesce(pg_get_expr(p.polqual, p.polrelid), '')
             || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
           '\( SELECT [a-z_.]+\(\) AS [a-z_.]+\)', 'WRAPPED', 'g'
         ) ~ '(current_app_role|current_sees_all_regions|current_app_region|auth\.uid)\(\)';
  if v_bare > 0 then
    raise exception '% policies still call an identity function per row. Rolling back.', v_bare;
  end if;

  raise notice '0083: % policies rewritten; identity lookups now run once per query.', v_touched;
end;
$$;
