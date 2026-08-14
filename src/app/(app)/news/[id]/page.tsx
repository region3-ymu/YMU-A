import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { canPublishNews, displayRole } from "@/lib/auth/roles";
import { getNewsPost, signAttachments } from "@/lib/news/queries";
import { formatDateTime } from "@/lib/format/datetime";
import { markNewsRead } from "../actions";
import DeletePostButton from "./delete-post-button";

export const metadata: Metadata = { title: "Announcement" };

function isImage(mime: string | null) {
  return Boolean(mime?.startsWith("image/"));
}

function prettySize(bytes: number | null) {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function NewsPostPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await requireProfile();
  const { id } = await params;

  const post = await getNewsPost(id);
  if (!post) notFound();

  // Opening it is what marks it read — there is no "mark as read" button to
  // forget to press, and the badge on the menu drains as you work through the
  // list. Deliberately not awaited into the render path's critical work.
  await markNewsRead(post.id);

  const attachments = await signAttachments(post.attachments);
  const canEdit =
    canPublishNews(profile.role) &&
    (post.author_id === profile.id ||
      profile.role === "operations_manager" ||
      profile.role === "cpo");

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
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {post.pinned && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-container px-2.5 py-1 text-xs font-semibold text-on-warning-container">
              <span className="material-symbols-outlined text-sm" aria-hidden>push_pin</span>
              Pinned
            </span>
          )}
        </div>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-on-surface">{post.title}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          {post.author?.full_name ?? "A manager"} ·{" "}
          {displayRole({ role: post.author_role, job_title: null })} ·{" "}
          {formatDateTime(post.published_at)}
          {post.updated_at !== post.published_at && " · edited"}
        </p>
      </div>

      {/* whitespace-pre-wrap, not a markdown renderer: managers type these on a
          phone, and their line breaks are the only formatting they expect to
          survive. */}
      <article className="whitespace-pre-wrap rounded-2xl bg-surface-container p-5 text-on-surface shadow-sm">
        {post.body}
      </article>

      {attachments.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            Attachments
          </h2>
          <ul className="grid gap-3">
            {attachments.map((file) => (
              <li key={file.id} className="overflow-hidden rounded-2xl bg-surface-container shadow-sm">
                {file.url == null ? (
                  <p className="p-4 text-sm text-on-surface-variant">
                    {file.file_name} — couldn&apos;t be loaded.
                  </p>
                ) : (
                  <a href={file.url} target="_blank" rel="noopener noreferrer" className="block">
                    {isImage(file.mime_type) && (
                      // eslint-disable-next-line @next/next/no-img-element -- signed URL on a private bucket; next/image cannot optimise it
                      <img
                        src={file.url}
                        alt={file.file_name}
                        className="max-h-96 w-full object-contain"
                      />
                    )}
                    <span className="flex items-center gap-2 p-4 text-sm font-medium text-primary">
                      <span className="material-symbols-outlined text-base" aria-hidden>
                        {isImage(file.mime_type) ? "image" : "description"}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{file.file_name}</span>
                      {prettySize(file.size_bytes) && (
                        <span className="shrink-0 text-xs font-normal text-on-surface-variant">
                          {prettySize(file.size_bytes)}
                        </span>
                      )}
                    </span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/news/${post.id}/edit`}
            className="inline-flex items-center gap-1.5 rounded-full border-2 border-outline px-4 py-2 text-sm font-bold text-on-surface"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>edit</span>
            Edit
          </Link>
          <DeletePostButton postId={post.id} />
        </div>
      )}
    </main>
  );
}
