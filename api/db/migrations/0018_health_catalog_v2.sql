-- =============================================================================
-- 0018 · Health catalog v2 — barcode + brand search support
--   Extends food_catalog with UPC / brand / image / serving size for the USDA
--   Branded Foods + Open Food Facts ingestion (server/health/catalog/*), adds a
--   brand-aware generated search column, and records per-source ingest progress
--   so long downloads are resumable. Everything here is idempotent (IF NOT
--   EXISTS) and safe to run twice, in one transaction (the migrate runner
--   applies it with BEGIN/COMMIT).
-- =============================================================================

-- harmless when 0005 already enabled it
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- food_catalog: new columns
-- ---------------------------------------------------------------------------
alter table public.food_catalog
  add column if not exists upc            text,
  add column if not exists brand          text,
  add column if not exists image_url      text,
  add column if not exists serving_size_g numeric;

-- Brand-aware search: generated + stored so a trgm GIN index can serve it.
alter table public.food_catalog
  add column if not exists search_text text
  generated always as (name || ' ' || coalesce(brand, '')) stored;

-- UPC lookup — deliberately NON-unique: the same barcode can come from both
-- sources (usda_branded_food vs open_food_facts) and duplicates resolve by
-- source rank at lookup time (see /foods/barcode/:code).
create index if not exists food_catalog_upc_idx
  on public.food_catalog (upc);

create index if not exists food_catalog_search_text_idx
  on public.food_catalog using gin (search_text gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Ingest progress — one row per source, read/upserted by
-- server/health/catalog/state.ts. last_offset is the spool byte offset of the
-- remote download (USDA zip / OFF gz), resumed via HTTP Range. A gzip/deflate
-- stream cannot be decompressed from a mid-stream byte offset, so processing
-- re-streams the complete spool from 0, relying on idempotent upserts.
-- ---------------------------------------------------------------------------
create table if not exists public.food_catalog_source_state (
  source        text primary key,
  status        text not null default 'pending',
  last_offset   bigint not null default 0,
  last_key      text,
  rows_upserted bigint not null default 0,
  updated_at    timestamptz not null default now()
);
