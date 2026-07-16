import type { Metadata } from "next";
import UpdateForm from "./update-form";

export const metadata: Metadata = { title: "New password" };

export default function UpdatePasswordPage() {
  return <UpdateForm />;
}
