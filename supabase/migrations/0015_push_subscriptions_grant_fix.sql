-- Fix: saveSubscription() (src/lib/push.ts) upserts on the `endpoint` unique
-- constraint (INSERT ... ON CONFLICT (endpoint) DO UPDATE ...) so re-enabling
-- push on an already-known endpoint hits the UPDATE branch. 0014 granted
-- authenticated only select/insert/delete on push_subscriptions -- missing
-- update caused "permission denied for table push_subscriptions" on any
-- upsert that resolved to an update (confirmed live: a real user hit this
-- tapping "Enable notifications"). The RLS policy (push_subscriptions_own,
-- `for all`) already covers update at the policy level; this was purely a
-- missing base table grant, not an RLS bug.

grant update on table public.push_subscriptions to authenticated;
