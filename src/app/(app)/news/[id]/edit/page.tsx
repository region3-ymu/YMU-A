import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { NEWS_AUTHOR_ROLES } from "@/lib/auth/roles";
import { getNewsPost } from "@/lib/news/queries";
import NewsPostForm from "../../post-form";

export const metadata: Metadata = { title: "Edit announcement" };

export default async function EditNewsPostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const profile = await requireRole(...NEWS_AUTHOR_ROLES);
  const { id } = await params;

  const post = await getNewsPost(id);
  if (!post) notFound();

  // Same rule update_news_post() enforces in SQL: your own, or anyone's if you
  // run the place. Checked here too so an author who cannot edit is sent back
  // rather than shown a form that will refuse to save.
  const canEdit =
    post.author_id === profile.id ||
    profile.role === "operations_manager" ||
    profile.role === "cpo";
  if (!canEdit) redirect(`/news/${id}`);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 p-6">
      <div>
        <Link
          href={`/news/${id}`}
          className="flex w-fit items-center gap-1 text-sm text-on-surface-variant hover:underline"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>arrow_back</span>
          Back
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-on-surface">Edit announcement</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Editing doesn&apos;t send another notification.
        </p>
      </div>
      <NewsPostForm
        userId={profile.id}
        post={{ id: post.id, title: post.title, body: post.body, pinned: post.pinned }}
      />
    </main>
  );
}
