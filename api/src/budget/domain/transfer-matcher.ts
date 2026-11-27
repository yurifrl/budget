/**
 * Transfers between a person's own accounts (pure matcher, budget-mit6).
 *
 * A bank reports money moved between two of the person's accounts as two
 * unrelated rows: an outflow on one account and an equal inflow on the other.
 * The budget engine only treats them as a transfer (no category, no Ready to
 * Assign effect) once the rows reference each other, so imports are paired
 * after the fact. This module decides, from the budget's unlinked rows, which
 * pairs to link on its own, which to offer as suggestions, and which rows of a
 * "treat as transfer" payee wait for their other side.
 *
 * Pairing rules:
 *  - two on-budget accounts of the same budget, exactly equal absolute
 *    amounts, opposite signs, dates at most MAX_TRANSFER_DAYS_APART apart;
 *  - account rules (budget-zkts, see `pairViolation`): a card only receives
 *    (a card outflow is a purchase, a refund or a cash advance, never a
 *    transfer); cash pays a card only of the same bank; checking to checking
 *    only across banks (savings and cash accounts are not judged). The bank
 *    rules apply only when both banks are known (see `sameBank`); a fixed-account payee rule ('account') is the person's own
 *    choice and skips the bank rules. Candidates that break a rule are
 *    dropped before any tie-breaking and are never linked (whatever the
 *    evidence or payee rule); a row left without an allowed partner offers
 *    them as a `refused` suggestion for the person to confirm;
 *  - only uncategorized, unsplit, unlinked rows; a row marked "not a transfer"
 *    or whose payee rule says "never" is never considered;
 *  - resolution, per amount bucket: (1) each side the other's only candidate
 *    ("unique"); (2) bank hints break ties (a row with transfer evidence whose
 *    candidates include exactly one with evidence, "evidence"); (3) repeats:
 *    within a group of rows of one account pair, k outflows and k inflows pair
 *    in date order, then bank time, then id; with k != m, the only alignment
 *    that fits the window is used when there is exactly one ("ordinal");
 *    leftover candidates are a "choose" suggestion;
 *  - a payee rule ('auto' / 'account') makes the row a transfer whatever its
 *    edit state: its remaining candidates are taken closest date first.
 *
 * Auto-link (no person involved) needs both rows untouched (bank text, not
 * edited), no `manual` row among the rows they could pair with (that whole
 * group is only suggested, payee rules included), and: a unique pair, or an ordinal pair with transfer evidence on both
 * sides, or an evidence pair with strong evidence on both sides. A bank
 * category that contradicts a transfer (e.g. "Shopping") on either side vetoes
 * auto-linking, except for cash to card pairs (card payments were always linked
 * on structure alone). Anything else that pairs is a suggestion.
 *
 * Bank hints come from the provider's raw transaction (Pluggy `category` and
 * `operationType`); payee text is never read. The one exception is a stored
 * `hintAccountId` (an import whose payee text was resolved to an account's
 * transfer payee at import time, see `MatchRow`): strong evidence for that account unless the bank's own category contradicts a transfer.
 */

export const MAX_TRANSFER_DAYS_APART = 3;

export type AccountKind = 'cash' | 'card' | 'other';
/** How strongly the bank's own labels say "transfer". */
export type Evidence = 'strong' | 'weak' | 'none' | 'against';
export type TransferMark = 'dismissed' | 'manual';
/**
 * A `transfer_marks.state` as stored. `outside` ("a transfer to an account
 * outside the budget") is no state any more (budget-dt00: "that is just a
 * transaction"); old rows keep it, nothing writes it, and {@link matcherMark}
 * is the one place that reads it.
 */
export type StoredTransferMark = TransferMark | 'outside';
export type TransferRuleMode = 'auto' | 'account' | 'never';
export type MatchBasis = 'unique' | 'ordinal' | 'evidence' | 'rule' | 'ambiguous' | 'unmatched' | 'refused';
export type SuggestionConfidence = 'sure' | 'choose' | 'one_side';
export type PendingTransfer = 'waiting';

/**
 * The mark the matcher acts on. An old `outside` mark is read as `manual`: the
 * row is an ordinary one (never pending, needs a category, offered as a
 * transfer like any row), but because the person once answered about it, it is
 * only suggested and never linked on its own, so nothing in the budget moves
 * without them.
 */
