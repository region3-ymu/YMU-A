import type { Metadata } from "next";
import Link from "next/link";
import ResendForm from "./resend-form";

export const metadata: Metadata = { title: "Verify your email" };

export default function VerifyEmailPage() {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-center text-xl font-bold text-on-surface">
        Check your inbox
      </h2>
      <p className="text-sm text-on-surface-variant">
        We sent you a confirmation link. Open it on this device to finish
        setting up your account, then log in.
      </p>
      <p className="text-sm text-on-surface-variant">
        Nothing arrived after a few minutes? Check spam, or resend it below.
        (Emails are rate-limited during early testing — a couple per hour.)
      </p>
      <ResendForm />
      <p className="text-center text-sm text-on-surface-variant">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
