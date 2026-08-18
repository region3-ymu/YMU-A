-- ===========================================================================
-- 0073 — the tail of 0072's sweep
-- ===========================================================================
--
-- 0072 collapsed the twenty-one policies and the twelve functions it set out
-- to. Then a leftover check — "which policies or definer functions still spell
-- 'cpo' by hand?" — turned up five more that were never on the list, because
-- they are not region-scoped and so never appeared in any search for
-- current_app_region(). They gate global actions instead, and all five carried
-- the same ('operations_manager','cpo') pair, which now leaves out two roles
-- YMU has declared identical.
--
-- find_substitutes() still names roles after this, and correctly: its list is
-- an allow-list of EVERY manager role including regional_manager, not the
-- global set. So does ticket_owner_for_school(), whose list is an ordered
-- assignment ladder. Those two are the intended exceptions.
-- ===========================================================================

do $do$
declare
  v_patch record;
  v_def text;
begin
  for v_patch in
    select * from (values
      -- Force-closing an attendance session somebody left open.
      ('admin_close_stuck_session',
       $q$coalesce(public.current_app_role() in ('operations_manager', 'cpo'), false) is false$q$,
       $q$public.current_sees_all_regions() is false$q$),
      -- The "any global manager may edit or delete anyone's announcement"
      -- branch. The author's own branch sits beside it and is untouched.
      ('update_news_post',
       $q$v_role in ('operations_manager', 'cpo')$q$,
       $q$public.current_sees_all_regions()$q$),
      ('delete_news_post',
       $q$v_role in ('operations_manager', 'cpo')$q$,
       $q$public.current_sees_all_regions()$q$),
      -- Trigger: who may change a school's region.
      ('protect_school_region',
       $q$public.current_app_role() in ('operations_manager', 'cpo')$q$,
       $q$public.current_sees_all_regions()$q$),
      -- The demo shift, for walking somebody through the app.
      ('start_demo_shift',
       $q$v_role not in ('operations_manager', 'cpo')$q$,
       $q$not public.current_sees_all_regions()$q$)
    ) as t(fn, old_text, new_text)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_patch.fn;

    if v_def is null then
      raise exception 'function %() not found', v_patch.fn;
    end if;

    if position(v_patch.old_text in v_def) = 0 then
      if position(v_patch.new_text in v_def) > 0 then
        continue;
      end if;
      raise exception 'the guard in %() has changed - re-do this patch by hand', v_patch.fn;
    end if;

    execute replace(v_def, v_patch.old_text, v_patch.new_text);
  end loop;
end
$do$;