export function matcherMark(stored: StoredTransferMark | null): TransferMark | null {
  return stored === 'outside' ? 'manual' : stored;
}

/** What the bank said about a row (Pluggy raw `category` / `operationType`). */
export interface BankHint {
  category: string | null;
  operationType: string | null;
}

/** One transaction plus the facts the matcher needs. Amount in signed milliunits. */
export interface MatchRow {
  id: string;
  budgetId: string;
  accountId: string;
  accountKind: AccountKind;
  onBudget: boolean;
  amount: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** The bank's own timestamp, when it sent one (orders same-day repeats). */
  bankTime: string | null;
  /** When the row was stored (ISO); a payee rule covers rows created after it was set. */
  createdAt: string | null;
  categoryId: string | null;
  splitCount: number;
  transferAccountId: string | null;
  transferTransactionId: string | null;
  /** Bank-imported and not edited since (payee still the bank text, sync shadow not blocked). */
  untouched: boolean;
  payeeId: string | null;
  hint: BankHint | null;
  mark: TransferMark | null;
  /** The account's bank (`bankKey` of its institution label), when known. */
  bank: string | null;
  /** The account's bank connection, when linked (same connection = same bank). */
  connectionId: string | null;
  /** A checking account (kind 'cash' also covers savings and cash-in-hand; only checking is judged by rule 3). */
  checking: boolean;
  /**
   * The account an import's payee text pointed at (`transfer_hints`: a renaming
   * rule on that account's transfer payee, or the text "Transfer : <account>").
   * The row stays an ordinary uncategorized row, but it counts as strong
   * evidence of a transfer with THAT account: it only pairs with a row of it
   * (the bank rules still apply), and alone it is a one-side suggestion.
   */
  hintAccountId: string | null;
}

/** What the account rules need to know about one side of a transfer. */
export interface TransferSide {
  accountKind: AccountKind;
  bank: string | null;
  connectionId: string | null;
  checking: boolean;
}

/** Why a pair breaks the account rules. */
export type PairViolation = 'card_outflow' | 'card_payment_other_bank' | 'cash_same_bank';

/**
 * Do two accounts belong to the same bank? Null when unknown. Two labels are
 * compared as is. Without two labels, the same connection counts as the same
 * bank, also when only one side carries a label (the unlabelled account is
 * taken to share the connection's bank). Different connections with a missing
 * label are unknown.
 */
export function sameBank(a: Pick<TransferSide, 'bank' | 'connectionId'>, b: Pick<TransferSide, 'bank' | 'connectionId'>): boolean | null {
  if (a.bank && b.bank) return a.bank === b.bank;
  if (a.connectionId && a.connectionId === b.connectionId) return true;
  return null;
}

/**
 * The account rule an outflow -> inflow pair breaks, if any: a card is never
 * the outflow side; cash -> card only within one bank; checking -> checking
 * only across banks (savings and cash-in-hand accounts are not judged: a move
 * between a checking and a savings account of one bank is an ordinary
 * transfer). Unknown banks pass the bank rules. Other kinds are not judged.
 */
export function pairViolation(o: TransferSide, i: TransferSide): PairViolation | null {
  if (o.accountKind === 'card') return 'card_outflow';
  if (o.accountKind !== 'cash') return null;
  const same = sameBank(o, i);
  if (i.accountKind === 'card' && same === false) return 'card_payment_other_bank';
  if (i.accountKind === 'cash' && o.checking && i.checking && same === true) return 'cash_same_bank';
  return null;
}

/** A payee's "treat as transfer" rule. */
export interface TransferRule {
  mode: TransferRuleMode;
  /** The fixed other account ('account' only). */
  accountId: string | null;
  /**
   * No matching row after `waitDays`: `review` offers the row as one side of a
   * transfer; `outside` (the stored name of the old "keep as a transfer outside
   * the budget" policy) now leaves an ordinary row that needs a category.
   */
  noMatch: 'outside' | 'review';
  waitDays: number;
  /** Rows created at or after this instant (ISO) are covered; null = every row. */
  since: string | null;
}

