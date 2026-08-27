// A news attachment's bytes, on a URL that does not go stale.
//
// The post page used to embed the signed URL itself. That works until the
// service worker serves the page from its cache: the token lasts an hour and
// the page cache lasts up to a week (src/app/sw.ts), so a manager opening a
// five-day-old cached announcement on weak school signal got a 400 from
// storage — a broken image, with the page looking fine around it.
//
// This route is a stable id-based URL that survives caching, and the token is
// minted per request and never leaves the server, so a link copied out of the
// page is worthless without a session.
//
// Authorisation is RLS, not code: news_attachments_select only returns rows
// whose post is visible to this reader (migration 0071), so guessing an id
// gets you a 404 rather than a targeted announcement's file.

import { createClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return new Response("Not found.", { status: 404 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const { data } = await supabase
    .from("news_attachments")
    .select("storage_path, file_name, mime_type")
    .eq("id", id)
    .maybeSingle();
  const attachment = data as {
    storage_path: string;
    file_name: string;
    mime_type: string | null;
  } | null;
  if (!attachment) return new Response("Not found.", { status: 404 });

  // Short, because nothing outside this request ever sees it.
  const { data: signed } = await supabase.storage
    .from("news")
    .createSignedUrl(attachment.storage_path, 60);
  if (!signed?.signedUrl) return new Response("That file could not be opened.", { status: 502 });

  // Streamed rather than buffered: a 15 MB PDF should not have to sit in this
  // function's memory on its way through.
  const upstream = await fetch(signed.signedUrl);
  if (!upstream.ok || !upstream.body) {
    console.error(`[news] attachment ${id} fetch failed: ${upstream.status}`);
    return new Response("That file could not be opened.", { status: 502 });
  }

  const length = upstream.headers.get("content-length");
  return new Response(upstream.body, {
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? attachment.mime_type ?? "application/octet-stream",
      ...(length ? { "Content-Length": length } : {}),
      // filename* so an accented name survives the trip — the whole reason the
      // key in the bucket is flattened and this one is not.
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
      // Private, and short: the row it came from is RLS-scoped per reader.
      "Cache-Control": "private, max-age=300",
    },
  });
}
