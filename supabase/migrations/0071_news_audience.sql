-- ===========================================================================
-- 0071 — News: who may post, and who a post is for
-- ===========================================================================
--
-- 0053 said it plainly: "There is no per-region audience: announcements are
-- organisation-wide by decision (YMU 2026-08-14), and a board people cannot
-- fully see is a board they stop trusting." That decision changed
-- (2026-08-18). A Regional Manager announcing a cover request at one school
-- was pushing a notification to every teacher in Miami-Dade.
--
-- The trust problem is real though, and the answer is the asymmetry YMU asked
-- for: targeting narrows who gets NOTIFIED and whose feed it appears in, but
-- every manager still sees the whole board. Nothing on News is confidential —
-- the point is not spamming four regions about one school.
--
-- Audience is frozen at publish time, not derived on read. If an RM moves
-- region next term, last term's post was still aimed at the teachers it was
-- aimed at, and a post that silently changes audience is worse than one that
-- cannot be retargeted at all.
-- ===========================================================================

alter table public.news_posts
  add column if not exists audience text not null default 'everyone',
  add column if not exists audience_region public.region,
  add column if not exists audience_afterschool boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'news_posts_audience_shape'
  ) then
    alter table public.news_posts add constraint news_posts_audience_shape check (
      (audience = 'everyone'
        and audience_region is null
        and audience_afterschool is false)
      or (audience = 'own_teachers'
        -- Exactly one of the two, never both and never neither: "my teachers"
        -- means one thing to a Regional Manager and a different thing to the
        -- afterschool manager, and a row carrying both would have no answer.
        and (audience_region is not null) <> audience_afterschool)
    );
  end if;
end
$$;

comment on column public.news_posts.audience is
  'everyone, or own_teachers — narrows the push and the teachers'' feed. Managers see every post regardless; see news_post_visible().';
comment on column public.news_posts.audience_region is
  'The Regional Manager''s region as it was at publish time. Frozen, so the audience cannot drift if the author is moved.';
comment on column public.news_posts.audience_afterschool is
  'True when the afterschool manager aimed a post at her own teachers, whatever region they are in.';

create index if not exists news_posts_audience_idx
  on public.news_posts (audience)
  where audience <> 'everyone';

-- ---------------------------------------------------------------------------
-- Audience membership — one definition, three callers
-- ---------------------------------------------------------------------------
-- Used by the read policy, by the attachment policy and by create_news_post()'s
-- notification fan-out. Three copies of "is this teacher in the audience" would
-- be three chances for the feed and the push to disagree about who was told.
--
-- SECURITY DEFINER because it reads calendar_events, and a policy that reads
-- another table through RLS is how 0064 earned its 42P17.

create or replace function public.teacher_in_news_audience(
  p_teacher_id uuid,
  p_audience text,
  p_audience_region public.region,
  p_audience_afterschool boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(p_audience, 'everyone') = 'everyone'
    or (
      p_audience_region is not null
      and exists (
        select 1
        from public.calendar_events ce
        join public.schools s on s.id = ce.school_id
        where p_teacher_id = any (ce.teacher_ids)
          and s.region = p_audience_region
          and ce.status <> 'cancelled'
          -- Current year only. A teacher who left the region in June should
          -- not still be getting its announcements in September.
          and ce.start_at >= public.current_school_year_start()
      )
    )
    or (
      coalesce(p_audience_afterschool, false)
      and exists (
        select 1 from public.calendar_events ce
        where p_teacher_id = any (ce.teacher_ids)
          and ce.status <> 'cancelled'
          and public.afterschool_owned(ce.is_afterschool, ce.start_at)
      )
    );
$$;

create or replace function public.news_post_visible(
  p_audience text,
  p_audience_region public.region,
  p_audience_afterschool boolean,
  p_author_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(p_audience, 'everyone') = 'everyone'
    or p_author_id = auth.uid()
    -- Every manager reads the whole board whatever a post was aimed at (YMU
    -- 2026-08-18). administrator is in here although YMU's list did not name
    -- it: it can publish, and an author who cannot see the board they post to
    -- is not a usable account.
    or public.current_app_role() in (
      'regional_manager', 'afterschool_manager', 'academic_manager',
      'operations_manager', 'cpo', 'administrator'
    )
    or public.teacher_in_news_audience(
      auth.uid(), p_audience, p_audience_region, p_audience_afterschool
    );
$$;

create or replace function public.news_post_visible_by_id(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.news_posts p
     where p.id = p_post_id
       and public.news_post_visible(
             p.audience, p.audience_region, p.audience_afterschool, p.author_id
           )
  );
$$;

revoke execute on function public.teacher_in_news_audience(uuid, text, public.region, boolean) from public, anon;
revoke execute on function public.news_post_visible(text, public.region, boolean, uuid) from public, anon;
revoke execute on function public.news_post_visible_by_id(uuid) from public, anon;
grant execute on function public.teacher_in_news_audience(uuid, text, public.region, boolean) to authenticated;
grant execute on function public.news_post_visible(text, public.region, boolean, uuid) to authenticated;
grant execute on function public.news_post_visible_by_id(uuid) to authenticated;

drop policy if exists news_posts_select on public.news_posts;
create policy news_posts_select on public.news_posts
  for select to authenticated
  using (
    public.news_post_visible(audience, audience_region, audience_afterschool, author_id)
  );

-- The attachments have to follow the post, or a targeted announcement's files
-- stay listable by everyone and the narrowing is decorative.
drop policy if exists news_attachments_select on public.news_attachments;
create policy news_attachments_select on public.news_attachments
  for select to authenticated
  using (public.news_post_visible_by_id(post_id));

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
    public.current_app_role() in (
      'regional_manager', 'afterschool_manager', 'academic_manager',
      'operations_manager', 'cpo', 'administrator'
    ),
    false
  );
$$;

comment on function public.can_publish_news() is
  'The six manager roles. Mirrored in TypeScript as NEWS_AUTHOR_ROLES in src/lib/auth/roles.ts — SQL is authoritative.';

/** Roles with an "own teachers" to aim at. A CPO's own teachers are everyone. */
create or replace function public.can_target_own_teachers()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    public.current_app_role() in ('regional_manager', 'afterschool_manager'),
    false
  );
