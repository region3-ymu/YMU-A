import type { Metadata } from "next";
import Link from "next/link";
import ResendForm from "./resend-form";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Check your inbox</h2>
      <p className="text-sm opacity-70">
        We sent you a confirmation link. Open it on this device to finish
        setting up your account, then log in.
      </p>
      <p className="text-sm opacity-70">
        Nothing arrived after a few minutes? Check spam, or resend it below.
        (Emails are rate-limited during early testing — a couple per hour.)
      </p>
      <ResendForm />
      <p className="text-sm opacity-70">
        <Link href="/login" className="underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
