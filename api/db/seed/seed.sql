-- =============================================================================
-- Budget seed data (local dev) — mirrors the client's former domain/seed.ts
-- plus the YNAB plan parity data applied by
-- db/migrations/0010_ynab_parity_plan_data.sql (groups/categories/Itau card).
-- FAKE data only. Idempotent: truncates app tables then re-inserts. Run:
--   docker compose exec -T postgres psql -U postgres -d postgres < db/seed/seed.sql
--
-- YNAB-shaped storage (0004): milliunits, signed transaction amounts,
-- payee_id references, goal model, first-of-month date months.
--
-- Two budgets:
--   Casa     — the full demo dataset. Tuned so 2026-06 shows the full pill
--              spectrum and Ready-to-Assign = R$25.715,00. Every account
--              balance equals the sum of its transactions: opening money is a
--              "Starting Balance" row (cash in, card debt out) and the card
--              payment on 2026-06-10 is a linked transfer (both legs).
--   Trabalho — a small second budget to exercise the Budget switcher
--              (switching must re-scope every query).
-- =============================================================================
begin;

truncate table public.subtransactions, public.scheduled_subtransactions,
               public.scheduled_transactions, public.payee_locations,
               public.transactions, public.assignments, public.month_notes,
               public.categories, public.category_groups, public.payees,
               public.accounts, public.budgets
  restart identity cascade;

-- Ownership (v1.1 Phase 2): seed budgets ship UNOWNED — the first real
-- sign-in claims them transactionally (USER-04), so relax the finalized
-- NOT NULL if a previous claim on this database already set it.
alter table public.budgets alter column owner_user_id drop not null;

-- ---------------------------------------------------------------------------
-- budgets
-- ---------------------------------------------------------------------------
insert into public.budgets (id, name, currency_format) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Casa',
   '{"iso_code":"BRL","example_format":"123.456,78","decimal_digits":2,"decimal_separator":",","symbol_first":true,"group_separator":".","currency_symbol":"R$","display_symbol":true}'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'Trabalho',
   '{"iso_code":"BRL","example_format":"123.456,78","decimal_digits":2,"decimal_separator":",","symbol_first":true,"group_separator":".","currency_symbol":"R$","display_symbol":true}');

-- ===========================================================================
-- Casa
-- ===========================================================================

-- groups (Credit Card Payments is YNAB-internal; order mirrors YNAB)
insert into public.category_groups (id, budget_id, name, sort_order, is_credit_card_payments, internal) values
  ('11111111-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Credit Card Payments', 0, true, true),
  ('11111111-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Mes', 1, false, false),
  ('99999999-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Recorrentes', 2, false, false),
  ('99999999-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Projetos', 3, false, false),
  ('99999999-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Outros', 4, false, false),
  ('99999999-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Yuri', 5, false, false);

