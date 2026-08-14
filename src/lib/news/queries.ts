import { createClient } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

// Reads for the announcements board. Everything is RLS-scoped: news_posts is
// readable by anyone signed in, and news_reads is readable only by its owner,
// so "unread" is inherently per-reader with no filtering here.

export type NewsAttachment = {
  id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
};

export type NewsPost = {
  id: string;
  author_id: string;
  author_role: AppRole;
  title: string;
  body: string;
  pinned: boolean;
  published_at: string;
  updated_at: string;
  author: { full_name: string } | null;
  attachments: NewsAttachment[];
};

const POST_COLUMNS = `
  id, author_id, author_role, title, body, pinned, published_at, updated_at,
  author:profiles!news_posts_author_id_fkey(full_name),
  attachments:news_attachments(id, storage_path, file_name, mime_type, size_bytes)
`;

/**
 * The feed: pinned first, then newest.
 *
 * Ordered in SQL rather than in the browser because "pinned" is the whole
 * point of pinning — a cover request that sorts below last week's newsletter
 * because the client re-sorted is worse than no pin at all.
 */
export async function getNewsFeed(): Promise<{ posts: NewsPost[]; readIds: Set<string> }> {
  const supabase = await createClient();
  const [{ data: posts }, { data: reads }] = await Promise.all([
    supabase
      .from("news_posts")
      .select(POST_COLUMNS)
      .order("pinned", { ascending: false })
      .order("published_at", { ascending: false })
      .limit(100),
    supabase.from("news_reads").select("post_id"),
  ]);

  return {
    posts: (posts as unknown as NewsPost[]) ?? [],
    readIds: new Set(((reads as { post_id: string }[] | null) ?? []).map((r) => r.post_id)),
  };
}

export async function getNewsPost(id: string): Promise<NewsPost | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("news_posts").select(POST_COLUMNS).eq("id", id).maybeSingle();
  return (data as unknown as NewsPost) ?? null;
}

/**
 * Short-lived signed URLs for a post's attachments.
 *
 * The bucket is private, so nothing is readable by URL alone. One hour matches
 * the app-feedback screenshots — long enough to open a PDF, short enough that
 * a copied link is not a permanent hole.
 */
export async function signAttachments(
  attachments: NewsAttachment[],
): Promise<(NewsAttachment & { url: string | null })[]> {
  if (attachments.length === 0) return [];
  const supabase = await createClient();
  return Promise.all(
    attachments.map(async (attachment) => {
      const { data } = await supabase.storage
        .from("news")
        .createSignedUrl(attachment.storage_path, 3600);
      return { ...attachment, url: data?.signedUrl ?? null };
    }),
  );
}

export async function getUnreadNewsCount(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("unread_news_count");
  if (error) {
    console.error(`[news] unread_news_count failed: ${error.message}`);
    return 0;
  }
  return (data as number | null) ?? 0;
}
