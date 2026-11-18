-- =============================================================================
-- 0005 · Health module schema
--   Calorie-counter storage (food catalog + portions + daily log + user
--   profile) for modules/health. Auth users are referenced but this migration
--   intentionally does NOT create auth schema artifacts — those are supplied by
--   the platform / worktree bootstrap.
-- =============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------
do $$ begin create type log_source as enum ('manual','quick_add','photo_ai','chat_ai'); exception when duplicate_object then null; end $$;
do $$ begin create type activity_level as enum ('sedentary','lightly_active','moderately_active','very_active'); exception when duplicate_object then null; end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

-- ---------------------------------------------------------------------------
-- food_catalog
-- ---------------------------------------------------------------------------
create table if not exists public.food_catalog (
  fdc_id        int primary key,
  name          text not null,
  category      text,
  kcal_100g     numeric not null default 0,
  protein_100g  numeric not null default 0,
  carbs_100g    numeric not null default 0,
  fat_100g      numeric not null default 0,
  fiber_100g    numeric not null default 0,
  popularity    int not null default 0,
  source        text not null default 'usda_sr_legacy'
);
create index if not exists food_catalog_name_idx on public.food_catalog using gin (name gin_trgm_ops);
create index if not exists food_catalog_popularity_idx on public.food_catalog (popularity desc);

-- ---------------------------------------------------------------------------
-- food_portion
-- ---------------------------------------------------------------------------
create table if not exists public.food_portion (
  id            uuid primary key default gen_random_uuid(),
  fdc_id        int not null references public.food_catalog (fdc_id) on delete cascade,
  label         text not null,
  gram_weight   numeric not null,
  is_default    boolean not null default false,
  unique (fdc_id, label)
);
create index if not exists food_portion_fdc_idx on public.food_portion (fdc_id);

-- ---------------------------------------------------------------------------
-- user_profile
-- ---------------------------------------------------------------------------
create table if not exists public.user_profile (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  sex               text check (sex in ('M','F')),
  birth_date        date,
  height_cm         numeric,
  weight_kg         numeric,
  activity_level    activity_level,
  goal_delta_kcal   int not null default 0,
  daily_kcal_goal   int not null default 2000,
  show_macros       boolean not null default true,
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- log_entry
-- ---------------------------------------------------------------------------
create table if not exists public.log_entry (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  logged_date     date not null default current_date,
  meal            text not null check (meal in ('breakfast','lunch','dinner','snacks')),
  fdc_id          int references public.food_catalog (fdc_id) on delete set null,
  custom_name     text,
  quantity        numeric not null default 1,
  unit            text not null default 'serving',
  gram_weight     numeric not null,
  kcal            numeric not null default 0,
  protein_g       numeric not null default 0,
  carbs_g         numeric not null default 0,
  fat_g           numeric not null default 0,
  photo_url       text,
  source          log_source not null default 'manual',
  ai_raw          jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists log_entry_user_date_idx on public.log_entry (user_id, logged_date);
create index if not exists log_entry_fdc_idx on public.log_entry (fdc_id);