export interface PlannedLink {
  outflowId: string;
  inflowId: string;
  method: 'auto' | 'rule';
  basis: MatchBasis;
}

export interface Suggestion {
  /** The row the suggestion is about: the outflow of a pair, or the lone row. */
  id: string;
  confidence: SuggestionConfidence;
  basis: MatchBasis;
  /** Proposed other side(s), closest date first; empty for one-side rows. */
  candidateIds: string[];
  /** `refused` suggestions only: the account rule each candidate breaks (never auto-linked). */
  violations?: Record<string, PairViolation>;
}

/** Per-row summary the register shows (both sides of a pair carry one). */
export interface RowSuggestion {
  confidence: SuggestionConfidence;
  candidateCount: number;
  /** The single proposed other side, when there is exactly one. */
  counterpartId: string | null;
}

export interface TransferPlan {
  links: PlannedLink[];
  suggestions: Suggestion[];
  pending: Map<string, PendingTransfer>;
  rows: Map<string, RowSuggestion>;
}

const DAY_MS = 86_400_000;
export const daysApart = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / DAY_MS);

const STRONG_CATEGORY = /same person transfer|credit card payment/i;
const WEAK_CATEGORY = /transfer/i;
const STRONG_OPERATIONS = new Set(['PAGAMENTO_FATURA']);
const WEAK_OPERATIONS = new Set(['PIX', 'TED', 'DOC', 'TEF', 'TRANSFERENCIA']);

/** Classify a row's bank labels. A non-transfer category ("Shopping") is evidence against. */
export function evidenceOf(hint: BankHint | null): Evidence {
  if (!hint) return 'none';
  const category = hint.category?.trim() ?? '';
  const operation = hint.operationType?.trim().toUpperCase() ?? '';
  if (STRONG_CATEGORY.test(category) || STRONG_OPERATIONS.has(operation)) return 'strong';
  if (WEAK_CATEGORY.test(category)) return 'weak';
  if (category) return 'against';
  return WEAK_OPERATIONS.has(operation) ? 'weak' : 'none';
}

/** The label to show for a row's evidence (the bank category, else the operation type). */
export function evidenceLabel(hint: BankHint | null): string | null {
  return hint?.category?.trim() || hint?.operationType?.trim() || null;
}

const rank = (e: Evidence): number => (e === 'strong' ? 2 : e === 'weak' ? 1 : e === 'none' ? 0 : -1);

interface Node {
  row: MatchRow;
  evidence: Evidence;
  rule: TransferRule | null;
}

/**
 * The row's evidence. An import hint (the payee text named an account) counts as
 * strong evidence, but never overrides the bank's own contradicting category
 * ('against' stays a veto) and never touches the account or bank rules: it only
 * narrows the candidates to the hinted account (`structurallyFits`).
 */
function evidenceWithHint(row: MatchRow): Evidence {
  const own = evidenceOf(row.hint);
  return row.hintAccountId && own !== 'against' ? 'strong' : own;
}

/** The rule covering a row (an active 'auto'/'account' rule set before the row was created). */
function coveringRule(row: MatchRow, rules: ReadonlyMap<string, TransferRule>): TransferRule | null {
  const rule = row.payeeId ? rules.get(row.payeeId) : undefined;
  if (!rule || rule.mode === 'never') return null;
  if (rule.since && row.createdAt && row.createdAt < rule.since) return null;
  return rule;
}

const considered = (row: MatchRow, rules: ReadonlyMap<string, TransferRule>): boolean =>
  row.onBudget &&
  row.accountKind !== 'other' &&
  row.amount !== 0 &&
  row.categoryId == null &&
  row.splitCount === 0 &&
  row.transferAccountId == null &&
  row.transferTransactionId == null &&
  row.mark !== 'dismissed' &&
  !(row.payeeId && rules.get(row.payeeId)?.mode === 'never');

