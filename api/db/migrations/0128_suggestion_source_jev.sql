-- 0128 · Suggestion source 'ai' becomes 'jev' (owner decision, 2026-11-26).
--   A data-only update on the feature's own table, which the running syscd-app
--   never names.
--
--   category_suggestions.source has no check constraint (0110: the list of
--   sources is code), so there is no constraint to replace: the allowed values
--   live in SuggestionSource (api/src/categorize/store.ts) and
--   categorizeSuggestionSourceSchema (shared/src/contracts/categorize/outputs.ts).
--   provider ('jev') and model keep their names and values.
--
--   Idempotent: the update never matches its own output, so a re-run is a
--   no-op. Listed in MIGRATION_EXEMPT (no schema to probe).
update public.category_suggestions
   set source = 'jev'
 where source = 'ai';
