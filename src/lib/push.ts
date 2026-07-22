// Client-side Web Push helpers. iOS Safari (16.4+) only exposes the Push API
// to a PWA that's been added to the home screen — there is no permission
// prompt at all from a normal Safari tab, so getSupportState() distinguishes
// "needs install first" from "ready to subscribe" and push-settings.tsx
// renders the right onboarding step for each. Everywhere else (desktop,
// Android Chrome), a normal browser tab already supports it.

import { createClient } from "@/lib/supabase/client";

export type PushSupportState = "unsupported" | "ios-needs-install" | "ready";

function isIOS(): boolean {
  // iPadOS 13+ reports as "MacIntel" but with touch support, unlike a real Mac.
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // Legacy Safari-specific flag; not in the standard navigator typings.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function getPushSupportState(): PushSupportState {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (isIOS() && !isStandalone()) return "ios-needs-install";
  return "ready";
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // The return type annotation must say Uint8Array<ArrayBuffer> explicitly —
  // an unparameterized `Uint8Array` return type widens back to the default
  // Uint8Array<ArrayBufferLike>, which PushSubscriptionOptionsInit.applicationServerKey
  // (ArrayBufferView<ArrayBuffer>) rejects at the type level even though the
  // actual value here is always backed by a fresh, non-shared ArrayBuffer.
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  if (getPushSupportState() === "unsupported") return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

// Must be called from a user gesture handler (a click), and as the first
// await in that handler — iOS Safari revokes the "user activation" flag that
// permits Notification.requestPermission() after other async work runs.
export async function subscribeToPush(): Promise<PushSubscription> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error("Push isn't configured yet (missing VAPID public key).");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this app in your browser/device settings."
        : "Notification permission wasn't granted.",
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
}

// Upserts the subscription into push_subscriptions via the caller's own RLS-
// scoped client — no server action needed, ownership is enforced by RLS
// (user_id = auth.uid()), same trust model as any other user-owned table.
export async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const supabase = createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error("You must be signed in.");

  const keys = subscription.toJSON().keys;
  if (!keys?.p256dh || !keys?.auth) throw new Error("Subscription is missing encryption keys.");

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: userData.user.id,
      endpoint: subscription.endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: navigator.userAgent,
    },
    { onConflict: "endpoint" },
  );
  if (error) throw new Error(error.message);
}

export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getCurrentSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  const supabase = createClient();
  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
}
