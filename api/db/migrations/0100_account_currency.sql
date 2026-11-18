-- 0100 · accounts.currency (G1): the currency an account is held in, as an
--   ISO 4217 code ('BRL', 'USD', ...). NULL means "the budget's currency"
--   (budgets.currency_format), which is what every existing row is: no
--   default, no backfill. No conversion logic reads it yet.
--
--   Additive and nullable on purpose: this database is shared with the running
--   syscd-app, which never names the column (see docs/decisions.md, phase 5d).
alter table public.accounts
  add column if not exists currency text
    constraint accounts_currency_iso4217 check (currency ~ '^[A-Z]{3}$');
