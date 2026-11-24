/**
 * Card installment purchases ("parcelas"), from the bank's own metadata.
 *
 * Pluggy sends one row per installment, and only once it is billed: `amount`
 * is that single installment, `creditCardMetadata` carries
 * `installmentNumber` / `totalInstallments` / `purchaseDate` (`billId` is
 * null while the row is PENDING), and the description ends in "NN/MM"
 * ("ACADEMIA ACQUA 02/12", "MERCADOLIVRE*MERCA01/02" with no space,
 * "PET LOVE*Clube NE804/12" glued to the merchant name).
 *
 * One purchase = account + purchaseDate + description stem (the description
 * without its "NN/MM" suffix) + totalInstallments. From the highest
 * installment seen, `projectUpcomingInstallments` derives the remaining
 * ones (n+1..N) as upcoming placeholders. They are computed at read time,
 * never stored: when the real installment k arrives it becomes the highest
 * seen and placeholder k simply stops being produced.
 *
 * Schedule (kept simple on purpose): placeholder k is dated
 * `k - n` calendar months after the date of the highest installment seen
 * (n), with the day clamped to the target month's length. It does not try to
 * follow the card's closing/due dates.
 *
 * `paidInstallmentKey` identifies one installment of one purchase: after an
 * early payment ("DESC ANTECIPA PARCELAS") Itaú keeps listing an installment
 * that was already POSTED as PENDING under another id; the sync skips that
 * pending copy when the key is already posted.
 *
 * Pure: no I/O. Used by the api (register list, sync) and testable alone.
 */

