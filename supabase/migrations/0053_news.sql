-- News: an announcements board managers post to and teachers read.
--
-- YMU asked for "like a WhatsApp group where only admins can talk" — notices,
-- PDFs, tips, cover requests. Today those go out over WhatsApp and email,
-- where they are unsearchable, invisible to anyone who joined later, and
-- impossible to tell apart from chatter.
--
-- Shaped like app_feedback (0024) with the permissions inverted: there
-- everybody writes and a couple of admins read; here a couple of managers
-- write and everybody reads.
--
-- Writes go through SECURITY DEFINER functions rather than table grants, the
-- same as tickets (0030): authorship, the notification fan-out and the
-- attachment rows have to move together, and a policy cannot express that.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.news_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  -- Denormalised at publish time, like app_feedback.submitted_by_role: if the
  -- author is promoted next term, an old announcement should still say who
  -- they were when they wrote it.
  author_role public.app_role not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(btrim(body)) >= 1),
  -- Cover requests and anything urgent sit above the chronological feed.
  pinned boolean not null default false,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.news_posts is
  'Announcements from managers to the whole organisation. Everyone signed in can read; only the four manager roles can write, via create_news_post()/update_news_post().';

create index if not exists news_posts_feed_idx
  on public.news_posts (pinned desc, published_at desc);

create table if not exists public.news_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.news_posts(id) on delete cascade,
  -- Path inside the private 'news' storage bucket, always '<uploader uid>/…'.
  storage_path text not null,
  file_name text not null,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz not null default now()
);

create index if not exists news_attachments_post_idx on public.news_attachments (post_id);

comment on table public.news_attachments is
  'Files hanging off an announcement. The row is the record; the bytes live in the private news bucket and are served as short-lived signed URLs.';

create table if not exists public.news_reads (
  post_id uuid not null references public.news_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

comment on table public.news_reads is
  'Who has opened which announcement. Drives the unread count on the News menu item — deliberately per-reader and not visible to anyone else.';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.news_posts enable row level security;
alter table public.news_attachments enable row level security;
alter table public.news_reads enable row level security;

-- Everyone signed in reads everything. There is no per-region audience:
-- announcements are organisation-wide by decision (YMU 2026-08-14), and a
-- board people cannot fully see is a board they stop trusting.
create policy news_posts_select on public.news_posts
  for select to authenticated using (true);

create policy news_attachments_select on public.news_attachments
  for select to authenticated using (true);

-- Own read marks only. Not because they are secret, but because "who has read
-- my announcement" is a surveillance feature nobody asked for.
create policy news_reads_own on public.news_reads
  for select to authenticated using (user_id = auth.uid());

create policy news_reads_insert_own on public.news_reads
  for insert to authenticated with check (user_id = auth.uid());

-- No insert/update/delete grants on posts or attachments: those go through the
-- functions below.
grant select on public.news_posts to authenticated;
grant select on public.news_attachments to authenticated;
grant select, insert on public.news_reads to authenticated;

-- ---------------------------------------------------------------------------
-- Who may publish
-- ---------------------------------------------------------------------------

create or replace function public.can_publish_news()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() in
      ('regional_manager', 'academic_manager', 'operations_manager', 'cpo'),
    false
  );
$$;

comment on function public.can_publish_news() is
  'The four manager roles. Mirrored in TypeScript as NEWS_AUTHOR_ROLES in src/lib/auth/roles.ts — SQL is authoritative.';

grant execute on function public.can_publish_news() to authenticated;

-- ---------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------

create or replace function public.create_news_post(
  p_title text,
  p_body text,
  p_pinned boolean default false,
  p_notify boolean default true,
  -- [{ storage_path, file_name, mime_type, size_bytes }]
  p_attachments jsonb default '[]'::jsonb
)
returns public.news_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_post public.news_posts;
begin
  if v_uid is null or not public.can_publish_news() then
    raise exception 'Only a manager can post an announcement.';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'Give the announcement a title.';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Write something in the announcement.';
  end if;

  insert into public.news_posts (author_id, author_role, title, body, pinned)
  values (v_uid, public.current_app_role(), btrim(p_title), btrim(p_body), coalesce(p_pinned, false))
  returning * into v_post;

  insert into public.news_attachments (post_id, storage_path, file_name, mime_type, size_bytes)
  select
    v_post.id,
    a->>'storage_path',
    coalesce(nullif(btrim(a->>'file_name'), ''), 'attachment'),
    nullif(a->>'mime_type', ''),
    nullif(a->>'size_bytes', '')::bigint
  from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) as a
  where nullif(btrim(a->>'storage_path'), '') is not null
    -- The storage policy already enforces this, but a path outside the
    -- author's own folder must not even be recorded.
    and split_part(a->>'storage_path', '/', 1) = v_uid::text;

  if coalesce(p_notify, true) then
    -- Teachers only. A manager who wants to see it opens the board; pushing
    -- every announcement to its own author is just noise.
    --
    -- `summary` carries the title so the push still reads sensibly on a
    -- notify-dispatch build that predates the news_published case and falls
    -- through to its default.
    insert into public.notification_queue (recipient_id, type, payload)
    select p.id, 'news_published',
      jsonb_build_object('post_id', v_post.id, 'title', v_post.title, 'summary', v_post.title)
    from public.profiles p
    where p.role = 'teacher' and p.archived_at is null;
  end if;

  return v_post;