/** Do `o` (outflow) and `i` (inflow) look like the two legs of one transfer, account rules aside? */
function structurallyFits(o: Node, i: Node): boolean {
  if (o.row.budgetId !== i.row.budgetId || o.row.accountId === i.row.accountId) return false;
  if (-o.row.amount !== i.row.amount) return false;
  if (daysApart(o.row.date, i.row.date) > MAX_TRANSFER_DAYS_APART) return false;
  // The pairs main matched: cash > cash, cash > card, card > card. A card outflow against a cash
  // inflow (refund, cash advance) was never a transfer candidate and stays none, refused or not.
  const kinds = `${o.row.accountKind}>${i.row.accountKind}`;
  if (kinds !== 'cash>cash' && kinds !== 'cash>card' && kinds !== 'card>card') return false;
  if (o.rule?.mode === 'account' && o.rule.accountId !== i.row.accountId) return false;
  if (i.rule?.mode === 'account' && i.rule.accountId !== o.row.accountId) return false;
  if (o.row.hintAccountId && o.row.hintAccountId !== i.row.accountId) return false;
  if (i.row.hintAccountId && i.row.hintAccountId !== o.row.accountId) return false;
  return true;
}

/** Can `o` (outflow) and `i` (inflow) be the two legs of one transfer the matcher may link? */
function fits(o: Node, i: Node): boolean {
  if (!structurallyFits(o, i) || o.row.accountKind !== 'cash') return false;
  const chosen = o.rule?.mode === 'account' || i.rule?.mode === 'account';
  return chosen || pairViolation(o.row, i.row) == null;
}

/** A card row that leaves money: a purchase, never a leg of a transfer (rule 1). */
const cardOutflow = (row: MatchRow): boolean => row.accountKind === 'card' && row.amount < 0;

const order = (a: Node, b: Node): number =>
  a.row.date.localeCompare(b.row.date) ||
  (a.row.bankTime ?? '').localeCompare(b.row.bankTime ?? '') ||
  a.row.id.localeCompare(b.row.id);

interface BucketResult {
  pairs: { o: Node; i: Node; basis: MatchBasis }[];
  /** Unpaired rows that still have candidates, with them. */
  open: Map<string, Set<string>>;
  /**
   * Rows of a candidate group (connected component of the pairs that fit) that
   * contains a `manual` row: whatever pairs there is only suggested.
   */
  held: Set<string>;
}

/**
 * Pairs the account rules refuse (budget-zkts) are never linked, whatever the
 * evidence or the payee rule, but they are still offered. Among the rows of one
 * amount bucket that end up unlinked, an outflow and an inflow that main would
 * have paired (card > card, cash > card at another bank, checking > checking
 * at one bank) but a rule refuses are a refused candidate of each other. Every
 * such row carries a suggestion listing it, which never changes what is linked:
 *  - an outflow without a suggestion gets a `refused` one (`sure` when the
 *    pair is mutual and neither row has any other candidate, else `choose`);
 *  - an outflow that already has a suggestion (a choose group, or a pair left
 *    for the person) gets the refused candidates added, closest date first,
 *    and becomes `choose`; its basis stays.
 * `violations` names the rule each refused candidate breaks. Rows involved are
 * not also one-side or waiting rule rows. Returns their ids.
 */
function addRefusedSuggestions(bucket: readonly Node[], linked: ReadonlySet<string>, own: Suggestion[]): Set<string> {
  const outs = bucket.filter((n) => n.row.amount < 0 && !linked.has(n.row.id));
  const ins = bucket.filter((n) => n.row.amount > 0 && !linked.has(n.row.id));
  const byOut = new Map<string, { node: Node; violation: PairViolation }[]>();
  const insDegree = new Map<string, number>();
  for (const o of outs) {
    for (const i of ins) {
      if (!structurallyFits(o, i)) continue;
      const violation = pairViolation(o.row, i.row);
      if (!violation) continue;
      byOut.set(o.row.id, [...(byOut.get(o.row.id) ?? []), { node: i, violation }]);
      insDegree.set(i.row.id, (insDegree.get(i.row.id) ?? 0) + 1);
    }
  }
  const ownById = new Map(own.map((sug) => [sug.id, sug]));
  const offered = new Set(own.flatMap((sug) => sug.candidateIds));
  const nodes = new Map(bucket.map((n) => [n.row.id, n]));
  const covered = new Set<string>();
  for (const o of outs) {
    const list = byOut.get(o.row.id);
    if (!list) continue;
    const violations = Object.fromEntries(list.map((c) => [c.node.row.id, c.violation]));
    const existing = ownById.get(o.row.id);
    if (existing) {
      existing.candidateIds = [...existing.candidateIds, ...list.map((c) => c.node.row.id)]
        .map((id) => nodes.get(id)!)
        .sort((a, b) => daysApart(a.row.date, o.row.date) - daysApart(b.row.date, o.row.date) || order(a, b))
        .map((n) => n.row.id);
      existing.confidence = 'choose';
      existing.violations = { ...existing.violations, ...violations };
    } else {
      list.sort((a, b) => daysApart(a.node.row.date, o.row.date) - daysApart(b.node.row.date, o.row.date) || order(a.node, b.node));
      const only = list.length === 1 && insDegree.get(list[0].node.row.id) === 1 && !offered.has(list[0].node.row.id);
      own.push({
        id: o.row.id,
        confidence: only ? 'sure' : 'choose',
        basis: 'refused',
        candidateIds: list.map((c) => c.node.row.id),
        violations,
      });
    }
    covered.add(o.row.id);
    for (const c of list) covered.add(c.node.row.id);
  }
  return covered;
}

