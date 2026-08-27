/**
 * The storage key for an announcement's attachment.
 *
 * Supabase Storage refuses any object key outside its S3-safe set — every
 * accented letter, en dash and emoji included — with a bare
 * `Invalid key: news/…`, and it refuses it *before* RLS, so no policy change
 * makes it go away. A PNG called "Agosto – Región.png" simply could not be
 * attached; that is the bug this exists to close.
 *
 * `#` and `?` are worse than rejected: storage-js interpolates the raw path
 * into the request URL without encoding it, so everything after one becomes a
 * fragment or a query string. The bytes land under a truncated name while
 * news_attachments records the full one — an attachment that looks fine at
 * publish time and 404s forever after.
 *
 * Only the key is flattened. What a reader sees is news_attachments.file_name,
 * which keeps the original name exactly as the author had it.
 */
export function storageSafeName(name: string) {
  const flatten = (part: string) =>
    part
      // Región -> Region rather than Regi_n: an accent is a letter with a hat
      // on, and turning it into an underscore mangles a name for no reason.
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "");

  const dot = name.lastIndexOf(".");
  // A name with nothing ASCII in it at all ("写真.png") flattens to empty.
  const base = flatten(dot > 0 ? name.slice(0, dot) : name).slice(0, 80) || "attachment";
  const ext = dot > 0 ? flatten(name.slice(dot + 1)).slice(0, 12) : "";
  return ext ? `${base}.${ext}` : base;
}
