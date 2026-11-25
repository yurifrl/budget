/**
 * Repair one budget's transfer payees: exactly one "Transfer : <account>" per
 * account, linked both ways, named after the account (see
 * src/budget/domain/transfer-payee-repair.ts for what it finds and changes).
 *
 *   DATABASE_URL=postgres://... bun scripts/repair-transfer-payees.ts --budget <uuid>          report only
 *   DATABASE_URL=postgres://... bun scripts/repair-transfer-payees.ts --budget <uuid> --apply  repair
 *
 * The default is a READ-ONLY report (one READ ONLY transaction: it cannot
 * write, whatever the code does): it prints, as JSON, what --apply would
 * change and changes nothing. --apply runs the repair in one transaction and
 * prints the same plan; running it again reports nothing to do. It is a
 * script, not a migration, so nothing runs when a release boots: run the
 * report on a copy or on production first, review it, then --apply.
 */
import { configureDb, pool } from '../src/core/db';
import { repairTransferPayees } from '../src/budget/domain/transfer-payee-repair';

const args = process.argv.slice(2);
const budgetIndex = args.indexOf('--budget');
const budgetId = budgetIndex >= 0 ? args[budgetIndex + 1] : undefined;
const apply = args.includes('--apply');
if (!budgetId || !/^[0-9a-f-]{36}$/i.test(budgetId)) {
  console.error('usage: bun scripts/repair-transfer-payees.ts --budget <uuid> [--apply]');
  process.exit(2);
}

configureDb({ connectionString: process.env.DATABASE_URL ?? '' });
const client = await pool.connect();
let code = 0;
try {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  const report = await repairTransferPayees(client, budgetId, { apply });
  await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(err);
  code = 1;
} finally {
  client.release();
  await pool.end();
}
process.exit(code);
