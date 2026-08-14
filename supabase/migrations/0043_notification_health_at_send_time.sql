-- Two fixes to the dashboard's notification tiles, plus the roster query the
-- second tile should have been asking all along.
--
-- 1. `real_failures` was retroactively wrong. 0038 asks "does this recipient
--    have a push subscription?" at QUERY time, so the moment a teacher finally
--    installs the app, every notification that failed while they had no device
--    is reclassified as a genuine delivery failure. On 2026-08-14 the tile read
--    97: 95 rows for Jose Heredia and 2 for Nolan Slate, who subscribed at
--    17:56 and 15:47 that same day. Every one of those 97 predates the
--    subscription; neither has had a single failure since. The question has to
--    be asked as of the notification's own creation time.
--
-- 2. The `email_status = 'failed'` leg is dead. 0039 turned the email channel
--    off at the source (nothing enqueues 'pending' any more) and nulled the
--    backlog, so this clause can only ever match zero rows. Dropping it means
--    one less thing to reason about when the tile is non-zero.
--
-- 3. `no_device_recipients` counts whoever happened to have a notification
--    queued in the last 24 hours -- so it drifts day to day, silently omits a
--    teacher who had no class, and (because late_clock_in/gps_out_of_fence are
--    manager-facing) can count managers under a tile labelled "teachers".
--    teachers_without_app() below answers the question the manager is actually
--    asking: which of my teachers have not installed it.

create or replace function public.notification_health(p_hours integer default 24)
returns table (
  real_failures integer,
  no_device_recipients integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with recent as (
    select n.id, n.recipient_id, n.status,
           exists (
             select 1 from public.push_subscriptions ps
              where ps.user_id = n.recipient_id
                -- As of when the notification was created, not as of now.
                -- A device registered afterwards could not have received it.
                and ps.created_at <= n.created_at
           ) as had_device
      from public.notification_queue n
     where n.created_at >= now() - make_interval(hours => p_hours)
  )
  select
    -- A send that actually broke: there WAS somewhere to deliver it at the
    -- time, and it still did not arrive.
    (select count(*) from recent
      where status = 'failed' and had_device)::integer,
    -- People, not rows: twelve missed reminders for one teacher is one
    -- conversation, not twelve problems.
    (select count(distinct recipient_id) from recent
      where not had_device and status in ('failed', 'no_device'))::integer;
$$;

comment on function public.notification_health(integer) is
  'Dashboard counts: sends that genuinely broke, and how many people had no device when something was queued for them. has_device is evaluated as of each notification''s created_at — evaluating it as of now() made a teacher''s whole pre-install backlog look like real failures the day they installed the app.';

revoke execute on function public.notification_health(integer) from public, anon;
grant execute on function public.notification_health(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Who has not installed the app
-- ---------------------------------------------------------------------------
-- A push_subscriptions row is the only signal the app has that someone
-- installed it (there is no device registry, and install-prompt dismissal is
-- kept in localStorage and never reaches the server). push_subscriptions is
-- RLS'd to own-rows-only, so a manager cannot ask this question directly --
-- hence security definer, scoped back down with can_read_profile() so a
-- Regional Manager sees their own teachers and CPO/OM/Academic Manager see
-- everyone, exactly as they do everywhere else.

create or replace function public.teachers_without_app()
returns table (
  teacher_id uuid,
  full_name text,
  has_upcoming_classes boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.full_name,
    exists (
      select 1 from public.calendar_events ce
       where ce.teacher_ids @> array[p.id]
         and ce.status <> 'cancelled'
         and ce.start_at >= now()
         and ce.start_at < now() + interval '30 days'
    )
  from public.profiles p
  where p.role = 'teacher'
    and p.archived_at is null
    and not exists (
      select 1 from public.push_subscriptions ps where ps.user_id = p.id
    )
    and public.can_read_profile(p.id)
  -- Teachers with classes coming up are the ones worth chasing first.
  order by 3 desc, p.full_name;
$$;

comment on function public.teachers_without_app() is
  'Non-archived teachers with no push subscription — the closest thing to "has not installed the app" the schema can answer. Scoped by can_read_profile(), so a Regional Manager sees their region and CPO/OM/Academic Manager see everyone. has_upcoming_classes flags who to chase first.';

revoke execute on function public.teachers_without_app() from public, anon;
grant execute on function public.teachers_without_app() to authenticated;
