-- =============================================================================
-- 0010 · YNAB plan-data parity — budget "Casa" (syscd-app-5wv)
--   Brings the seeded Casa budget's category tree in line with the real YNAB
--   "Casa" budget (verified via YNAB v1 API, Sept 2026):
--     * missing groups Recorrentes / Projetos / Outros / Yuri
--     * missing Mes categories (incl. "Mercado Livre", which YNAB has as a
--       separate empty category next to the grocery "Mercado")
--     * credit-card mapping: the real card is Itau Cartão (no Nubank account
--       exists in YNAB) — rename account, its transfer payee, and the
--       Credit-Card-Payments category; ids unchanged so transaction history
--       and FKs stay intact
--   Group display order follows YNAB (Credit Card Payments first).
--   Idempotent: guarded renames + ON CONFLICT DO NOTHING, so re-running (and
--   re-running after a fresh seed) is a no-op.
--   New categories mirror YNAB's NEED targets where present; no assignment
--   rows are created (Ready-to-Assign math stays untouched).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- credit card mapping: Nubank Cartão -> Itau Cartão (Casa budget only)
-- ---------------------------------------------------------------------------
update public.accounts
   set name = 'Itau Cartão'
 where id = '33333333-0000-0000-0000-000000000002'
   and name <> 'Itau Cartão';

update public.payees
   set name = 'Transfer : Itau Cartão'
 where id = '44444444-0000-0000-0000-000000000014'
   and name <> 'Transfer : Itau Cartão';

update public.categories
   set name = 'Itau Cartão'
 where id = '22222222-0000-0000-0000-000000000011'
   and name <> 'Itau Cartão';

-- ---------------------------------------------------------------------------
-- group order: YNAB renders Credit Card Payments first
-- ---------------------------------------------------------------------------
update public.category_groups set sort_order = 1
 where id = '11111111-0000-0000-0000-000000000001' and sort_order <> 1; -- Mes
update public.category_groups set sort_order = 0
 where id = '11111111-0000-0000-0000-000000000002' and sort_order <> 0; -- Credit Card Payments

-- ---------------------------------------------------------------------------
-- missing groups (Casa)
-- ---------------------------------------------------------------------------
insert into public.category_groups (id, budget_id, name, sort_order, is_credit_card_payments, internal)
values
  ('99999999-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Recorrentes', 2, false, false),
  ('99999999-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Projetos',    3, false, false),
  ('99999999-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Outros',      4, false, false),
  ('99999999-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Yuri',        5, false, false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- missing categories (Casa) — goal_target in milliunits; NEED cadence 1 =
-- monthly; goal_creation_month mirrors YNAB's target creation month
-- ---------------------------------------------------------------------------
insert into public.categories
  (id, budget_id, group_id, name, sort_order, note, goal_type, goal_target, goal_cadence, goal_cadence_frequency, goal_creation_month)
values
  -- Mes (append after existing sort 0..9)
  ('99999999-0000-0000-0000-000000000101', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Mercado Livre',         10, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000102', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Comprar Online',        11, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000103', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Bebês',                 12, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000104', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Coisas Para Casa',      13, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000105', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '🤷‍♀️ What is this?',   14, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000106', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Gastos - Gabriele',     15, null, 'NEED',   4000000, 1,    1,    '2025-02-01'),
  ('99999999-0000-0000-0000-000000000107', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'Gastos - Yuri',         16, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000108', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '🏛️ Colchão',            17, null, null,     null,    null, null, null),
  -- Recorrentes
  ('99999999-0000-0000-0000-000000000201', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Plano de Saude',         0, null, 'NEED',   2536340, 1,    1,    '2025-03-01'),
  ('99999999-0000-0000-0000-000000000202', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Verisure',               1, null, 'NEED',   600000,  1,    1,    '2025-10-01'),
  ('99999999-0000-0000-0000-000000000203', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Gas',                    2, null, 'NEED',   100000,  1,    1,    '2025-05-01'),
  ('99999999-0000-0000-0000-000000000204', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Aluguel',                3, null, 'NEED',   2327000, 1,    1,    '2025-02-01'),
  ('99999999-0000-0000-0000-000000000205', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Internet',               4, null, 'NEED',   110000,  1,    1,    '2024-08-01'),
  ('99999999-0000-0000-0000-000000000206', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Luz',                    5, null, 'NEED',   300000,  1,    1,    '2024-08-01'),
  ('99999999-0000-0000-0000-000000000207', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'Agua',                   6, null, 'NEED',   108000,  1,    1,    '2025-02-01'),
  ('99999999-0000-0000-0000-000000000208', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', 'IPTU',                   7, null, 'NEED',   900000,  1,    1,    '2025-05-01'),
  ('99999999-0000-0000-0000-000000000209', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001', '1️⃣ Seguro da Casa',      8, null, null,     null,    null, null, null),
  -- Projetos (YNAB also has 5 hidden project categories here — not replicated)
  ('99999999-0000-0000-0000-000000000210', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', 'Ar Condicionado',        0, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000211', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', '🧱 Drywal',             1, null, 'NEED',   2000000, 1,    1,    '2024-09-01'),
  ('99999999-0000-0000-0000-000000000212', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', 'Servidor',               2, null, null,     null,    null, null, null),
  -- Outros
  ('99999999-0000-0000-0000-000000000301', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000003', 'Business Expenses',      0, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000302', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000003', 'Presentes',              1, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000303', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000003', 'Plano de Saude Out Plan',2, null, null,     null,    null, null, null),
  ('99999999-0000-0000-0000-000000000304', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000003', 'Rendimentos',            3, null, null,     null,    null, null, null),
  -- Yuri
  ('99999999-0000-0000-0000-000000000401', 'aaaaaaaa-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000004', '1Password',              0, null, null,     null,    null, null, null)
on conflict (id) do nothing;