/** Resolve one amount bucket (all rows share the absolute amount). */
function resolveBucket(outs: Node[], ins: Node[]): BucketResult {
  const byId = new Map<string, Node>([...outs, ...ins].map((n) => [n.row.id, n]));
  const cand = new Map<string, Set<string>>();
  for (const n of byId.values()) cand.set(n.row.id, new Set());
  for (const o of outs) {
    for (const i of ins) {
      if (!fits(o, i)) continue;
      cand.get(o.row.id)!.add(i.row.id);
      cand.get(i.row.id)!.add(o.row.id);
    }
  }
  const initialDegree = new Map([...cand].map(([id, s]) => [id, s.size]));
  // A row the person once answered about (`manual`, also an old `outside` mark) is
  // never linked on its own, and neither is anything it could pair with: its mere
  // presence changes how the others resolve (e.g. it makes an ordinal order fit).
  const held = new Set<string>();
  for (const component of components(cand, new Set())) {
    if (component.some((id) => byId.get(id)!.row.mark === 'manual')) for (const id of component) held.add(id);
  }
  const evidenceEdges = new Set<string>();
  const pairs: BucketResult['pairs'] = [];
  const paired = new Set<string>();

  const detach = (id: string) => {
    for (const other of cand.get(id)!) cand.get(other)!.delete(id);
    cand.get(id)!.clear();
  };
  const pair = (oId: string, iId: string, basis: MatchBasis) => {
    pairs.push({ o: byId.get(oId)!, i: byId.get(iId)!, basis });
    paired.add(oId);
    paired.add(iId);
    detach(oId);
    detach(iId);
  };
  const peel = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const o of outs) {
        const s = cand.get(o.row.id)!;
        if (paired.has(o.row.id) || s.size !== 1) continue;
        const [iId] = s;
        if (cand.get(iId)!.size !== 1) continue;
        const basis = evidenceEdges.has(`${o.row.id}|${iId}`)
          ? 'evidence'
          : initialDegree.get(o.row.id) === 1 && initialDegree.get(iId) === 1
            ? 'unique'
            : 'ordinal';
        pair(o.row.id, iId, basis);
        changed = true;
      }
    }
  };

  // (1) unique pairs.
  peel();

  // (2) bank evidence breaks ties.
  for (const n of byId.values()) {
    const s = cand.get(n.row.id)!;
    if (paired.has(n.row.id) || s.size < 2 || rank(n.evidence) < 1) continue;
    const withEvidence = [...s].filter((c) => rank(byId.get(c)!.evidence) >= 1);
    if (withEvidence.length !== 1) continue;
    const keep = withEvidence[0];
    for (const c of [...s]) {
      if (c === keep) continue;
      s.delete(c);
      cand.get(c)!.delete(n.row.id);
    }
    const isOut = n.row.amount < 0;
    evidenceEdges.add(isOut ? `${n.row.id}|${keep}` : `${keep}|${n.row.id}`);
  }
  peel();

  // (3) ordinal pairing of repeats inside one account pair.
  for (const component of components(cand, paired)) {
    const cOuts = component.filter((id) => byId.get(id)!.row.amount < 0).map((id) => byId.get(id)!).sort(order);
    const cIns = component.filter((id) => byId.get(id)!.row.amount > 0).map((id) => byId.get(id)!).sort(order);
    if (cOuts.length === 0 || cIns.length === 0) continue;
    if (new Set(cOuts.map((n) => n.row.accountId)).size !== 1) continue;
    if (new Set(cIns.map((n) => n.row.accountId)).size !== 1) continue;
    const [short, long] = cOuts.length <= cIns.length ? [cOuts, cIns] : [cIns, cOuts];
    const fitsAt = (offset: number) =>
      short.every((s, j) => cand.get(s.row.id)!.has(long[j + offset].row.id));
    const offsets: number[] = [];
    for (let off = 0; off + short.length <= long.length; off++) if (fitsAt(off)) offsets.push(off);
    if (offsets.length !== 1) continue;
    short.forEach((s, j) => {
      const l = long[j + offsets[0]];
      const [o, i] = s.row.amount < 0 ? [s, l] : [l, s];
      pair(o.row.id, i.row.id, 'ordinal');
    });
  }
  peel();

  // (4) a payee rule takes the closest remaining candidate.
  const ruled = [...byId.values()].filter((n) => n.rule && !paired.has(n.row.id)).sort(order);
  for (const n of ruled) {
    const s = cand.get(n.row.id)!;
    if (paired.has(n.row.id) || s.size === 0) continue;
    const best = [...s]
      .map((id) => byId.get(id)!)
      .sort((a, b) => daysApart(a.row.date, n.row.date) - daysApart(b.row.date, n.row.date) || order(a, b))[0];
    const [o, i] = n.row.amount < 0 ? [n, best] : [best, n];
    pair(o.row.id, i.row.id, 'rule');
  }

  const open = new Map<string, Set<string>>();
  for (const [id, s] of cand) if (!paired.has(id) && s.size > 0) open.set(id, s);
  return { pairs, open, held };
}

