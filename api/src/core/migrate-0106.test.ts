import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'bun:test';

import { pool } from './db';

let reachable = true;
try {
  await pool.query('select 1');
} catch {
  reachable = false;
}

const SQL_0106 = readFileSync(
  join(import.meta.dir, '..', '..', 'db', 'migrations', '0106_connection_transactions_per_budget.sql'),
  'utf8',
);

// Regression for the v2026.11.23-02 crash loop: prod (shared DB) has
// transactions whose budget_id has no budgets row. The test DB is at 0106, so
// inside one transaction (rolled back) it is put back to the 0105 shape,
// seeded with messy rows, and 0106 is re-applied.
describe.skipIf(!reachable)('migration 0106 on messy 0105 data', () => {
  it('applies with orphan, NULL-budget and duplicate ledger rows', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Back to the 0105 shape.
      await client.query(`
        drop index if exists public.connection_transactions_budget_key;
        drop trigger if exists connection_transactions_fill_budget on public.connection_transactions;
        drop function if exists public.connection_transactions_fill_budget();
        alter table public.connection_transactions drop column budget_id;
        delete from public.connection_transactions;
        alter table public.transactions alter column budget_id drop not null;
      `);
      // Seed without FK checks: an orphan budget, a NULL budget, and (with the
      // global unique gone, as on a database that never had it) a duplicate.
      await client.query('set local session_replication_role = replica');
      const orphan = crypto.randomUUID();
      const account = crypto.randomUUID();
      const [tOrphan, tNull, tDupOld, tDupNew] = [1, 2, 3, 4].map(() => crypto.randomUUID());
      await client.query(
        `insert into public.transactions (id, budget_id, account_id, date, amount) values
           ($1, $5, $6, '2026-01-01', 0), ($2, null, $6, '2026-01-01', 0),
           ($3, $5, $6, '2026-01-01', 0), ($4, $5, $6, '2026-01-01', 0)`,
        [tOrphan, tNull, tDupOld, tDupNew, orphan, account],
      );
      await client.query(
        `insert into public.connection_transactions (transaction_id, provider, external_transaction_id, updated_at) values
           ($1, 'pluggy', 'ext-1', now()), ($2, 'pluggy', 'ext-2', now())`,
        [tOrphan, tNull],
      );
      await client.query(
        'alter table public.connection_transactions drop constraint if exists connection_transactions_provider_external_transaction_id_key',
      );
      await client.query(
        `insert into public.connection_transactions (transaction_id, provider, external_transaction_id, updated_at) values
           ($1, 'pluggy', 'ext-dup', now() - interval '1 day'), ($2, 'pluggy', 'ext-dup', now())`,
        [tDupOld, tDupNew],
      );
      await client.query('set local session_replication_role = origin');

      await client.query(SQL_0106);

      const { rows } = await client.query<{ transaction_id: string; budget_id: string }>(
        'select transaction_id, budget_id from public.connection_transactions order by external_transaction_id',
      );
      expect(rows).toEqual([
        { transaction_id: tOrphan, budget_id: orphan },
        { transaction_id: tDupNew, budget_id: orphan },
      ]);
      const idx = await client.query("select to_regclass('public.connection_transactions_budget_key') as i");
      expect(idx.rows[0].i).not.toBeNull();
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
