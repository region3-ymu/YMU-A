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
      <h2 className="text-lg font-semibold">Log in</h2>
      <FormMessage error={state?.error ?? initialError} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <SubmitButton pending={pending}>Log in</SubmitButton>
      <div className="flex justify-between text-sm">
        <Link href="/reset-password" className="underline opacity-70">
          Forgot password?
        </Link>
        <Link href="/signup" className="underline opacity-70">
          Create account
        </Link>
      </div>
    </form>
  );
}
