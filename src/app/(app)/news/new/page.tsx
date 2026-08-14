import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth/dal";
import { NEWS_AUTHOR_ROLES } from "@/lib/auth/roles";
import NewsPostForm from "../post-form";

export const metadata: Metadata = { title: "New announcement" };

export default async function NewNewsPostPage() {
  const profile = await requireRole(...NEWS_AUTHOR_ROLES);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-6">
      <div>
        <Link
          href="/news"
          className="flex w-fit items-center gap-1 text-sm text-on-surface-variant hover:underline"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>
          News
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-on-surface">New announcement</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Everyone in YMU can read this. Only managers can post.
        </p>
      </div>
      <NewsPostForm userId={profile.id} />
    </main>
  );
}
