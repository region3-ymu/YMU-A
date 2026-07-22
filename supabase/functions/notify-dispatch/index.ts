// @ts-nocheck
// Phase 7: drains notification_queue (Web Push + Resend email backup) on a
// 1-minute pg_cron schedule — same shared-secret-header + service-role-client
// shape as calendar-sync/check-closeout/late-detect. Two steps per run:
//   1. enqueue_reminder_notifications() — generates any due be_there_soon /
//      clock_in_reminder / clock_out_reminder rows (see the migration).
//   2. Drain: fetch pending rows, decide push/email eligibility with the pure
//      planDispatch() (dispatch-logic.ts), send, record the outcome.
//
// Web Push encryption (ECDH P-256 + HKDF + AES-128-GCM) and VAPID JWT signing
// use npm:web-push rather than hand-rolled WebCrypto (user-confirmed
// deviation from this project's usual dependency-minimalism — see
// DECISIONS.md: a push-crypto bug is silent on a real device, with nothing
// to catch it in a test).
import { createClient } from "npm:@supabase/supabase-js@2.110.6";
import webpush from "npm:web-push@3.6.7";
import {
  type PreferenceType,
  planDispatch,
  notificationCopy,
  type QueueRow,
  EMAIL_DAILY_CAP,
  utcDateKey,
} from "./dispatch-logic.ts";
import { secretsMatch } from "../_shared/secret.ts";