-- categories (goal_target in milliunits; NEED cadence 1 = monthly, TBD = by date)
insert into public.categories
  (id, budget_id, group_id, name, sort_order, note, goal_type, goal_target, goal_cadence, goal_cadence_frequency, goal_target_date) values
  ('22222222-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Academia',0,'Mensalidade da academia.','NEED',120000,1,1,null),
  ('22222222-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Mercado',1,null,'NEED',1200000,1,1,null),
  ('22222222-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Psiquiatra',2,'Consulta mensal.','TBD',800000,null,null,'2026-06-30'),
  ('22222222-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Transporte',3,null,'NEED',300000,1,1,null),
  ('22222222-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Diversão',4,null,null,null,null,null,null),
  ('22222222-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Comer Fora',5,null,null,null,null,null,null),
  ('22222222-0000-0000-0000-000000000007','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Farmacia',6,null,null,null,null,null,null),
  ('22222222-0000-0000-0000-000000000008','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Ifood',7,null,'NEED',200000,1,1,null),
  ('22222222-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Saude',8,null,'NEED',500000,1,1,null),
  ('22222222-0000-0000-0000-000000000010','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Celular',9,null,'NEED',90000,1,1,null),
  ('22222222-0000-0000-0000-000000000011','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000002','Itau Cartão',0,'Reserva para pagar a fatura do cartão.',null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000101','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Mercado Livre',10,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000102','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Comprar Online',11,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000103','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Bebês',12,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000104','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Coisas Para Casa',13,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000105','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','🤷‍♀️ What is this?',14,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000106','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Gastos - Gabriele',15,null,'NEED',4000000,1,1,null),
  ('99999999-0000-0000-0000-000000000107','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','Gastos - Yuri',16,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000108','aaaaaaaa-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','🏛️ Colchão',17,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000201','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Plano de Saude',0,null,'NEED',2536340,1,1,null),
  ('99999999-0000-0000-0000-000000000202','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Verisure',1,null,'NEED',600000,1,1,null),
  ('99999999-0000-0000-0000-000000000203','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Gas',2,null,'NEED',100000,1,1,null),
  ('99999999-0000-0000-0000-000000000204','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Aluguel',3,null,'NEED',2327000,1,1,null),
  ('99999999-0000-0000-0000-000000000205','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Internet',4,null,'NEED',110000,1,1,null),
  ('99999999-0000-0000-0000-000000000206','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Luz',5,null,'NEED',300000,1,1,null),
  ('99999999-0000-0000-0000-000000000207','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','Agua',6,null,'NEED',108000,1,1,null),
  ('99999999-0000-0000-0000-000000000208','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','IPTU',7,null,'NEED',900000,1,1,null),
  ('99999999-0000-0000-0000-000000000209','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000001','1️⃣ Seguro da Casa',8,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000210','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000002','Ar Condicionado',0,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000211','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000002','🧱 Drywal',1,null,'NEED',2000000,1,1,null),
  ('99999999-0000-0000-0000-000000000212','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000002','Servidor',2,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000301','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000003','Business Expenses',0,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000302','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000003','Presentes',1,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000303','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000003','Plano de Saude Out Plan',2,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000304','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000003','Rendimentos',3,null,null,null,null,null,null),
  ('99999999-0000-0000-0000-000000000401','aaaaaaaa-0000-0000-0000-000000000001','99999999-0000-0000-0000-000000000004','1Password',0,null,null,null,null,null,null);

-- accounts (milliunits; YNAB types)
insert into public.accounts
  (id, budget_id, name, type, account_group, on_budget, cleared_balance, uncleared_balance, last_reconciled_at, sort_order) values
  ('33333333-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Itau Conta Corrente','checking',  'CASH',  true, 29420000, -55000, '2025-11-15T12:00:00Z', 0),
  ('33333333-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','Itau Cartão',        'creditCard','CREDIT',true, -3353690, -100000, null,                   1);

-- payees (incl. YNAB-style transfer payees wired to accounts)
insert into public.payees (id, budget_id, name, transfer_account_id) values
  ('44444444-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','Salário',            null),
  ('44444444-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','Smart Fit',          null),
  ('44444444-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','Pão de Açúcar',      null),
  ('44444444-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','Hortifruti',         null),
  ('44444444-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','Posto Shell',        null),
  ('44444444-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001','Restaurante Madero', null),
  ('44444444-0000-0000-0000-000000000007','aaaaaaaa-0000-0000-0000-000000000001','iFood',              null),
  ('44444444-0000-0000-0000-000000000008','aaaaaaaa-0000-0000-0000-000000000001','Vivo',               null),
  ('44444444-0000-0000-0000-000000000009','aaaaaaaa-0000-0000-0000-000000000001','Transferência PIX',  null),
  ('44444444-0000-0000-0000-000000000010','aaaaaaaa-0000-0000-0000-000000000001','Carrefour',          null),
  ('44444444-0000-0000-0000-000000000011','aaaaaaaa-0000-0000-0000-000000000001','Extra',              null),
  ('44444444-0000-0000-0000-000000000012','aaaaaaaa-0000-0000-0000-000000000001','Posto Ipiranga',     null),
  ('44444444-0000-0000-0000-000000000013','aaaaaaaa-0000-0000-0000-000000000001','Transfer : Itau Conta Corrente','33333333-0000-0000-0000-000000000001'),
  ('44444444-0000-0000-0000-000000000014','aaaaaaaa-0000-0000-0000-000000000001','Transfer : Itau Cartão',        '33333333-0000-0000-0000-000000000002'),
  ('44444444-0000-0000-0000-000000000015','aaaaaaaa-0000-0000-0000-000000000001','Starting Balance',  null);

