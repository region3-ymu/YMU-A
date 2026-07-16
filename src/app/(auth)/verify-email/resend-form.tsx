"use client";

import { useActionState } from "react";
import { resendVerification } from "../actions";
import { Field, FormMessage, SubmitButton } from "../ui";

export default function ResendForm() {
  const [state, action, pending] = useActionState(
    resendVerification,
    undefined,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <FormMessage error={state?.error} success={state?.success} />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
      />
      <SubmitButton pending={pending}>Resend verification email</SubmitButton>
    </form>
  );
}
