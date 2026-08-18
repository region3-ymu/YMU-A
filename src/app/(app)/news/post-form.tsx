"use client";

import { useActionState, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { editNewsPost, publishNewsPost, type NewsFormState } from "./actions";

type Uploaded = {
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
};

const ACCEPT = "application/pdf,image/*";
// Supabase's default object limit is generous, but a 40 MB PDF pushed to fifty
// teachers on mobile data is nobody's friend.
const MAX_BYTES = 15 * 1024 * 1024;

export default function NewsPostForm({
  userId,
  post,
  ownTeachersOption,
}: {
  userId: string;
  /** Present when editing. Attachments are add-at-publish only, so editing leaves them alone. */
  post?: { id: string; title: string; body: string; pinned: boolean };
  /**
   * The label for "my teachers", or null for a role whose own teachers are
   * everybody. Resolved on the server so this component never has to know what
   * region the author is in — see can_target_own_teachers() in 0071.
   */
  ownTeachersOption?: string | null;
}) {
  const editing = post != null;
  const [state, dispatch, pending] = useActionState<NewsFormState, FormData>(
    editing ? editNewsPost : publishNewsPost,
    undefined,
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded[]>([]);

  // Files go straight to the private bucket from here, before the action runs
  // — the same path the bug-report screenshot takes. The server action only
  // ever sees paths, so a multi-megabyte PDF never travels through it.
  async function handleFiles(files: FileList) {
    setUploadError(null);
    const supabase = createClient();
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_BYTES) {
          setUploadError(`${file.name} is over 15 MB — attach a link instead.`);
          continue;
        }
        const path = `${userId}/${Date.now()}-${file.name}`;
        const { error } = await supabase.storage.from("news").upload(path, file);
        if (error) {
          setUploadError(`Couldn't upload ${file.name}: ${error.message}`);
          continue;
        }
        setUploaded((prev) => [
          ...prev,
          {
            storage_path: path,
            file_name: file.name,
            mime_type: file.type || null,
            size_bytes: file.size,
          },
        ]);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeUploaded(path: string) {
    // Already in the bucket, so drop the bytes too rather than leaving an
    // orphan nothing will ever reference.
    const supabase = createClient();
    await supabase.storage.from("news").remove([path]);
    setUploaded((prev) => prev.filter((file) => file.storage_path !== path));
  }

  return (
    <form action={dispatch} className="grid gap-4">
      {editing && <input type="hidden" name="post_id" value={post.id} />}
      <input type="hidden" name="attachments" value={JSON.stringify(uploaded)} />

      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">Title</span>
        <input
          name="title"
          required
          maxLength={200}
          defaultValue={post?.title}
          placeholder="Cover needed at Coconut Palm, Thursday"
          className="rounded-lg bg-surface-container-low px-3 py-2 text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      <label className="grid gap-1 text-sm">
        <span className="font-medium text-on-surface-variant">Announcement</span>
        <textarea
          name="body"
          required
          rows={8}
          defaultValue={post?.body}
          placeholder="Write it as you would in the group chat. Line breaks are kept."
          className="rounded-lg bg-surface-container-low px-3 py-2 text-on-surface outline-none focus:ring-2 focus:ring-primary"
        />
      </label>

      {!editing && (
        <div className="grid gap-2">
          <span className="text-sm font-medium text-on-surface-variant">
            Attachments (PDF or image, optional)
          </span>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            disabled={uploading}
            onChange={(event) => event.target.files && handleFiles(event.target.files)}
            className="block w-full text-sm text-on-surface-variant"
          />
          {uploading && <p className="text-xs text-on-surface-variant">Uploading…</p>}
          {uploadError && (
            <p role="alert" className="text-xs text-error">
              {uploadError}
            </p>
          )}
          {uploaded.length > 0 && (
            <ul className="grid gap-1.5">
              {uploaded.map((file) => (
                <li
                  key={file.storage_path}
                  className="flex items-center gap-2 rounded-lg bg-surface-container-low px-3 py-2 text-sm"
                >
                  <span className="material-symbols-outlined text-base text-on-surface-variant" aria-hidden>
                    {file.mime_type?.startsWith("image/") ? "image" : "description"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-on-surface">{file.file_name}</span>
                  <button
                    type="button"
                    onClick={() => removeUploaded(file.storage_path)}
                    className="shrink-0 text-xs font-semibold text-error"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!editing && ownTeachersOption && (
        <fieldset className="rounded-lg bg-surface-container-low px-3 py-2 text-sm">
          <legend className="font-medium text-on-surface">Who is this for?</legend>
          <label className="mt-1 flex items-start gap-3">
            <input
              type="radio"
              name="audience"
              value="everyone"
              defaultChecked
              className="mt-0.5 size-4 accent-current"
            />
            <span>
              <span className="block text-on-surface">Everyone</span>
              <span className="block text-xs text-on-surface-variant">
                Every teacher in YMU.
              </span>
            </span>
          </label>
          <label className="mt-2 flex items-start gap-3">
            <input
              type="radio"
              name="audience"
              value="own_teachers"
              className="mt-0.5 size-4 accent-current"
            />
            <span>
              <span className="block text-on-surface">{ownTeachersOption}</span>
              <span className="block text-xs text-on-surface-variant">
                Only they get the push and see it on their board. Managers still
                see every announcement.
              </span>
            </span>
          </label>
        </fieldset>
      )}

      <label className="flex items-start gap-3 rounded-lg bg-surface-container-low px-3 py-2 text-sm">
        <input
          type="checkbox"
          name="pinned"
          value="yes"
          defaultChecked={post?.pinned}
          className="mt-0.5 size-4 accent-current"
        />
        <span>
          <span className="block font-medium text-on-surface">Pin to the top</span>
          <span className="block text-xs text-on-surface-variant">
            For cover requests and anything urgent.
          </span>
        </span>
      </label>

      {!editing && (
        <label className="flex items-start gap-3 rounded-lg bg-surface-container-low px-3 py-2 text-sm">
          <input
            type="checkbox"
            name="notify"
            value="yes"
            defaultChecked
            className="mt-0.5 size-4 accent-current"
          />
          <span>
            <span className="block font-medium text-on-surface">Notify teachers</span>
            <span className="block text-xs text-on-surface-variant">
              Sends a push to the teachers this is for. Untick for something minor.
            </span>
          </span>
        </label>
      )}

      {state?.error && (
        <p role="alert" className="rounded-lg bg-error-container p-3 text-sm text-on-error-container">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || uploading}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-3 font-semibold text-on-primary shadow-sm disabled:opacity-50"
      >
        <span className="material-symbols-outlined" aria-hidden>campaign</span>
        {pending ? "Saving…" : editing ? "Save changes" : "Publish"}
      </button>
    </form>
  );
}