update public.accounts set transfer_payee_id = '44444444-0000-0000-0000-000000000013' where id = '33333333-0000-0000-0000-000000000001';
update public.accounts set transfer_payee_id = '44444444-0000-0000-0000-000000000014' where id = '33333333-0000-0000-0000-000000000002';

-- assignments (month = first-of-month date, budgeted in milliunits)
insert into public.assignments (budget_id, month, category_id, budgeted) values
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-05-01','22222222-0000-0000-0000-000000000001',120000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000001',120000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-04-01','22222222-0000-0000-0000-000000000002',950000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-05-01','22222222-0000-0000-0000-000000000002',1100000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000002',1200000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-04-01','22222222-0000-0000-0000-000000000004',90000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000004',100000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000006',50000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000007',60000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-04-01','22222222-0000-0000-0000-000000000008',150000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-05-01','22222222-0000-0000-0000-000000000008',180000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000008',120000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000009',500000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000010',90000),
  ('aaaaaaaa-0000-0000-0000-000000000001','2026-06-01','22222222-0000-0000-0000-000000000011',2000000);

-- month notes
insert into public.month_notes (budget_id, month, note) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-06-01', 'Mês com consulta no psiquiatra — lembrar de financiar.');

-- transactions (amount = signed milliunits, outflow negative; payee by id)
insert into public.transactions
  (budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat) values
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-06-02','44444444-0000-0000-0000-000000000001', null,                                   'Pagamento mensal',     13800000,'cleared',   true, 'monthly'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-06-03','44444444-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001', null,                    -120000,'cleared',   true, 'monthly'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-06-05','44444444-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000002','Compra da semana',      -450000,'cleared',   true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-06-08','44444444-0000-0000-0000-000000000004','22222222-0000-0000-0000-000000000002', null,                    -400000,'cleared',   true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-06-09','44444444-0000-0000-0000-000000000005','22222222-0000-0000-0000-000000000004','Gasolina',               -80000,'cleared',   true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-06-11','44444444-0000-0000-0000-000000000006','22222222-0000-0000-0000-000000000006','Jantar',                 -90000,'cleared',   true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-06-12','44444444-0000-0000-0000-000000000007','22222222-0000-0000-0000-000000000008', null,                    -100000,'uncleared', true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-06-10','44444444-0000-0000-0000-000000000008','22222222-0000-0000-0000-000000000010','Conta do celular',       -90000,'cleared',   true, 'monthly'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-06-13','44444444-0000-0000-0000-000000000009', null,                                   'Precisa de categoria',   -55000,'uncleared', false,'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-05-04','44444444-0000-0000-0000-000000000010','22222222-0000-0000-0000-000000000002', null,                    -600000,'reconciled',true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-05-12','44444444-0000-0000-0000-000000000003','22222222-0000-0000-0000-000000000002', null,                    -500000,'reconciled',true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-05-15','44444444-0000-0000-0000-000000000007','22222222-0000-0000-0000-000000000008', null,                    -180000,'reconciled',true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-05-03','44444444-0000-0000-0000-000000000002','22222222-0000-0000-0000-000000000001', null,                    -120000,'reconciled',true, 'monthly'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-05-02','44444444-0000-0000-0000-000000000001', null,                                   null,                   13800000,'reconciled',true, 'monthly'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-04-10','44444444-0000-0000-0000-000000000011','22222222-0000-0000-0000-000000000002', null,                    -950000,'reconciled',true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-04-14','44444444-0000-0000-0000-000000000007','22222222-0000-0000-0000-000000000008', null,                    -150000,'reconciled',true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-04-18','44444444-0000-0000-0000-000000000012','22222222-0000-0000-0000-000000000004','Gasolina',               -90000,'reconciled',true, 'never'),
  -- opening money: Starting Balance rows dated before the first activity
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-04-01','44444444-0000-0000-0000-000000000015', null,                                   null,                   5000000,'reconciled',true, 'never'),
  ('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-04-01','44444444-0000-0000-0000-000000000015', null,                                   null,                  -2713690,'reconciled',true, 'never');

