/**
 * Phantom pending installments after an early payment.
 *
 * When a card installment purchase is paid early ("DESC ANTECIPA PARCELAS"),
 * Itaú bills the remaining installments at once, yet keeps listing the
 * original installment as PENDING under another bank id (e.g.
 * "PortovalleAcabame 04/04" POSTED 2026-09-06 and PENDING 2026-11-05, same
 * amount). Importing that copy would count the installment twice, so the sync
 * skips a PENDING installment whose purchase (purchaseDate + description stem
 * + total) and installment number are already POSTED on the same account.
 */
import type { Queryable } from '../core/db';
import { installmentStem, paidInstallmentKey, readInstallmentMeta } from '@shared/domain/installments';
import { postedInstallmentDescriptions } from './ledger-reads';
import type { AggregatedTransaction } from './types';

/** Why the sync skipped such a row (job log). */
export const PAID_INSTALLMENT_REASON = 'installment already paid';

/** True when `txn` is a PENDING installment already imported as POSTED into `accountId`. */
export async function isPaidInstallmentCopy(db: Queryable, accountId: string, txn: AggregatedTransaction): Promise<boolean> {
  const meta = readInstallmentMeta(txn.raw);
  if (!meta || meta.posted) return false;
  const description = typeof txn.raw.description === 'string' ? txn.raw.description : txn.description;
  const key = paidInstallmentKey(accountId, meta.purchaseDate, installmentStem(description, meta.number, meta.total), meta.number, meta.total);
  const posted = await postedInstallmentDescriptions(db, accountId, meta);
  return posted.some(
    (d) => paidInstallmentKey(accountId, meta.purchaseDate, installmentStem(d, meta.number, meta.total), meta.number, meta.total) === key,
  );
}
