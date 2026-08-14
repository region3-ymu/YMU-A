import type { Metadata } from "next";
import Link from "next/link";
import { requireProfile } from "@/lib/auth/dal";
import { canPublishNews, displayRole } from "@/lib/auth/roles";
import { getNewsFeed } from "@/lib/news/queries";
import { formatDateTime } from "@/lib/format/datetime";

export const metadata: Metadata = { title: "News" };

// The announcements board. Everyone signed in reads it; the four manager roles
// can post. No route gate — a teacher landing here is the intended case.
export default async function NewsPage() {
  const profile = await requireProfile();
  const { posts, readIds } = await getNewsFeed();
  const canPost = canPublishNews(profile.role);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container"
            aria-hidden
          >
            <span className="material-symbols-outlined">campaign</span>
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-on-surface">News</h1>
            <p className="mt-1 text-sm text-on-surface-variant">
              Announcements, resources and cover requests.
            </p>
          </div>
        </div>
        {canPost && (
          <Link
            href="/news/new"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-bold text-on-primary shadow-sm active:scale-[0.98]"
          >
            <span className="material-symbols-outlined text-base" aria-hidden>add</span>
            Post
          </Link>
        )}
      </header>

      {posts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-surface-container p-8 text-center shadow-sm">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant" aria-hidden>
            campaign
          </span>
          <p className="text-sm text-on-surface-variant">
            {canPost ? "Nothing posted yet — you could be first." : "Nothing posted yet."}
          </p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {posts.map((post) => {
            const unread = !readIds.has(post.id);
            return (
              <li key={post.id}>
                <Link
                  href={`/news/${post.id}`}
                  className="relative block overflow-hidden rounded-2xl bg-surface-container p-4 pl-5 shadow-sm transition-transform active:scale-[0.99]"
                >
                  {/* Unread gets the accent stripe, pinned gets the label.
                      They are different questions and a reader can want both. */}
                  <div
                    className={`absolute inset-y-0 left-0 w-1.5 ${unread ? "bg-primary" : "bg-transparent"}`}
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {post.pinned && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning-container px-2.5 py-1 text-xs font-semibold text-on-warning-container">
                        <span className="material-symbols-outlined text-sm" aria-hidden>push_pin</span>
                        Pinned
                      </span>
                    )}
                    {unread && (
                      <span className="rounded-full bg-primary px-2.5 py-1 text-xs font-bold text-on-primary">
                        New
                      </span>
                    )}
                    {post.attachments.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-on-surface-variant">
                        <span className="material-symbols-outlined text-sm" aria-hidden>attach_file</span>
                        {post.attachments.length}
                      </span>
                    )}
                  </div>
                  <p className={`mt-1 text-base ${unread ? "font-bold" : "font-semibold"} text-on-surface`}>
                    {post.title}
                  </p>
                  {/* Two lines of the body as a preview — enough to tell a
                      cover request from a newsletter without opening it. */}
                  <p className="mt-0.5 line-clamp-2 text-sm text-on-surface-variant">{post.body}</p>
                  <p className="mt-2 text-xs text-on-surface-variant">
                    {post.author?.full_name ?? "A manager"} ·{" "}
                    {displayRole({ role: post.author_role, job_title: null })} ·{" "}
                    {formatDateTime(post.published_at)}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
