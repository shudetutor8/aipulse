-- =============================================================================
-- AI Pulse database (GitHub Pages version)
-- Run this whole file once in Supabase: SQL Editor → New query → paste → Run.
--
-- The website talks to this database directly from the browser, so every rule
-- lives here: who can read and write what, rate limits, and the spam check.
-- The automatic jobs (GitHub Actions) use the secret key and skip these limits.
-- =============================================================================

create domain public.topic as text
  check (value in ('models','agents','chips','policy','funding','research','jobs','stocks','building','general'));

-------------------------------------------------------------------------------
-- Members
-------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text check (char_length(display_name) <= 50),
  bio text check (char_length(bio) <= 300),
  avatar_url text,
  is_admin boolean not null default false,
  is_banned boolean not null default false,
  reputation integer not null default 0,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  base text;
  candidate text;
  tries int := 0;
begin
  base := lower(regexp_replace(coalesce(split_part(new.email, '@', 1), ''), '[^a-zA-Z0-9_]', '', 'g'));
  base := left(base, 16);
  if char_length(base) < 3 then base := 'member'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where username = candidate) and tries < 50 loop
    tries := tries + 1;
    candidate := base || floor(random() * 90000 + 10000)::int::text;
  end loop;
  insert into public.profiles (id, username, display_name, avatar_url)
  values (new.id, candidate,
          left(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), 50),
          new.raw_user_meta_data->>'avatar_url');
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select not is_banned from public.profiles where id = auth.uid()), false);
$$;

-------------------------------------------------------------------------------
-- News
-------------------------------------------------------------------------------
create table public.news_sources (
  id bigint generated always as identity primary key,
  name text not null,
  feed_url text not null unique,
  active boolean not null default true,
  last_fetched_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.news_stories (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  topic public.topic not null default 'general',
  image_url text,
  published_at timestamptz,
  source_count integer not null default 1,
  comment_count integer not null default 0,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index news_stories_published_idx on public.news_stories (published_at desc);

create table public.news_links (
  id bigint generated always as identity primary key,
  story_id uuid not null references public.news_stories(id) on delete cascade,
  source_name text not null,
  url text not null unique,
  title text not null,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index news_links_story_idx on public.news_links (story_id);

-- Articles judged not to be about AI, so they aren't checked again.
create table public.news_skipped (
  url text primary key,
  created_at timestamptz not null default now()
);

-------------------------------------------------------------------------------
-- Stocks (discussion pages; prices are links to free quote sites)
-------------------------------------------------------------------------------
create table public.tickers (
  symbol text primary key check (symbol ~ '^[A-Z.]{1,10}$'),
  name text not null,
  comment_count integer not null default 0,
  active boolean not null default true
);

-------------------------------------------------------------------------------
-- Polls
-------------------------------------------------------------------------------
create table public.polls (
  id uuid primary key default gen_random_uuid(),
  question text not null check (char_length(question) between 10 and 200),
  description text check (char_length(description) <= 600),
  topic public.topic not null default 'general',
  origin text not null check (origin in ('auto','user')),
  status text not null default 'pending' check (status in ('pending','live','closed','rejected')),
  author_id uuid references public.profiles(id) on delete set null,
  story_ids uuid[] not null default '{}',
  total_votes integer not null default 0,
  comment_count integer not null default 0,
  closes_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index polls_status_idx on public.polls (status, published_at desc);

create table public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  label text not null check (char_length(label) between 1 and 80),
  position smallint not null default 0,
  vote_count integer not null default 0
);
create index poll_options_poll_idx on public.poll_options (poll_id, position);

create table public.poll_votes (
  poll_id uuid not null references public.polls(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  option_id uuid not null references public.poll_options(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);

-------------------------------------------------------------------------------
-- Posts (questions and discussions) and comments
-- author_id is empty for posts written by the site's AI editor.
-------------------------------------------------------------------------------
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles(id) on delete cascade,
  is_editorial boolean not null default false,
  story_id uuid references public.news_stories(id) on delete set null,
  kind text not null check (kind in ('question','discussion')),
  title text not null check (char_length(title) between 8 and 200),
  body text not null default '' check (char_length(body) <= 20000),
  topic public.topic not null default 'general',
  score integer not null default 0,
  comment_count integer not null default 0,
  status text not null default 'visible' check (status in ('visible','flagged','hidden')),
  ai_checked boolean not null default false,
  best_comment_id uuid,
  created_at timestamptz not null default now(),
  check (author_id is not null or is_editorial)
);
create index posts_created_idx on public.posts (created_at desc);
create index posts_author_idx on public.posts (author_id);
create index posts_unchecked_idx on public.posts (ai_checked) where not ai_checked;

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('post','story','poll','ticker')),
  target_id text not null,
  parent_id uuid references public.comments(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 10000),
  score integer not null default 0,
  status text not null default 'visible' check (status in ('visible','flagged','hidden')),
  ai_checked boolean not null default false,
  created_at timestamptz not null default now()
);
create index comments_target_idx on public.comments (target_type, target_id, created_at);
create index comments_author_idx on public.comments (author_id, created_at desc);
create index comments_unchecked_idx on public.comments (ai_checked) where not ai_checked;

alter table public.posts add constraint posts_best_comment_fk
  foreign key (best_comment_id) references public.comments(id) on delete set null;

create table public.post_votes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  primary key (post_id, user_id)
);

create table public.comment_votes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  primary key (comment_id, user_id)
);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_type text not null check (target_type in ('post','comment')),
  target_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(),
  unique (reporter_id, target_type, target_id)
);

