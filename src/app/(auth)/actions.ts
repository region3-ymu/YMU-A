"use server";

import { redirect } from "next/navigation";
import { requestOrigin } from "@/lib/http/origin";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState =
  | {
      error?: string;
      fieldErrors?: Record<string, string>;
      success?: string;
    }
  | undefined;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turns an auth error into something worth reading.
 *
 * supabase-js falls back to JSON.stringify() when the auth server returns a
 * shape it doesn't recognise, so `error.message` can arrive as the literal
 * string "{}" — which we rendered verbatim, giving a teacher a sign-in screen
 * that just said "{}". That happened for real: a demo account inserted straight
 * into auth.users had NULL token columns, GoTrue failed with `converting NULL
 * to string is unsupported`, and none of it reached the screen or the logs.
 *
 * The real error still goes to the server log, where it is diagnosable; the
 * screen gets a sentence that tells the person what to do next.
 */
function readableAuthError(error: { message?: string; code?: string; status?: number }): string {
  const raw = (error.message ?? "").trim();
  const useless = raw === "" || raw === "{}" || raw === "[object Object]" || raw.startsWith("{");
  console.error(
    `[auth] sign-in failed (code=${error.code ?? "none"} status=${error.status ?? "none"}): ${raw || "(empty message)"}`,
  );
  if (!useless) return raw;
  return "Something went wrong signing in. Please try again, and tell your manager if it keeps happening.";
}

export async function login(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) {
    if (error.code === "email_not_confirmed") {
      return {
        error:
          "Your email isn't verified yet — check your inbox for the confirmation link.",
      };
    }
    if (error.code === "invalid_credentials") {
      return { error: "Wrong email or password." };
    }
    return { error: readableAuthError(error) };
  }

  // Archived-account gate at the front door: never leave an archived user
  // with a session. (The DAL repeats this check for sessions that were
  // already live when the account got archived.)
  const { data: profile } = await supabase
    .from("profiles")
    .select("archived_at")
    .eq("id", data.user.id)
    .single();
  if (profile?.archived_at) {
    await supabase.auth.signOut();
    return {
      error:
        "This account has been archived. Contact your operations manager if you think this is a mistake.",
    };
  }

  redirect("/");
}

export async function signup(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const fullName = String(formData.get("full_name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  const fieldErrors: Record<string, string> = {};
  if (fullName.length < 2) {
    fieldErrors.full_name = "Enter your full name.";
  }
  if (!EMAIL_RE.test(email)) {
    fieldErrors.email = "Enter a valid email address.";
  }
  if (phone.replace(/\D/g, "").length < 7) {
    fieldErrors.phone = "Enter a phone number managers can reach you on.";
  }
  if (password.length < 8) {
    fieldErrors.password = "Password must be at least 8 characters.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Picked up by the handle_new_user trigger to build the profile row.
      data: { full_name: fullName, phone },
      emailRedirectTo: `${await requestOrigin()}/auth/confirm`,
    },
  });
  if (error) {
    return { error: readableAuthError(error) };
  }

  redirect("/verify-email");
}

export async function requestPasswordReset(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${await requestOrigin()}/auth/confirm?next=/update-password`,
  });

  // Same message whether or not the account exists.
  return {
    success:
      "If an account exists for that email, a reset link is on its way.",
  };
}

export async function updatePassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "The two passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    return { error: readableAuthError(error) };
  }

  redirect("/");
}

export async function resendVerification(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!EMAIL_RE.test(email)) {
    return { error: "Enter a valid email address." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: `${await requestOrigin()}/auth/confirm` },
  });
  if (error) {
    return { error: readableAuthError(error) };
  }
  return { success: "Verification email sent — check your inbox." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
