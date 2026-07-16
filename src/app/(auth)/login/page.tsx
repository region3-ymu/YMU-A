import type { Metadata } from "next";
import LoginForm from "./login-form";

export const metadata: Metadata = { title: "Log in" };

const ERROR_MESSAGES: Record<string, string> = {
  archived:
    "This account has been archived. Contact your operations manager if you think this is a mistake.",
  confirm:
    "That confirmation link is invalid or has expired. Log in or request a new one.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <LoginForm initialError={error ? ERROR_MESSAGES[error] : undefined} />;
}
