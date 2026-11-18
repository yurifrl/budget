# Category bundles — design

> Copied from syscd-app `docs/` (phase 5a). Paths: syscd `modules/budget/*` is `client/src/*` here (domain in `client/src/domain`, plan feature in `client/src/features/plan`); server side in `api/src/budget`.

Status: agreed 2026-11-17. Mocks: `mocks/category-stacks.svg` (web),
`mocks/category-stacks-mobile.svg` (phone), `mocks/category-stacks-grouping.svg`
(how to create/edit a bundle).

## What it is

A **bundle** is a display-only roll-up of categories inside one category group
(e.g. group *Health* → bundle *Medicines* → categories *Dipirona*, *Ibuprofeno*,
*Vitamin D*). The category stays the smallest budgeting unit: every bundled
category keeps its own assigned / activity / available / target / notes /
transactions. Nothing in the engine, Ready to Assign, assignments, targets or
transactions changes.

## Decisions

| Topic | Decision |
|---|---|
| Name | **Bundle** (UI: "Add to bundle ▸", "Remove from bundle", "Ungroup") — "group" stays the category group. |
| Bundle row | Read-only sums of its categories (assigned, activity, available). No numpad / inline assign on it. |
| Expand state | Collapsed by default; per-user, per-device view pref in `core/storage` (not synced). |
| Scope | One bundle belongs to one category group. All its categories share that group. |
| Cross-group drop | Dropping a category onto a bundle / category of another group moves the category to that group and joins the bundle (normal move). |
| Empty bundle | Removing the last category deletes the bundle (server enforces). A bundle is created with ≥ 2 categories. |
| Picker | Category pickers show `Medicines › Dipirona`; search matches bundle or category name. |
| Reports | Reflect spend-by-category shows one *Medicines* row (sum) that expands into its categories; category filter chip on a bundle filters all its categories. Spending feed label shows `Medicines › Dipirona`. |
| Order | Bundle sits at the position of its first category; its categories stay contiguous (client writes contiguous `sort_order`s through the existing reorder op). |

## Data model (migration `0032_category_bundles.sql`)

```sql
create table public.category_bundles (
  id         uuid primary key default gen_random_uuid(),
  budget_id  uuid not null references public.budgets(id) on delete cascade,
  group_id   uuid not null references public.category_groups(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create index category_bundles_group_idx on public.category_bundles(group_id);
alter table public.categories
  add column bundle_id uuid references public.category_bundles(id) on delete set null;
```

Invariant (handler-enforced, tested): `categories.bundle_id → bundle.group_id = categories.group_id`.

## Operations (server/budget, contract + implement only)

New contract file `server/budget/contracts/category-bundles.ts` (+ line in the
contracts barrel), routes `server/budget/routes/category-bundles.ts`:

- `budget_bundles_list` (read, GET) — bundles of a budget.
- `budget_bundles_create` (write) — `{ budget_id, group_id, name, category_ids (≥2) }`;
  moves any listed category from another group into `group_id`.
- `budget_bundles_rename` (write).
- `budget_bundles_delete` (destructive) — "Ungroup": clears `bundle_id`, categories stay.
- `budget_categories_set_bundle` (write) — `{ budget_id, category_ids, bundle_id | null }`;
  joining a bundle in another group moves the category's group; deletes a bundle left with 0.

Existing: `budget_categories_list` returns `bundle_id`; `budget_categories_reorder`
moving a category to another group clears its `bundle_id` unless the target bundle is
in that group; `budget_categories_delete` deletes an emptied bundle; export/restore
round-trip bundles.

## App

- `modules/budget/domain/types.ts`: `Bundle { id, groupId, name }`, `Category.bundleId?`, `Budget.bundles`.
- `modules/budget/domain/bundles.ts` (pure, tested): `planRows(group, categories, bundles)` →
  `({kind:'category'} | {kind:'bundle', bundle, children, sums})[]`; `categoryLabel(c, bundles)` →
  `"Medicines › Dipirona"`; `dropIntent(y, rowRect)` → `'before' | 'after' | 'bundle'`
  (middle 50 % = bundle, outer 25 % each = reorder).
- `data/api.ts` + `data/mapping.ts`: new endpoints, `bundle_id` mapping.
- Plan (web/desktop): bundle row (chevron, name, count badge, greyed assigned, sum pill),
  tree-line children; center-zone drop on existing pointer drag; multi-select
  selection bar "Bundle…" (name popover); category menu "Add to bundle ▸ (existing… / New bundle…)",
  "Remove from bundle"; bundle row menu Rename · Add category here · Ungroup.
- Plan (phone): bundle row tap toggles (no numpad); child tap opens numpad with
  `Medicines › Ibuprofeno` header; long-press menus as above.
- Plan (phone drag): hold ~0.4 s → menu; moving while held closes menu and starts drag
  (react-native-gesture-handler + reanimated, already deps); edge = reorder/move, center =
  bundle; drop creating a bundle opens it with name field focused. Accessibility path =
  the menus.
