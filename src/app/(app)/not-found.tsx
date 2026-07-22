import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm opacity-70">That page doesn&rsquo;t exist.</p>
      <Link href="/" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground">
        Go home
      </Link>
    </main>
  );
}
