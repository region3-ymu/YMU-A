"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset } from "../actions";
import { Field, FormMessage, SubmitButton } from "../ui";

export default function ResetForm() {
  const [state, action, pending] = useActionState(
    requestPasswordReset,
    undefined,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Reset your password</h2>
      <p className="text-sm opacity-70">
        Enter your email and we&rsquo;ll send you a link to set a new password.
      </p>
      <FormMessage error={state?.error} success={state?.success} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <SubmitButton pending={pending}>Send reset link</SubmitButton>
      <p className="text-sm opacity-70">
        <Link href="/login" className="underline">
          Back to log in
        </Link>
      </p>
    </form>
  );
}