-------------------------------------------------------------------------------
-- Spam check and rate limits for anything members write
-------------------------------------------------------------------------------
create or replace function public.looks_like_spam(t text)
returns boolean language sql immutable as $$
  select (select count(*) from regexp_matches(coalesce(t, ''), 'https?://', 'g')) > 5
      or lower(coalesce(t, '')) ~ '(buy now|free money|guaranteed profit|click my link|dm me for|work from home and earn|crypto giveaway)';
$$;

create or replace function public.before_member_post()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;  -- written by the automatic jobs
  new.author_id := auth.uid();
  new.is_editorial := false;
  new.story_id := null;
  new.score := 0;
  new.comment_count := 0;
  new.best_comment_id := null;
  new.ai_checked := false;
  new.created_at := now();
  new.title := btrim(new.title);
  new.body := btrim(coalesce(new.body, ''));
  if new.kind = 'discussion' and char_length(new.body) < 20 then
    raise exception 'Add a few sentences to start the discussion.' using errcode = 'P0001';
  end if;
  if (select count(*) from posts where author_id = auth.uid() and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'You''ve posted a lot in the last hour. Please try again later.' using errcode = 'P0001';
  end if;
  new.status := case when looks_like_spam(new.title || ' ' || new.body) then 'flagged' else 'visible' end;
  return new;
end $$;

create trigger posts_before_insert before insert on public.posts
  for each row execute function public.before_member_post();

create or replace function public.before_member_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ok boolean;
begin
  if auth.uid() is null then return new; end if;
  new.author_id := auth.uid();
  new.score := 0;
  new.ai_checked := false;
  new.created_at := now();
  new.body := btrim(new.body);
  ok := case new.target_type
    when 'post'   then exists (select 1 from posts where id::text = new.target_id and status = 'visible')
    when 'story'  then exists (select 1 from news_stories where id::text = new.target_id and not is_hidden)
    when 'poll'   then exists (select 1 from polls where id::text = new.target_id and status in ('live','closed'))
    when 'ticker' then exists (select 1 from tickers where symbol = new.target_id and active)
    else false end;
  if not ok then
    raise exception 'This conversation is no longer available.' using errcode = 'P0001';
  end if;
  if new.parent_id is not null and not exists (
    select 1 from comments where id = new.parent_id and target_type = new.target_type and target_id = new.target_id
  ) then
    raise exception 'The reply you are answering was removed.' using errcode = 'P0001';
  end if;
  if (select count(*) from comments where author_id = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'You''re replying very fast. Please wait a bit.' using errcode = 'P0001';
  end if;
  new.status := case when looks_like_spam(new.body) then 'flagged' else 'visible' end;
  return new;
end $$;

create trigger comments_before_insert before insert on public.comments
  for each row execute function public.before_member_comment();

create or replace function public.before_member_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  new.reporter_id := auth.uid();
  new.status := 'open';
  new.created_at := now();
  new.reason := coalesce(nullif(btrim(left(new.reason, 500)), ''), 'No reason given');
  if (select count(*) from reports where reporter_id = auth.uid() and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many reports. Please try later.' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger reports_before_insert before insert on public.reports
  for each row execute function public.before_member_report();

-------------------------------------------------------------------------------
-- Counters kept up to date automatically
-------------------------------------------------------------------------------
create or replace function public.bump_comment_count()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r record;
  delta int;
begin
  if tg_op = 'INSERT' then r := new; delta := 1; else r := old; delta := -1; end if;
  if r.target_type = 'post' then
    update posts set comment_count = greatest(comment_count + delta, 0) where id::text = r.target_id;
  elsif r.target_type = 'story' then
    update news_stories set comment_count = greatest(comment_count + delta, 0) where id::text = r.target_id;
  elsif r.target_type = 'poll' then
    update polls set comment_count = greatest(comment_count + delta, 0) where id::text = r.target_id;
  elsif r.target_type = 'ticker' then
    update tickers set comment_count = greatest(comment_count + delta, 0) where symbol = r.target_id;
  end if;
  return null;
end $$;

create trigger comments_count after insert or delete on public.comments
  for each row execute function public.bump_comment_count();

create or replace function public.apply_post_vote()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  delta int := coalesce(case when tg_op <> 'DELETE' then new.value end, 0)
             - coalesce(case when tg_op <> 'INSERT' then old.value end, 0);
  pid uuid := coalesce(case when tg_op <> 'DELETE' then new.post_id end, old.post_id);
begin
  update posts set score = score + delta where id = pid;
  update profiles set reputation = reputation + delta where id = (select author_id from posts where id = pid);
  return null;
end $$;

create trigger post_votes_apply after insert or update or delete on public.post_votes
  for each row execute function public.apply_post_vote();

create or replace function public.apply_comment_vote()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  delta int := coalesce(case when tg_op <> 'DELETE' then new.value end, 0)
             - coalesce(case when tg_op <> 'INSERT' then old.value end, 0);
  cid uuid := coalesce(case when tg_op <> 'DELETE' then new.comment_id end, old.comment_id);
begin
  update comments set score = score + delta where id = cid;
  update profiles set reputation = reputation + delta where id = (select author_id from comments where id = cid);
  return null;
end $$;

create trigger comment_votes_apply after insert or update or delete on public.comment_votes
  for each row execute function public.apply_comment_vote();

create or replace function public.apply_poll_vote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update poll_options set vote_count = vote_count + 1 where id = new.option_id;
    update polls set total_votes = total_votes + 1 where id = new.poll_id;
  else
    update poll_options set vote_count = greatest(vote_count - 1, 0) where id = old.option_id;
    update polls set total_votes = greatest(total_votes - 1, 0) where id = old.poll_id;
  end if;
  return null;
end $$;

create trigger poll_votes_apply after insert or delete on public.poll_votes
  for each row execute function public.apply_poll_vote();

-------------------------------------------------------------------------------
-- Actions the website calls
-------------------------------------------------------------------------------

-- A member creates a poll (max 3 a day).
create or replace function public.create_user_poll(
  p_question text, p_description text, p_topic text, p_days int, p_options text[]
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  opts text[];
  new_id uuid;
  i int;
begin
  if auth.uid() is null or not is_active_user() then
    raise exception 'Please log in first.' using errcode = 'P0001';
  end if;
  select coalesce(array_agg(btrim(o)), '{}') into opts
    from unnest(p_options) o where btrim(o) <> '';
  if char_length(btrim(p_question)) < 10 then raise exception 'The question needs at least 10 characters.' using errcode = 'P0001'; end if;
  if array_length(opts, 1) is null or array_length(opts, 1) < 2 then raise exception 'Add at least two options.' using errcode = 'P0001'; end if;
  if array_length(opts, 1) > 4 then raise exception 'Use at most four options.' using errcode = 'P0001'; end if;
  if (select count(*) from polls where author_id = auth.uid() and created_at > now() - interval '1 day') >= 3 then
    raise exception 'You can create 3 polls a day.' using errcode = 'P0001';
  end if;
  if looks_like_spam(p_question || ' ' || coalesce(p_description, '') || ' ' || array_to_string(opts, ' ')) then
    raise exception 'This poll doesn''t meet the community guidelines.' using errcode = 'P0001';
  end if;
  insert into polls (question, description, topic, origin, status, author_id, published_at, closes_at)
  values (btrim(p_question), nullif(btrim(coalesce(p_description, '')), ''), p_topic::public.topic, 'user', 'live', auth.uid(),
          now(), now() + make_interval(days => least(greatest(coalesce(p_days, 3), 1), 7)))
  returning id into new_id;
  for i in 1 .. array_length(opts, 1) loop
    insert into poll_options (poll_id, label, position) values (new_id, left(opts[i], 80), i - 1);
  end loop;
  return new_id;
end $$;

-- The person who asked a question picks (or clears) the best answer.
create or replace function public.set_best_answer(p_post uuid, p_comment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from posts where id = p_post and author_id = auth.uid() and kind = 'question') then
    raise exception 'Only the person who asked can pick the best answer.' using errcode = 'P0001';
  end if;
  if p_comment is not null and not exists (
    select 1 from comments where id = p_comment and target_type = 'post' and target_id = p_post::text and parent_id is null
  ) then
    raise exception 'That answer is not on this question.' using errcode = 'P0001';
  end if;
  update posts set best_comment_id = p_comment where id = p_post;
end $$;

-- Admin: publish a poll from the review queue for 48 hours.
create or replace function public.approve_poll(p_poll uuid, p_question text, p_description text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.' using errcode = 'P0001'; end if;
  update polls set
    question = case when char_length(btrim(coalesce(p_question, ''))) >= 10 then btrim(p_question) else question end,
    description = nullif(btrim(coalesce(p_description, '')), ''),
    status = 'live', published_at = now(), closes_at = now() + interval '48 hours'
  where id = p_poll;
end $$;

-- Admin: suspend or restore a member.
create or replace function public.set_banned(p_user uuid, p_banned boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only.' using errcode = 'P0001'; end if;
  if p_user = auth.uid() then raise exception 'You can''t suspend yourself.' using errcode = 'P0001'; end if;
  update profiles set is_banned = p_banned where id = p_user;
end $$;

-------------------------------------------------------------------------------
-- The home feed: posts, polls and news in one list with a "hot" score
-------------------------------------------------------------------------------
create view public.feed with (security_invoker = true) as
select f.*,
  (greatest(f.points, 0) + f.comment_count * 2 + 1)
    / power(extract(epoch from (now() - f.created_at)) / 3600.0 + 2, 1.5) as hot
from (
  select 'post'::text as kind, p.id::text as id, p.kind as subtype, p.title,
         left(p.body, 400) as excerpt, p.topic::text as topic, p.author_id,
         p.score as points, p.comment_count, p.created_at
  from public.posts p where p.status = 'visible'
  union all
  select 'poll', pl.id::text, pl.origin, pl.question, pl.description, pl.topic::text,
         pl.author_id, pl.total_votes / 5, pl.comment_count, coalesce(pl.published_at, pl.created_at)
  from public.polls pl where pl.status in ('live','closed')
  union all
  select 'story', s.id::text, s.source_count::text, s.title, s.summary, s.topic::text, null,
         s.source_count * 3, s.comment_count, coalesce(s.published_at, s.created_at)
  from public.news_stories s where not s.is_hidden
) f;

-------------------------------------------------------------------------------
-- Row level security: who can read and change what
-------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.news_sources enable row level security;
alter table public.news_stories enable row level security;
alter table public.news_links enable row level security;
alter table public.news_skipped enable row level security;
alter table public.tickers enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.posts enable row level security;
alter table public.comments enable row level security;
alter table public.post_votes enable row level security;
alter table public.comment_votes enable row level security;
alter table public.reports enable row level security;

-- Profiles: public; members edit only their own name, username, bio and picture.
create policy "profiles are public" on public.profiles for select using (true);
create policy "edit own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (username, display_name, bio, avatar_url) on public.profiles to authenticated;

-- News and tickers: public to read; admins can hide stories and manage sources and tickers.
create policy "stories are public" on public.news_stories for select using (not is_hidden or public.is_admin());
create policy "admins hide stories" on public.news_stories for update using (public.is_admin()) with check (public.is_admin());
create policy "links are public" on public.news_links for select using (true);
create policy "admins manage sources" on public.news_sources for all using (public.is_admin()) with check (public.is_admin());
create policy "tickers are public" on public.tickers for select using (true);
create policy "admins add tickers" on public.tickers for insert with check (public.is_admin());
create policy "admins edit tickers" on public.tickers for update using (public.is_admin()) with check (public.is_admin());

-- Polls
create policy "published polls are public" on public.polls for select
  using (status in ('live','closed') or author_id = auth.uid() or public.is_admin());
create policy "admins change polls" on public.polls for update using (public.is_admin()) with check (public.is_admin());
create policy "options of visible polls" on public.poll_options for select
  using (exists (select 1 from public.polls p where p.id = poll_id));
create policy "see own poll votes" on public.poll_votes for select using (user_id = auth.uid());
create policy "vote once on open polls" on public.poll_votes for insert with check (
  user_id = auth.uid() and public.is_active_user()
  and exists (select 1 from public.polls p where p.id = poll_id and p.status = 'live' and (p.closes_at is null or p.closes_at > now()))
  and exists (select 1 from public.poll_options o where o.id = option_id and o.poll_id = poll_id)
);

-- Posts and comments: members write (checked by the triggers above); authors delete their own;
-- admins approve or hide.
create policy "visible posts" on public.posts for select
  using (status = 'visible' or author_id = auth.uid() or public.is_admin());
create policy "members post" on public.posts for insert
  with check (author_id = auth.uid() and public.is_active_user());
create policy "delete own posts" on public.posts for delete using (author_id = auth.uid());
create policy "admins moderate posts" on public.posts for update using (public.is_admin()) with check (public.is_admin());

create policy "visible comments" on public.comments for select
  using (status = 'visible' or author_id = auth.uid() or public.is_admin());
create policy "members comment" on public.comments for insert
  with check (author_id = auth.uid() and public.is_active_user());
create policy "delete own comments" on public.comments for delete using (author_id = auth.uid());
create policy "admins moderate comments" on public.comments for update using (public.is_admin()) with check (public.is_admin());

-- Votes
create policy "see own post votes" on public.post_votes for select using (user_id = auth.uid());
create policy "cast post votes" on public.post_votes for insert with check (user_id = auth.uid() and public.is_active_user());
create policy "change post votes" on public.post_votes for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove post votes" on public.post_votes for delete using (user_id = auth.uid());
create policy "see own comment votes" on public.comment_votes for select using (user_id = auth.uid());
create policy "cast comment votes" on public.comment_votes for insert with check (user_id = auth.uid() and public.is_active_user());
create policy "change comment votes" on public.comment_votes for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove comment votes" on public.comment_votes for delete using (user_id = auth.uid());

-- Reports
create policy "members report" on public.reports for insert with check (reporter_id = auth.uid() and public.is_active_user());
create policy "admins read reports" on public.reports for select using (public.is_admin());
create policy "admins resolve reports" on public.reports for update using (public.is_admin()) with check (public.is_admin());

-- Only the website's own actions may be called by members.
revoke execute on function public.create_user_poll(text, text, text, int, text[]) from public, anon;
revoke execute on function public.set_best_answer(uuid, uuid) from public, anon;
revoke execute on function public.approve_poll(uuid, text, text) from public, anon;
revoke execute on function public.set_banned(uuid, boolean) from public, anon;
grant execute on function public.create_user_poll(text, text, text, int, text[]) to authenticated;
grant execute on function public.set_best_answer(uuid, uuid) to authenticated;
grant execute on function public.approve_poll(uuid, text, text) to authenticated;
grant execute on function public.set_banned(uuid, boolean) to authenticated;

-------------------------------------------------------------------------------
-- Starter data
-------------------------------------------------------------------------------
insert into public.news_sources (name, feed_url) values
  ('TechCrunch AI', 'https://techcrunch.com/category/artificial-intelligence/feed/'),
  ('The Verge AI', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'),
  ('VentureBeat AI', 'https://venturebeat.com/category/ai/feed/'),
  ('MIT Technology Review', 'https://www.technologyreview.com/topic/artificial-intelligence/feed'),
  ('Ars Technica AI', 'https://arstechnica.com/ai/feed/'),
  ('Wired AI', 'https://www.wired.com/feed/tag/ai/latest/rss'),
  ('OpenAI News', 'https://openai.com/news/rss.xml'),
  ('Google AI Blog', 'https://blog.google/technology/ai/rss/'),
  ('Hugging Face Blog', 'https://huggingface.co/blog/feed.xml'),
  ('NVIDIA Blog', 'https://blogs.nvidia.com/feed/'),
  ('The Decoder', 'https://the-decoder.com/feed/'),
  ('AI News', 'https://www.artificialintelligence-news.com/feed/');

insert into public.tickers (symbol, name) values
  ('NVDA', 'NVIDIA'), ('MSFT', 'Microsoft'), ('GOOGL', 'Alphabet'), ('AMZN', 'Amazon'),
  ('META', 'Meta Platforms'), ('AMD', 'Advanced Micro Devices'), ('TSM', 'Taiwan Semiconductor'),
  ('AVGO', 'Broadcom'), ('ASML', 'ASML Holding'), ('ARM', 'Arm Holdings'), ('PLTR', 'Palantir'),
  ('ORCL', 'Oracle'), ('MU', 'Micron Technology'), ('INTC', 'Intel');