end;
$$;

comment on function public.create_news_post(text, text, boolean, boolean, jsonb) is
  'Publishes an announcement, records its attachments and (unless p_notify is false) queues a push to every active teacher — one transaction, so a post can never exist without its files or its notifications.';

revoke execute on function public.create_news_post(text, text, boolean, boolean, jsonb) from public, anon;
grant execute on function public.create_news_post(text, text, boolean, boolean, jsonb) to authenticated;

create or replace function public.update_news_post(
  p_id uuid,
  p_title text,
  p_body text,
  p_pinned boolean default false
)
returns public.news_posts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_post public.news_posts;
begin
  select * into v_post from public.news_posts where id = p_id;
  if not found then
    raise exception 'That announcement could not be found.';
  end if;
  -- Your own, or anyone's if you run the place.
  if not (
    (v_post.author_id = v_uid and public.can_publish_news())
    or v_role in ('operations_manager', 'cpo')
  ) then
    raise exception 'You can only edit your own announcements.';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'Give the announcement a title.';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Write something in the announcement.';
  end if;

  update public.news_posts
     set title = btrim(p_title),
         body = btrim(p_body),
         pinned = coalesce(p_pinned, false),
         updated_at = now()
   where id = p_id
   returning * into v_post;

  -- No re-notification on edit, on purpose: fixing a typo should not buzz
  -- fifty phones.
  return v_post;
end;
$$;

revoke execute on function public.update_news_post(uuid, text, text, boolean) from public, anon;
grant execute on function public.update_news_post(uuid, text, text, boolean) to authenticated;

create or replace function public.delete_news_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role public.app_role := public.current_app_role();
  v_author uuid;
begin
  select author_id into v_author from public.news_posts where id = p_id;
  if v_author is null then
    raise exception 'That announcement could not be found.';
  end if;
  if not (
    (v_author = v_uid and public.can_publish_news())
    or v_role in ('operations_manager', 'cpo')
  ) then
    raise exception 'You can only delete your own announcements.';
  end if;

  -- Attachments and read marks cascade. The bytes in storage are removed by
  -- the caller, which is the only side that can talk to the storage API.
  delete from public.news_posts where id = p_id;
end;
$$;

revoke execute on function public.delete_news_post(uuid) from public, anon;
grant execute on function public.delete_news_post(uuid) to authenticated;

create or replace function public.mark_news_read(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.news_reads (post_id, user_id)
  values (p_id, auth.uid())
  on conflict (post_id, user_id) do nothing;
$$;

revoke execute on function public.mark_news_read(uuid) from public, anon;
grant execute on function public.mark_news_read(uuid) to authenticated;

create or replace function public.unread_news_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.news_posts n
   where auth.uid() is not null
     and not exists (
       select 1 from public.news_reads r
        where r.post_id = n.id and r.user_id = auth.uid()
     );
$$;

comment on function public.unread_news_count() is
  'Announcements the caller has not opened. Feeds the badge on the News menu item.';

revoke execute on function public.unread_news_count() from public, anon;
grant execute on function public.unread_news_count() to authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
-- Private bucket, folder-per-uploader, same shape as app-feedback (0024). The
-- difference is on read: an app-feedback screenshot is visible only to admins,
-- whereas an announcement's PDF is the point of the announcement, so any
-- signed-in reader can fetch it (through a short-lived signed URL, never a
-- public object).

insert into storage.buckets (id, name, public)
values ('news', 'news', false)
on conflict (id) do nothing;

drop policy if exists news_attachment_insert on storage.objects;
create policy news_attachment_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'news'
    and public.can_publish_news()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists news_attachment_select on storage.objects;
create policy news_attachment_select on storage.objects
  for select to authenticated
  using (bucket_id = 'news');

-- Deleting the bytes when an announcement goes, or when an upload is
-- abandoned before publishing. Own folder only.
drop policy if exists news_attachment_delete on storage.objects;
create policy news_attachment_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'news'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.current_app_role() in ('operations_manager', 'cpo')
    )
  );