-- card payment: a linked transfer, both legs (payee = the peer's transfer payee,
-- transfer_account_id = the peer account, transfer_transaction_id = the other leg)
insert into public.transactions
  (id, budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat, transfer_account_id, transfer_transaction_id) values
  ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000001','2026-06-10','44444444-0000-0000-0000-000000000014', null,'Pagamento parcial da fatura',-1000000,'cleared',true,'never','33333333-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000002','2026-06-10','44444444-0000-0000-0000-000000000013', null,'Pagamento parcial da fatura', 1000000,'cleared',true,'never','33333333-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000001');

-- ===========================================================================
-- Trabalho — minimal second budget (proves switching re-scopes everything)
-- ===========================================================================

insert into public.category_groups (id, budget_id, name, sort_order, is_credit_card_payments) values
  ('11111111-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'Escritório', 0, false);

insert into public.categories
  (id, budget_id, group_id, name, sort_order, note, goal_type, goal_target, goal_cadence, goal_cadence_frequency, goal_target_date) values
  ('22222222-0000-0000-0000-000000000101','aaaaaaaa-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000003','Coworking',0,null,'NEED',1500000,1,1,null),
  ('22222222-0000-0000-0000-000000000102','aaaaaaaa-0000-0000-0000-000000000002','11111111-0000-0000-0000-000000000003','Equipamento',1,null,null,null,null,null,null);

insert into public.accounts
  (id, budget_id, name, type, account_group, on_budget, cleared_balance, uncleared_balance, last_reconciled_at, sort_order) values
  ('33333333-0000-0000-0000-000000000101','aaaaaaaa-0000-0000-0000-000000000002','Conta PJ','checking','CASH',true, 5000000, 0, null, 0);

insert into public.payees (id, budget_id, name, transfer_account_id) values
  ('44444444-0000-0000-0000-000000000101','aaaaaaaa-0000-0000-0000-000000000002','Cliente ACME', null),
  ('44444444-0000-0000-0000-000000000102','aaaaaaaa-0000-0000-0000-000000000002','WeWork',       null),
  ('44444444-0000-0000-0000-000000000103','aaaaaaaa-0000-0000-0000-000000000002','Transfer : Conta PJ','33333333-0000-0000-0000-000000000101'),
  ('44444444-0000-0000-0000-000000000104','aaaaaaaa-0000-0000-0000-000000000002','Starting Balance',  null);

update public.accounts set transfer_payee_id = '44444444-0000-0000-0000-000000000103' where id = '33333333-0000-0000-0000-000000000101';

insert into public.assignments (budget_id, month, category_id, budgeted) values
  ('aaaaaaaa-0000-0000-0000-000000000002','2026-06-01','22222222-0000-0000-0000-000000000101',1500000);

insert into public.transactions
  (budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat) values
  ('aaaaaaaa-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000101','2026-05-01','44444444-0000-0000-0000-000000000104', null,                                   null,                 1500000,'reconciled',true,'never'),
  ('aaaaaaaa-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000101','2026-06-01','44444444-0000-0000-0000-000000000101', null,                                   'Pagamento projeto',  5000000,'cleared',true,'never'),
  ('aaaaaaaa-0000-0000-0000-000000000002','33333333-0000-0000-0000-000000000101','2026-06-05','44444444-0000-0000-0000-000000000102','22222222-0000-0000-0000-000000000101', null,                 -1500000,'cleared',true,'monthly');

commit;