/** Connected components of the unpaired candidate graph (ids). */
function components(cand: Map<string, Set<string>>, paired: Set<string>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const [start, s] of cand) {
    if (seen.has(start) || paired.has(start) || s.size === 0) continue;
    const stack = [start];
    const comp: string[] = [];
    seen.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const next of cand.get(id)!) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

function autoLinkable(o: Node, i: Node, basis: MatchBasis): boolean {
  if (!o.row.untouched || !i.row.untouched) return false;
  const cashToCard = o.row.accountKind === 'cash' && i.row.accountKind === 'card';
  if (!cashToCard && (o.evidence === 'against' || i.evidence === 'against')) return false;
  if (basis === 'unique') return true;
  if (basis === 'ordinal') return rank(o.evidence) >= 1 && rank(i.evidence) >= 1;
  if (basis === 'evidence') return o.evidence === 'strong' && i.evidence === 'strong';
  return false;
}

/**
 * Plan the budget's transfers. `rows` are the budget's candidate rows (rows
 * that cannot pair are ignored); `rules` maps payee id to its transfer rule;
 * `today` (YYYY-MM-DD) ages rule rows still waiting for their other side.
 */
export function planTransfers(
  rows: readonly MatchRow[],
  rules: ReadonlyMap<string, TransferRule>,
  today: string,
): TransferPlan {
  const plan: TransferPlan = { links: [], suggestions: [], pending: new Map(), rows: new Map() };
  const nodes: Node[] = rows
    .filter((r) => considered(r, rules))
    .map((row) => ({ row, evidence: evidenceWithHint(row), rule: coveringRule(row, rules) }));
  const buckets = new Map<number, Node[]>();
  for (const n of nodes) {
    const k = Math.abs(n.row.amount);
    const bucket = buckets.get(k);
    if (bucket) bucket.push(n);
    else buckets.set(k, [n]);
  }

  const lone: Node[] = [];
  for (const bucket of buckets.values()) {
    const outs = bucket.filter((n) => n.row.amount < 0);
    const ins = bucket.filter((n) => n.row.amount > 0);
    const { pairs, open, held } = resolveBucket(outs, ins);
    const pairedIds = new Set<string>();
    const linkedIds = new Set<string>();
    const first = plan.suggestions.length;
    for (const { o, i, basis } of pairs) {
      pairedIds.add(o.row.id);
      pairedIds.add(i.row.id);
      // Both rows of a pair share a component, so one check covers both sides.
      const manual = held.has(o.row.id);
      if (!manual && (o.rule || i.rule)) {
        plan.links.push({ outflowId: o.row.id, inflowId: i.row.id, method: 'rule', basis });
        linkedIds.add(o.row.id).add(i.row.id);
      } else if (!manual && autoLinkable(o, i, basis)) {
        plan.links.push({ outflowId: o.row.id, inflowId: i.row.id, method: 'auto', basis });
        linkedIds.add(o.row.id).add(i.row.id);
      } else {
        plan.suggestions.push({ id: o.row.id, confidence: 'sure', basis, candidateIds: [i.row.id] });
      }
    }
    const byId = new Map(bucket.map((n) => [n.row.id, n]));
    for (const o of outs) {
      const s = open.get(o.row.id);
      if (!s) continue;
      const candidateIds = [...s]
        .map((id) => byId.get(id)!)
        .sort((a, b) => daysApart(a.row.date, o.row.date) - daysApart(b.row.date, o.row.date) || order(a, b))
        .map((n) => n.row.id);
      plan.suggestions.push({ id: o.row.id, confidence: 'choose', basis: 'ambiguous', candidateIds });
    }
    const own = plan.suggestions.splice(first);
    const covered = addRefusedSuggestions(bucket, linkedIds, own);
    plan.suggestions.push(...own);
    for (const n of bucket) if (!pairedIds.has(n.row.id) && !open.has(n.row.id) && !covered.has(n.row.id)) lone.push(n);
  }

  for (const n of lone) {
    if (n.rule) {
      const age = n.row.date > today ? 0 : daysApart(n.row.date, today);
      if (age <= n.rule.waitDays) plan.pending.set(n.row.id, 'waiting');
      // Past the wait, the old `outside` policy leaves just a transaction (no state, no suggestion).
      else if (n.rule.noMatch === 'outside') continue;
      else if (!cardOutflow(n.row)) plan.suggestions.push({ id: n.row.id, confidence: 'one_side', basis: 'unmatched', candidateIds: [] });
      // A card outflow with a rule can never pair (rule 1), so it is never offered as one side either.
    } else if (n.evidence === 'strong' && !cardOutflow(n.row)) {
      // A lone card outflow is never one side of a transfer (cards only receive).
      plan.suggestions.push({ id: n.row.id, confidence: 'one_side', basis: 'unmatched', candidateIds: [] });
    }
  }

  plan.rows = summarizeRows(plan.suggestions);
  return plan;
}

