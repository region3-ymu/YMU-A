"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState =
  | {
      error?: string;
      fieldErrors?: Record<string, string>;
      success?: string;
    }
  | undefined;

async function requestOrigin(): Promise<string> {
  const origin = (await headers()).get("origin");
  return origin ?? "http://localhost:3000";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    return { error: error.message };
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
    return { error: error.message };
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
    return { error: error.message };
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
    return { error: error.message };
  }
  return { success: "Verification email sent — check your inbox." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
