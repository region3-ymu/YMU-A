"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signup } from "../actions";
import { Field, FormMessage, SubmitButton } from "../ui";

export default function SignupForm() {
  const [state, action, pending] = useActionState(signup, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Create your account</h2>
      <FormMessage error={state?.error} />
      <Field
        label="Full name"
        name="full_name"
        autoComplete="name"
        required
        error={state?.fieldErrors?.full_name}
      />
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={state?.fieldErrors?.email}
      />
      <Field
        label="Phone"
        name="phone"
        type="tel"
        autoComplete="tel"
        required
        error={state?.fieldErrors?.phone}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        minLength={8}
        error={state?.fieldErrors?.password}
      />
      <SubmitButton pending={pending}>Sign up</SubmitButton>
      <p className="text-sm opacity-70">
        Already have an account?{" "}
        <Link href="/login" className="underline">
          Log in
        </Link>
      </p>
    </form>
  );
}
