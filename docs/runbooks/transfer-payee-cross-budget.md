# Transfer payees linked to an account of another budget (budget-njc)

Budget restore used to run `UPDATE payees ... FROM accounts WHERE p.budget_id = $1
AND p.name = 'Transfer : ' || a.name` with no `a.budget_id` condition, so a
`Transfer : X` payee in the restored budget was pointed at EVERY account named
`X` in any budget (last write wins). Symptom: creating a transfer to such a
payee answers 400 `transfer account not found in budget`. The code is fixed in
`api/src/budget/store/restore.ts`; rows damaged before the fix need the repair
below. The original syscd app has the same bug and can re-create it; run the
diagnostic again after using its restore.

Nothing here has been run by the agent that wrote it. No migration is needed.
Run in `psql` against the live database, step by step.

## 1. Diagnose (read-only)

```sql
SELECT p.id            AS payee_id,
       p.budget_id     AS payee_budget,
       p.name          AS payee_name,
       p.transfer_account_id AS linked_account,
       a.budget_id     AS linked_account_budget,
       (SELECT count(*) FROM accounts g
         WHERE g.budget_id = p.budget_id AND NOT g.deleted
           AND 'Transfer : ' || g.name = p.name) AS same_budget_candidates
  FROM payees p
  JOIN accounts a ON a.id = p.transfer_account_id
 WHERE a.budget_id <> p.budget_id
 ORDER BY p.budget_id, p.name;
```

Every row is a payee linked to an account of a different budget.
`same_budget_candidates = 1` means the repair below can fix it; `0` means the
payee's own budget has no live account of that name (the payee is stale, decide
by hand; the repair leaves it alone); `>1` is ambiguous (also left alone).

## 2. Repair

Changes exactly one column, `payees.transfer_account_id`, and only on rows that
the diagnostic lists with exactly one live same-budget account whose name matches
(`'Transfer : ' || name`). It re-points the payee to that account. It touches no
transactions, balances, accounts, or other budgets. Take a backup first
(`pg_dump -t payees`), and run it in a transaction:

```sql
BEGIN;

UPDATE payees p
   SET transfer_account_id = m.account_id
  FROM (
    SELECT p2.id AS payee_id, min(g.id::text)::uuid AS account_id
      FROM payees p2
      JOIN accounts bad ON bad.id = p2.transfer_account_id AND bad.budget_id <> p2.budget_id
      JOIN accounts g   ON g.budget_id = p2.budget_id AND NOT g.deleted
                       AND 'Transfer : ' || g.name = p2.name
     GROUP BY p2.id
    HAVING count(*) = 1
  ) m
 WHERE p.id = m.payee_id;

-- expect: UPDATE <n>, with n = rows of the diagnostic that had same_budget_candidates = 1
-- re-run the diagnostic: only the 0 / >1 rows may remain
COMMIT;   -- or ROLLBACK;
```

## 3. Verify

Before: save the diagnostic output (and `SELECT count(*) FROM payees WHERE
transfer_account_id IS NOT NULL`). After: the diagnostic returns only the
`0` / `>1` rows (ideally none), the total linked-payee count is unchanged, and
in the app a transfer to the formerly broken `Transfer : X` payee is accepted
and lands on the account of its own budget.
