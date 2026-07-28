"use client";

import Link from "next/link";
import { useActionState } from "react";
import { login } from "../actions";
import { Field, FormMessage, SubmitButton } from "../ui";

export default function LoginForm({
  initialError,
}: {
  initialError?: string;
}) {
  const [state, action, pending] = useActionState(login, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="text-center">
        <h2 className="text-xl font-bold text-on-surface">Welcome back</h2>
        <p className="mt-0.5 text-sm text-on-surface-variant">
          Sign in to continue.
        </p>
      </div>
      <FormMessage error={state?.error ?? initialError} />
      <Field
        label="Email address"
        name="email"
        type="email"
        icon="mail"
        placeholder="you@example.org"
        autoComplete="email"
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        icon="lock"
        placeholder="••••••••"
        autoComplete="current-password"
        required
      />
      <SubmitButton pending={pending}>Sign in</SubmitButton>
      <div className="flex items-center justify-between text-sm">
        <Link
          href="/reset-password"
          className="font-medium text-primary hover:underline"
        >
          Forgot password?
        </Link>
        <Link
          href="/signup"
          className="font-medium text-primary hover:underline"
        >
          Create account
        </Link>
      </div>
    </form>
  );
}
