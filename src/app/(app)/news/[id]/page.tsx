import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth/dal";
import { canPublishNews, displayRole } from "@/lib/auth/roles";
import { getNewsPost, newsAudienceLabel } from "@/lib/news/queries";
import { formatDateTime } from "@/lib/format/datetime";
import { linkify } from "@/lib/format/linkify";
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

  const canEdit =
    canPublishNews(profile.role) &&
    (post.author_id === profile.id ||
      profile.role === "operations_manager" ||
      profile.role === "cpo");

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-2xl flex-1 flex-col gap-5 p-6">
      <div className="min-w-0">
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
          {canPublishNews(profile.role) && newsAudienceLabel(post) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-semibold text-on-surface-variant">
              <span className="material-symbols-outlined text-sm" aria-hidden>group</span>
              {newsAudienceLabel(post)}
            </span>
          )}
        </div>
        <h1 className="mt-1 break-words text-2xl font-bold tracking-tight text-on-surface">{post.title}</h1>
        <p className="mt-1 break-words text-sm text-on-surface-variant">
          {post.author?.full_name ?? "A manager"} ·{" "}
          {displayRole({ role: post.author_role, job_title: null })} ·{" "}
          {formatDateTime(post.published_at)}
          {post.updated_at !== post.published_at && " · edited"}
        </p>
      </div>

      {/* whitespace-pre-wrap, not a markdown renderer: managers type these on a
          phone, and their line breaks are the only formatting they expect to
          survive. linkify() is the one exception — a pasted form link is the
          point of half these posts, and plain text made it untappable.

          break-words + min-w-0 for the same reason the schedules detail page
          carries them: whitespace-pre-wrap does not break inside a word, and
          two of the four posts on this board hold a bare Google Forms URL of
          99 and 118 characters. As a flex item with the default
          min-width:auto, the article sized itself to that token rather than
          being held to max-w-2xl, and dragged the whole document sideways. */}
      <article className="min-w-0 whitespace-pre-wrap break-words rounded-2xl bg-surface-container p-5 text-on-surface shadow-sm">
        {linkify(post.body)}
      </article>

      {post.attachments.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-on-surface-variant">
            Attachments
          </h2>
          <ul className="grid gap-3">
            {post.attachments.map((file) => {
              // Not a signed storage URL: this page gets cached by the service
              // worker for up to a week and a signed URL is dead after an
              // hour, so the token is minted per request behind this id
              // instead — see src/app/api/news-attachment/[id]/route.ts.
              const href = `/api/news-attachment/${file.id}`;
              return (
                <li key={file.id} className="overflow-hidden rounded-2xl bg-surface-container shadow-sm">
                  <a href={href} target="_blank" rel="noopener noreferrer" className="block">
                    {isImage(file.mime_type) && (
                      // eslint-disable-next-line @next/next/no-img-element -- private bucket behind an auth check; next/image cannot optimise it
                      <img
                        src={href}
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
                </li>
              );
            })}
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
