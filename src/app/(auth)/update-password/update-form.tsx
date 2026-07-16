"use client";

import { useActionState } from "react";
import { updatePassword } from "../actions";
import { Field, FormMessage, SubmitButton } from "../ui";

export default function UpdateForm() {
  const [state, action, pending] = useActionState(updatePassword, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Choose a new password</h2>
      <FormMessage error={state?.error} />
      <Field
        label="New password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
      />
      <Field
        label="Repeat new password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
      />
      <SubmitButton pending={pending}>Save password</SubmitButton>
    </form>
  );
}