declare const Deno: {
  env: { get(key: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const BATCH_LIMIT = 500; // bounds one run's work; the 1-minute cadence picks up any remainder next run.

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed. Use POST." }, 405);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("NOTIFY_DISPATCH_SECRET");
  const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ops@example.org";
  // Push is the core deliverable this phase — hard-fail if it's not
  // configured, same as check-closeout/late-detect hard-failing on their one
  // capability. Email is a backup channel, not the whole function's job, so
  // its absence degrades gracefully below instead of 500ing here.
  if (!url || !serviceRoleKey || !secret || !vapidPublicKey || !vapidPrivateKey) {
    console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NOTIFY_DISPATCH_SECRET, or VAPID keys missing.");
    return json({ error: "Notification dispatch is not configured." }, 500);
  }

  if (!(await secretsMatch(request.headers.get("x-notify-dispatch-secret"), secret))) {
    return json({ error: "Unauthorized." }, 401);
  }

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const resendFromEmail = Deno.env.get("RESEND_FROM_EMAIL");
  const emailConfigured = Boolean(resendApiKey && resendFromEmail);
  // Base URL for links in email bodies. Falls back to the current production
  // deployment so a missing env var degrades to today's behavior rather than a
  // broken link, but set SITE_URL so the address isn't hardcoded here.
  const siteUrl = (Deno.env.get("SITE_URL") ?? "https://ymu-a-navy.vercel.app").replace(/\/$/, "");
  if (!emailConfigured) {
    console.warn("RESEND_API_KEY/RESEND_FROM_EMAIL not set — push will still send, email backups will be skipped.");
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: enqueuedCount, error: enqueueError } = await supabase.rpc("enqueue_reminder_notifications");
  if (enqueueError) {
    console.error("enqueue_reminder_notifications failed", enqueueError);
    return json({ error: enqueueError.message }, 500);
  }

  // Atomically CLAIM a batch instead of a plain select. A run that exceeds the
  // 1-minute cron cadence would otherwise overlap the next run, both reading
  // the same still-'pending' rows and sending each push/email twice.
  // claim_notification_batch stamps claimed_at under FOR UPDATE SKIP LOCKED, so
  // a concurrent run skips rows this run just claimed; a claim older than the
  // lease window is reclaimable, so a crashed run's rows are never stranded.
  const { data: rows, error: fetchError } = await supabase.rpc("claim_notification_batch", {
    p_limit: BATCH_LIMIT,
  });
  if (fetchError) {
    console.error("Claiming pending notification_queue rows failed", fetchError);
    return json({ error: fetchError.message }, 500);
  }
  const pending = (rows ?? []) as QueueRow[];

  if (pending.length === 0) {
    return json({ enqueued: enqueuedCount ?? 0, processed: 0, pushSent: 0, pushFailed: 0, emailSent: 0, emailFailed: 0 });
  }

  // Preferences: one query for every (recipient, type) pair actually
  // present in this batch, rather than one query per row.
  const recipientIds = Array.from(new Set(pending.map((r) => r.recipient_id)));
  const { data: prefRows } = await supabase
    .from("notification_preferences")
    .select("user_id, type, enabled")
    .in("user_id", recipientIds);
  const prefMap = new Map<string, { enabled: boolean }>();
  for (const p of prefRows ?? []) prefMap.set(`${p.user_id}:${p.type}`, { enabled: p.enabled });

  const todayKey = utcDateKey(new Date().toISOString());
  const { count: emailSentToday } = await supabase
    .from("notification_queue")
    .select("id", { count: "exact", head: true })
    .eq("email_status", "sent")
    .gte("email_sent_at", `${todayKey}T00:00:00.000Z`);

  const decisions = planDispatch(pending, {
    isPreferenceEnabled: (recipientId: string, type: PreferenceType) => prefMap.get(`${recipientId}:${type}`),
    emailSentToday: emailSentToday ?? 0,
    emailDailyCap: EMAIL_DAILY_CAP,
  });

  // Push subscriptions for every recipient that needs at least one push this run.
  const pushRecipientIds = Array.from(new Set(decisions.filter((d) => d.sendPush).map((d) => d.row.recipient_id)));
  const { data: subRows } = pushRecipientIds.length
    ? await supabase.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", pushRecipientIds)
    : { data: [] };
  const subsByUser = new Map<string, typeof subRows>();
  for (const sub of subRows ?? []) {
    const list = subsByUser.get(sub.user_id) ?? [];
    list.push(sub);
    subsByUser.set(sub.user_id, list);
  }

  const staleSubscriptionIds: string[] = [];
  const pushSentIds: string[] = [];
  const pushFailedIds: string[] = []; // attempts incremented, not yet at the cap
  const pushGaveUpIds: string[] = []; // hit MAX_PUSH_ATTEMPTS this run

  const emailCache = new Map<string, string | null>(); // recipient_id -> email (or null if lookup failed)
  const emailSentIds: string[] = [];
  const emailFailedIds: string[] = [];

  for (const decision of decisions) {
    const { row } = decision;

    if (decision.sendPush) {
      const subs = subsByUser.get(row.recipient_id) ?? [];
      const copy = notificationCopy(row);
      const payloadJson = JSON.stringify({ title: copy.title, body: copy.body, url: copy.url });
      let anySucceeded = false;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payloadJson,
          );
          anySucceeded = true;
        } catch (err) {
          const statusCode = err?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            staleSubscriptionIds.push(sub.id); // endpoint gone — self-clean rather than retry it forever
          } else {
            console.error(`Push send failed for subscription ${sub.id} (row ${row.id})`, err);
          }
        }
      }
      if (anySucceeded) {
        pushSentIds.push(row.id);
      } else {
        const nextAttempts = row.attempts + 1;
        if (nextAttempts >= 5) pushGaveUpIds.push(row.id);
        else pushFailedIds.push(row.id);
      }
    }

    if (decision.sendEmail && emailConfigured) {
      if (!emailCache.has(row.recipient_id)) {
        const { data: userData, error: userError } = await supabase.auth.admin.getUserById(row.recipient_id);
        emailCache.set(row.recipient_id, userError ? null : userData?.user?.email ?? null);
      }
      const email = emailCache.get(row.recipient_id);
      if (!email) {
        emailFailedIds.push(row.id);
        console.error(`No email on file for recipient ${row.recipient_id} (row ${row.id})`);
        continue;
      }
      const copy = notificationCopy(row);
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: resendFromEmail,
            to: email,
            subject: copy.title,
            text: `${copy.body}\n\nOpen YMU-A: ${siteUrl}${copy.url}`,
          }),
        });
        if (res.ok) {
          emailSentIds.push(row.id);
        } else {
          const body = await res.text();
          console.error(`Resend send failed for row ${row.id}: ${res.status} ${body}`);
          emailFailedIds.push(row.id);
        }
      } catch (err) {
        console.error(`Resend request threw for row ${row.id}`, err);
        emailFailedIds.push(row.id);
      }
    }
  }

  const nowIso = new Date().toISOString();
  await Promise.all([
    staleSubscriptionIds.length
      ? supabase.from("push_subscriptions").delete().in("id", staleSubscriptionIds)
      : Promise.resolve(),
    pushSentIds.length
      ? supabase.from("notification_queue").update({ status: "sent", sent_at: nowIso }).in("id", pushSentIds)
      : Promise.resolve(),
    pushGaveUpIds.length
      ? supabase.from("notification_queue").update({ status: "failed" }).in("id", pushGaveUpIds)
      : Promise.resolve(),
    emailSentIds.length
      ? supabase.from("notification_queue").update({ email_status: "sent", email_sent_at: nowIso }).in("id", emailSentIds)
      : Promise.resolve(),
    emailFailedIds.length
      ? supabase.from("notification_queue").update({ email_status: "failed" }).in("id", emailFailedIds)
      : Promise.resolve(),
  ]);

  // attempts increments individually (no bulk "increment by 1" in PostgREST)
  // — small volume (failed-this-run rows only), so N small updates is fine.
  await Promise.all(
    pushFailedIds.map((id) => {
      const current = pending.find((r) => r.id === id)?.attempts ?? 0;
      return supabase.from("notification_queue").update({ attempts: current + 1 }).eq("id", id);
    }),
  );
  await Promise.all(
    pushGaveUpIds.map((id) => {
      const current = pending.find((r) => r.id === id)?.attempts ?? 0;
      return supabase.from("notification_queue").update({ attempts: current + 1 }).eq("id", id);
    }),
  );

  return json({
    enqueued: enqueuedCount ?? 0,
    processed: pending.length,
    pushSent: pushSentIds.length,
    pushFailed: pushFailedIds.length + pushGaveUpIds.length,
    staleSubscriptionsRemoved: staleSubscriptionIds.length,
    emailSent: emailSentIds.length,
    emailFailed: emailFailedIds.length,
    emailConfigured,
  });
});
