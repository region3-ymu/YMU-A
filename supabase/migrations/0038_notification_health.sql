-- Split "notification failures" into the two very different things it was
-- lumping together.
--
-- On the first real day of term the manager dashboard read 244 notification
-- failures. 218 of them were not failures: most teachers have never added the
-- app to their home screen, so they have no push subscription, and
-- notify-dispatch was retrying those five times and then marking them
-- `failed`. The 15 genuine send failures were invisible inside that number,
-- which is the actual cost — a warning nobody can act on trains people to
-- ignore the tile.
--
-- Computed here rather than read off `status` so it is right regardless of
-- whether the Edge Function carrying the matching fix has been deployed yet:
-- this joins push_subscriptions and answers from first principles.

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
    select n.id, n.recipient_id, n.status, n.email_status,
           exists (
             select 1 from public.push_subscriptions ps
              where ps.user_id = n.recipient_id
           ) as has_device
      from public.notification_queue n
     where n.created_at >= now() - make_interval(hours => p_hours)
  )
  select
    -- A send that actually broke: there WAS somewhere to deliver it, and it
    -- still did not arrive. Email failures count however the push went, since
    -- a bounced email is its own problem.
    (select count(*) from recent
      where (status = 'failed' and has_device) or email_status = 'failed')::integer,
    -- People, not rows: twelve missed reminders for one teacher is one
    -- conversation, not twelve problems.
    (select count(distinct recipient_id) from recent
      where not has_device and status in ('failed', 'no_device'))::integer;
$$;

comment on function public.notification_health(integer) is
  'Dashboard counts: sends that genuinely broke, and how many people have no device to receive push at all. Deliberately does not trust notification_queue.status alone — it joins push_subscriptions so the answer is correct even before notify-dispatch ships its matching no_device state.';

revoke execute on function public.notification_health(integer) from public, anon;
grant execute on function public.notification_health(integer) to authenticated;