/** What the bank's metadata says about one installment row. */
export interface InstallmentMeta {
  /** 1-based installment number (n of N). */
  number: number;
  /** Total installments (N >= 2). */
  total: number;
  /** `YYYY-MM-DD` of the purchase; null when the bank does not send it. */
  purchaseDate: string | null;
  /** True for a billed (POSTED) row, false while PENDING. */
  posted: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Installment metadata of a provider transaction object (Pluggy's
 * `creditCardMetadata`), or null when the row is not an installment of a
 * purchase split in 2 or more. Accepts both spellings Pluggy has used
 * (`installmentNumber` and `instalmentNumber`).
 */
export function readInstallmentMeta(raw: unknown): InstallmentMeta | null {
  if (!isRecord(raw)) return null;
  const meta = raw.creditCardMetadata;
  if (!isRecord(meta)) return null;
  const number = positiveInt(meta.installmentNumber ?? meta.instalmentNumber);
  const total = positiveInt(meta.totalInstallments ?? meta.totalInstalments);
  if (number == null || total == null || total < 2 || number > total) return null;
  const purchase = typeof meta.purchaseDate === 'string' && meta.purchaseDate.length >= 10 ? meta.purchaseDate.slice(0, 10) : null;
  const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : null;
  const posted = status != null ? status === 'POSTED' : meta.billId != null;
  return { number, total, purchaseDate: purchase, posted };
}

/** A description's trailing "NN/MM" installment suffix, when it has one. */
export function parseInstallmentSuffix(description: string): { stem: string; number: number; total: number } | null {
  // Lazy stem + at most two digits each side: "NE804/12" splits as
  // "NE8" + "04/12", never "NE" + "804/12".
  const m = /^(.*?)\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(description);
  if (!m) return null;
  const number = Number(m[2]);
  const total = Number(m[3]);
  if (number < 1 || total < 2 || number > total) return null;
  const stem = m[1]!.trim();
  return stem ? { stem, number, total } : null;
}

/**
 * The description without the "n/N" suffix of THIS installment (leading
 * zeros optional, spaces optional). A description whose suffix does not
 * match n/N is returned whole (trimmed).
 */
export function installmentStem(description: string, number: number, total: number): string {
  const trimmed = description.trim();
  const m = new RegExp(`^(.*?)\\s*0*${number}\\s*/\\s*0*${total}$`).exec(trimmed);
  const stem = m?.[1]?.trim();
  return stem || trimmed;
}

/** "<stem> kk/NN", zero-padded to two digits like the bank writes it. */
export function installmentLabel(stem: string, number: number, total: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${stem} ${pad(number)}/${pad(total)}`;
}

/** Case/space-insensitive stem for grouping (the bank's casing is stable, spacing is not). */
const normStem = (stem: string): string => stem.replace(/\s+/g, ' ').trim().toUpperCase();

/** Identity of one purchase on one card account. */
export function installmentPurchaseKey(accountId: string, purchaseDate: string | null, stem: string, total: number): string {
  return [accountId, purchaseDate ?? '', normStem(stem), total].join('|');
}

/** Identity of one installment of one purchase (anticipation phantom check). */
export function paidInstallmentKey(
  accountId: string,
  purchaseDate: string | null,
  stem: string,
  number: number,
  total: number,
): string {
  return `${installmentPurchaseKey(accountId, purchaseDate, stem, total)}#${number}`;
}

/** `YYYY-MM-DD` plus `months` calendar months, the day clamped to the target month. */
export function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const ty = Math.floor(index / 12);
  const tm = index - ty * 12; // 0-based
  const days = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(ty, 4)}-${pad(tm + 1)}-${pad(Math.min(d, days))}`;
}

/** One imported card row that may be an installment (live or deleted). */
export interface InstallmentSource {
  /** Budget transaction id. */
  id: string;
  accountId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed milliunits of this single installment. */
  amount: number;
  /** The bank's description (with its "NN/MM" suffix). */
  description: string;
  categoryId: string | null;
  /** Deleted rows still prove the installment was billed, but never anchor a projection alone. */
  deleted: boolean;
  /** The provider's transaction object (`connection_transactions.raw_payload`). */
  raw: unknown;
}

/** One derived, not-yet-billed installment. */
export interface ProjectedInstallment {
  /** Stable per purchase + installment: `installment:<source id>:<k>`. */
  id: string;
  /** The highest installment seen, the projection's anchor. */
  sourceId: string;
  accountId: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed milliunits (same as the anchor's). */
  amount: number;
  categoryId: string | null;
  stem: string;
  number: number;
  total: number;
  /** "<stem> kk/NN". */
  label: string;
}

interface Seen {
  src: InstallmentSource;
  meta: InstallmentMeta;
  stem: string;
}

/** Anchor preference among rows with the same installment number: posted, live, then the later date. */
const better = (a: Seen, b: Seen): boolean => {
  if (a.meta.number !== b.meta.number) return a.meta.number > b.meta.number;
  if (a.meta.posted !== b.meta.posted) return a.meta.posted;
  if (a.src.deleted !== b.src.deleted) return !a.src.deleted;
  return a.src.date > b.src.date;
};

/**
 * Upcoming installments (n+1..N) of every installment purchase in `sources`,
 * n being the highest installment seen for that purchase. A purchase whose
 * rows are all deleted, or whose last installment was already seen, projects
 * nothing. Ordered by date, then id.
 */
export function projectUpcomingInstallments(sources: readonly InstallmentSource[]): ProjectedInstallment[] {
  const groups = new Map<string, { anchor: Seen; live: boolean }>();
  for (const src of sources) {
    const meta = readInstallmentMeta(src.raw);
    if (!meta) continue;
    const stem = installmentStem(src.description, meta.number, meta.total);
    const key = installmentPurchaseKey(src.accountId, meta.purchaseDate, stem, meta.total);
    const seen: Seen = { src, meta, stem };
    const group = groups.get(key);
    if (!group) groups.set(key, { anchor: seen, live: !src.deleted });
    else {
      if (better(seen, group.anchor)) group.anchor = seen;
      if (!src.deleted) group.live = true;
    }
  }
  const out: ProjectedInstallment[] = [];
  for (const { anchor, live } of groups.values()) {
    if (!live) continue;
    const { src, meta, stem } = anchor;
    for (let k = meta.number + 1; k <= meta.total; k++) {
      out.push({
        id: `installment:${src.id}:${k}`,
        sourceId: src.id,
        accountId: src.accountId,
        date: addMonthsIso(src.date, k - meta.number),
        amount: src.amount,
        categoryId: src.categoryId,
        stem,
        number: k,
        total: meta.total,
        label: installmentLabel(stem, k, meta.total),
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));
}
