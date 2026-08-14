"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/dal";
import { NEWS_AUTHOR_ROLES } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";

export type NewsFormState = { error?: string } | undefined;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Attachments are uploaded straight to the private 'news' bucket from the
// browser before this runs (same arrangement as the app-feedback screenshot),
// so all that arrives here is metadata. The storage policy already refuses a
// path outside the uploader's own folder, and create_news_post() refuses to
// record one — belt and braces, because a hand-crafted POST is the only way
// either check gets exercised.
type AttachmentInput = {
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
};

function readAttachments(formData: FormData): AttachmentInput[] {
  const raw = String(formData.get("attachments") ?? "[]");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const a = item as Record<string, unknown>;
      if (typeof a.storage_path !== "string" || !a.storage_path.trim()) return [];
      return [
        {
          storage_path: a.storage_path,
          file_name: typeof a.file_name === "string" ? a.file_name : "attachment",
          mime_type: typeof a.mime_type === "string" ? a.mime_type : null,
          size_bytes: typeof a.size_bytes === "number" ? a.size_bytes : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

export async function publishNewsPost(
  _previous: NewsFormState,
  formData: FormData,
): Promise<NewsFormState> {
  await requireRole(...NEWS_AUTHOR_ROLES);

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title) return { error: "Give the announcement a title." };
  if (!body) return { error: "Write something in the announcement." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_news_post", {
    p_title: title,
    p_body: body,
    p_pinned: formData.get("pinned") === "yes",
    // Unticked box means "don't buzz everyone" — a typo fix or a minor note.
    p_notify: formData.get("notify") === "yes",
    p_attachments: readAttachments(formData),
  });
  if (error) return { error: error.message };

  revalidatePath("/news");
  revalidatePath("/");
  redirect("/news");
}

export async function editNewsPost(
  _previous: NewsFormState,
  formData: FormData,
): Promise<NewsFormState> {
  await requireRole(...NEWS_AUTHOR_ROLES);

  const id = String(formData.get("post_id") ?? "");
  if (!isUuid(id)) return { error: "No announcement selected." };
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title) return { error: "Give the announcement a title." };
  if (!body) return { error: "Write something in the announcement." };

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_news_post", {
    p_id: id,
    p_title: title,
    p_body: body,
    p_pinned: formData.get("pinned") === "yes",
  });
  if (error) return { error: error.message };

  revalidatePath("/news");
  revalidatePath(`/news/${id}`);
  redirect(`/news/${id}`);
}

export async function deleteNewsPost(
  _previous: NewsFormState,
  formData: FormData,
): Promise<NewsFormState> {
  await requireRole(...NEWS_AUTHOR_ROLES);

  const id = String(formData.get("post_id") ?? "");
  if (!isUuid(id)) return { error: "No announcement selected." };

  const supabase = await createClient();

  // Collect the paths BEFORE the row goes: news_attachments cascades with the
  // post, and once it has we no longer know what to clean out of the bucket.
  const { data: attachments } = await supabase
    .from("news_attachments")
    .select("storage_path")
    .eq("post_id", id);

  const { error } = await supabase.rpc("delete_news_post", { p_id: id });
  if (error) return { error: error.message };

  const paths = ((attachments as { storage_path: string }[] | null) ?? []).map(
    (a) => a.storage_path,
  );
  if (paths.length > 0) {
    // Best effort. The announcement is already gone and nothing links to these
    // objects any more; a failure here leaves bytes behind, not a broken page.
    const { error: storageError } = await supabase.storage.from("news").remove(paths);
    if (storageError) {
      console.error(`[news] could not remove attachments for ${id}: ${storageError.message}`);
    }
  }

  revalidatePath("/news");
  revalidatePath("/");
  redirect("/news");
}

/** Called when a reader opens a post, to clear it from their unread count. */
export async function markNewsRead(postId: string): Promise<void> {
  if (!isUuid(postId)) return;
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_news_read", { p_id: postId });
  if (error) console.error(`[news] mark_news_read failed: ${error.message}`);
}
