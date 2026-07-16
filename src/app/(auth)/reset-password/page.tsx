import type { Metadata } from "next";
import ResetForm from "./reset-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return <ResetForm />;
}