/** Per-row summaries: both legs of a sure pair, every row of a choose group, the lone row. */
export function summarizeRows(suggestions: readonly Suggestion[]): Map<string, RowSuggestion> {
  const rows = new Map<string, RowSuggestion>();
  const inflowCandidates = new Map<string, Set<string>>();
  for (const s of suggestions) {
    rows.set(s.id, {
      confidence: s.confidence,
      candidateCount: s.candidateIds.length,
      counterpartId: s.candidateIds.length === 1 ? s.candidateIds[0] : null,
    });
    for (const c of s.candidateIds) {
      const set = inflowCandidates.get(c) ?? new Set<string>();
      set.add(s.id);
      inflowCandidates.set(c, set);
    }
  }
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  for (const [id, anchors] of inflowCandidates) {
    if (rows.has(id)) continue;
    const [first] = anchors;
    const confidence = anchors.size === 1 ? byId.get(first)!.confidence : 'choose';
    rows.set(id, { confidence, candidateCount: anchors.size, counterpartId: anchors.size === 1 ? first : null });
  }
  return rows;
}

/**
 * The plan as the register sees it before the next sync links anything: the
 * links the matcher would make are shown as sure suggestions.
 */
export function readView(plan: TransferPlan): TransferPlan {
  const suggestions: Suggestion[] = [
    ...plan.links.map((l) => ({ id: l.outflowId, confidence: 'sure' as const, basis: l.basis, candidateIds: [l.inflowId] })),
    ...plan.suggestions,
  ];
  return { links: [], suggestions, pending: plan.pending, rows: summarizeRows(suggestions) };
}