$$;

revoke execute on function public.can_target_own_teachers() from public, anon;
grant execute on function public.can_target_own_teachers() to authenticated;

-- ---------------------------------------------------------------------------
-- create_news_post — the audience is resolved here, once
-- ---------------------------------------------------------------------------

create or replace function public.create_news_post(
  p_title text,
  p_body text,
  p_pinned boolean default false,
  p_notify boolean default true,
  p_attachments jsonb default '[]'::jsonb,
  p_audience text default 'everyone'
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
  v_audience text := coalesce(nullif(btrim(coalesce(p_audience, '')), ''), 'everyone');
  v_region public.region;
  v_afterschool boolean := false;
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
  if v_audience not in ('everyone', 'own_teachers') then
    raise exception 'Unknown audience.';
  end if;

  if v_audience = 'own_teachers' then
    -- Raise rather than quietly widening to everyone. An author who believes
    -- they narrowed a post and did not is the one outcome worth an error.
    if not public.can_target_own_teachers() then
      raise exception 'Your role has no "own teachers" — post this to everyone.';
    end if;
    if v_role = 'regional_manager' then
      v_region := public.current_app_region();
      if v_region is null then
        raise exception 'You have no region assigned, so "my teachers" has no meaning.';
      end if;
    else
      v_afterschool := true;
    end if;
  end if;

  insert into public.news_posts (
    author_id, author_role, title, body, pinned,
    audience, audience_region, audience_afterschool
  )
  values (
    v_uid, v_role, btrim(p_title), btrim(p_body), coalesce(p_pinned, false),
    v_audience, v_region, v_afterschool
  )
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
    and split_part(a->>'storage_path', '/', 1) = v_uid::text;

  if coalesce(p_notify, true) then
    -- The same audience test the feed uses, so nobody is pushed an
    -- announcement they cannot then find on the board.
    insert into public.notification_queue (recipient_id, type, payload)
    select p.id, 'news_published',
      jsonb_build_object('post_id', v_post.id, 'title', v_post.title, 'summary', v_post.title)
    from public.profiles p
    where p.role = 'teacher'
      and p.archived_at is null
      and public.teacher_in_news_audience(
            p.id, v_post.audience, v_post.audience_region, v_post.audience_afterschool
          );
  end if;

  return v_post;
end;
$$;

comment on function public.create_news_post(text, text, boolean, boolean, jsonb, text) is
  'Publishes an announcement, records its attachments and (unless p_notify is false) queues a push to the teachers in its audience — one transaction, so a post can never exist without its files or its notifications.';

revoke execute on function public.create_news_post(text, text, boolean, boolean, jsonb, text) from public, anon;
grant execute on function public.create_news_post(text, text, boolean, boolean, jsonb, text) to authenticated;

-- The 5-argument signature 0053 created still exists and would silently keep
-- posting to everyone. Dropped so there is one way in.
drop function if exists public.create_news_post(text, text, boolean, boolean, jsonb);
