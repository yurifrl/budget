-- 0111 · category_suggestions(category_id) index (budget-fvtx review F12).
--   category_suggestions.category_id references categories(id) `on delete
--   cascade`; without an index on the referencing column a category delete
--   scans the whole suggestions table once per row. Additive only.
create index if not exists category_suggestions_category_idx
  on public.category_suggestions (category_id);
