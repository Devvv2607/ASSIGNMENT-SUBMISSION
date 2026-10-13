-- Proxy schema. Run once in the Supabase SQL editor (or via the Supabase MCP / CLI).

create extension if not exists pgcrypto;

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  linkedin_url text not null unique,
  instagram_url text not null unique,
  consent_source text not null,
  gender text check (gender in ('man', 'woman')),   -- self-reported at submission, optional, never inferred
  avatar_url text,
  status text not null default 'queued',            -- queued | ingesting | reading | ready | error
  error text,
  created_at timestamptz not null default now()
);

create table if not exists raw_sources (
  person_id uuid not null references people(id) on delete cascade,
  source text not null,                             -- linkedin | instagram
  actor_id text not null,
  run_id text,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (person_id, source)
);

create table if not exists evidence (
  person_id uuid not null references people(id) on delete cascade,
  id text not null,                                 -- e.g. li:exp:2, ig:post:7, ig:img:7
  source text not null,
  kind text not null,
  text text not null,
  image_url text,
  meta jsonb not null default '{}',
  primary key (person_id, id)
);

create table if not exists profiles (
  person_id uuid primary key references people(id) on delete cascade,
  profile jsonb not null,
  model text not null,
  created_at timestamptz not null default now()
);

create table if not exists pair_priors (
  a_id uuid not null references people(id) on delete cascade,
  b_id uuid not null references people(id) on delete cascade,
  prior_score numeric not null,
  shared jsonb not null default '[]',
  primary key (a_id, b_id)
);

create table if not exists dates (
  id uuid primary key default gen_random_uuid(),
  a_id uuid not null references people(id) on delete cascade,
  b_id uuid not null references people(id) on delete cascade,
  status text not null default 'queued',            -- queued | prep | venue | talking | debrief | done | error
  venue text,
  scene text,
  prep jsonb,
  ended_early_by uuid,
  mutual_score numeric,
  error text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists dates_a on dates(a_id);
create index if not exists dates_b on dates(b_id);

create table if not exists date_turns (
  date_id uuid not null references dates(id) on delete cascade,
  idx int not null,
  speaker_id uuid not null references people(id) on delete cascade,
  say text not null,
  inner_thought text not null,
  signals jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (date_id, idx)
);

create table if not exists debriefs (
  date_id uuid not null references dates(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  report jsonb not null,
  primary key (date_id, person_id)
);

create table if not exists job_events (
  id bigserial primary key,
  person_id uuid not null references people(id) on delete cascade,
  step text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists job_events_person on job_events(person_id, id);

-- Public read for the demo, writes only through server routes (service role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['people','evidence','profiles','pair_priors','dates','date_turns','debriefs','job_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "public read" on %I', t);
    execute format('create policy "public read" on %I for select using (true)', t);
  end loop;
  alter table raw_sources enable row level security;  -- raw scrapes are never public
end $$;

-- Public bucket for cached Instagram images (IG CDN URLs expire).
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

-- ---------- v2: resumable step pipelines, rate limits, cost tracking ----------

alter table people add column if not exists stage text not null default 'scrape_linkedin';
alter table people add column if not exists lock_until timestamptz;
alter table people add column if not exists planned_dates uuid[] not null default '{}';
alter table dates add column if not exists lock_until timestamptz;
alter table raw_sources add column if not exists usage_usd numeric;

create table if not exists llm_usage (
  id bigserial primary key,
  person_id uuid references people(id) on delete set null,
  date_id uuid references dates(id) on delete set null,
  step text not null,
  model text not null,
  prompt_tokens int not null,
  completion_tokens int not null,
  created_at timestamptz not null default now()
);
alter table llm_usage enable row level security;

create table if not exists rate_events (
  id bigserial primary key,
  kind text not null,            -- add | date
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_events_kind_time on rate_events(kind, created_at);
alter table rate_events enable row level security;

-- Make PostgREST pick up the new tables immediately.
notify pgrst, 'reload schema';
