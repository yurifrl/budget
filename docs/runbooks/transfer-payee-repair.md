# Repair a budget's transfer payees (budget-upgg)

Every account should have exactly one payee "Transfer : <account>", linked both
ways (`payees.transfer_account_id`, `accounts.transfer_payee_id`). Old data can
have an account with none, with several (an account rename left the old one and
the new name was picked later), or unlinked "Transfer : X" payees written by
older code, restores or the other app. The repair finds them and folds them into
one payee per account. Rules in `docs/decisions.md` ("Transfer payee lifecycle").

Nothing runs on its own: it is a script, run per budget, by a person.

## 1. Report (read only)

```
DATABASE_URL=postgres://... bun api/scripts/repair-transfer-payees.ts --budget <budget-uuid>
```

Runs inside a READ ONLY transaction and prints JSON: how many accounts have no
payee or several, how many name-only payees would be adopted, how many payees
would be removed, how many transactions would be re-pointed, how many renaming
rules would move and which would be dropped: `dropped_rules` lists each one (payee,
rule, and the payee that keeps its own different rule; a payee holds one renaming
rule and one "treat as transfer" rule), plus `actions` with the account and payee
ids. Read `dropped_rules` before `--apply`. `kept_payees` lists duplicates that rows
of another budget still reference: they are NOT deleted, only unlinked (see
`transfer-payee-cross-budget.md`). `ambiguous_name_only_payees` (two accounts share the
name) and `orphan_transfer_payees` are listed and never touched.

## 2. Apply

Take a backup first (`pg_dump -t payees -t accounts -t transactions`), then:

```
DATABASE_URL=postgres://... bun api/scripts/repair-transfer-payees.ts --budget <budget-uuid> --apply
```

One transaction. It prints the plan it executed. Run it again: `actions` is empty.

## 3. Verify

Report again (empty `actions`), and:

```sql
-- one live payee per live account, and the account points at it (expect 0 rows)
SELECT a.id, a.name, count(p.id) AS payees, bool_and(a.transfer_payee_id = p.id) AS pointer_ok
  FROM accounts a LEFT JOIN payees p ON p.transfer_account_id = a.id AND NOT p.deleted
 WHERE a.budget_id = '<budget-uuid>' AND NOT a.deleted
 GROUP BY a.id, a.name HAVING count(p.id) <> 1 OR NOT bool_and(a.transfer_payee_id = p.id);
```

Balances do not change: the repair moves no amount and touches no account balance.
