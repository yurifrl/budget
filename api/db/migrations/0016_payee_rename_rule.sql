-- =============================================================================
-- 0016 · Per-payee renaming rule
--   One rename rule per payee: (rename_match_type, rename_condition) on the
--   payees row, with the payee's own name as the rename target. Replaces the
--   global payee_rename_rules table; each existing rule (pattern, match_type
--   -> payee named `replacement`) moves onto that payee when one exists.
--   rename_condition IS NULL means the payee carries no rule.
-- =============================================================================

alter table public.payees
  add column rename_match_type text,
  add column rename_condition text;

-- Backfill: rule (pattern, match_type -> payee named replacement). First
-- rule (created_at, pattern) wins per payee; a condition is claimed by only
-- one payee per budget, so later rules reusing it are dropped.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pattern, match_type, budget_id, replacement
    FROM public.payee_rename_rules
    ORDER BY created_at, pattern
  LOOP
    UPDATE public.payees
       SET rename_match_type = r.match_type,
           rename_condition  = r.pattern
     WHERE budget_id = r.budget_id
       AND name = r.replacement
       AND deleted = false
       AND rename_condition IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.payees other
          WHERE other.budget_id = r.budget_id
            AND other.deleted = false
            AND other.rename_condition = r.pattern
       );
  END LOOP;
END $$;

-- A condition matches at most one payee per budget.
CREATE UNIQUE INDEX payees_rename_condition_key
  ON public.payees (budget_id, rename_condition)
  WHERE rename_condition IS NOT NULL;

DROP TABLE public.payee_rename_rules;
