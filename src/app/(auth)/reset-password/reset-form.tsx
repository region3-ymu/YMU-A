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
      <h2 className="text-center text-xl font-bold text-on-surface">
        Reset your password
      </h2>
      <p className="text-center text-sm text-on-surface-variant">
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
      <p className="text-center text-sm text-on-surface-variant">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to log in
        </Link>
      </p>
    </form>
  );
}
