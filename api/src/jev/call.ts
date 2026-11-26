/**
 * The one Jev call. Jev (`typesafe/jev-1.13`, reached through OpenRouter) is a
 * decision model: no messages and no text, one `state` plus one `choice`
 * question whose options are the budget's category ids. The answer carries a
 * probability per option; the top three become suggestions.
 *
 * Anything that is not a usable answer — a refusal, another answer type, a
 * shape we do not recognise, a non-2xx, a timeout — is a failure with a named
 * kind. It never becomes a guess. The kinds are what the run acts on: some are
 * one transaction's answer, some say Jev is unavailable, some stop the run.
 */
import { z } from '@shared/zod';

export const JEV_MODEL = 'typesafe/jev-1.13';
/**
 * The shape of a model id worth storing: the id is written to a column and
 * shown as-is, so letters, digits and `. / _ - :` up to 100 characters, and
 * anything else falls back to the model we asked for.
 */
const MODEL_ID = /^[\w./:-]{1,100}$/;
const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const TIMEOUT_MS = 15_000;
/** How many options one choice question may carry (measured: 200 accepted, 400 is a 422). */
export const JEV_MAX_OPTIONS = 255;
/** Suggestions kept per transaction: the three most probable options. */
export const JEV_TOP = 3;

export type CategorizeFailureKind =
  | 'refusal'
  | 'answer_type'
  | 'schema_mismatch'
  | 'rejected_key'
  | 'no_credits'
  | 'rate_limited'
  | 'server'
  | 'http'
  | 'timeout'
  | 'network';

/**
 * Kinds that are one transaction's answer: the run records the attempt, counts
 * it toward that row's cap and moves on. A refusal, another answer type, an
 * unparsable answer and a 4xx about the request itself would not be fixed by
 * asking again, so the row is answered as far as Jev can.
 */
export const ROW_FAILURE_KINDS: readonly CategorizeFailureKind[] = [
  'refusal',
  'answer_type',
  'schema_mismatch',
  'http',
];

/**
 * Kinds that say Jev was unavailable rather than that the row was judged: a
 * rate limit, an outage, a timeout, a network error. The run records the
 * attempt (so the row's history is honest) but does NOT spend the row's cap on
 * it, and stops after a few in a row. A refused key and a credit problem stop
 * the run on the first one and are not recorded against any row.
 */
export const TRANSIENT_FAILURE_KINDS: readonly CategorizeFailureKind[] = [
  'rate_limited',
  'server',
  'timeout',
  'network',
];

/** Whether a failure is about this transaction's answer (the row's cap grows). */
export function isRowFailure(kind: CategorizeFailureKind): boolean {
  return ROW_FAILURE_KINDS.includes(kind);
}

/** Whether the failure says Jev was unavailable (recorded, but no cap spent). */
export function isTransientFailure(kind: CategorizeFailureKind): boolean {
  return TRANSIENT_FAILURE_KINDS.includes(kind);
}

export class JevFailure extends Error {
  constructor(
    readonly kind: CategorizeFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'JevFailure';
  }
}

/** A key can never travel back out in an error message, a log or a job record. */
export function redactKey(text: string, key: string): string {
  return key.length < 8 ? text : text.split(key).join('[key]');
}

export type JevFacts = {
  /** The payee row's name, or the bank's payee text. */
  payee: string | null;
  /** The bank's own description of the row. */
  bankText: string | null;
  /** The row's memo, when the person wrote one. */
  memo: string | null;
  /** Signed integer milliunits; an outflow is negative. */
  amount: number;
  /** YYYY-MM-DD. */
  date: string;
  account: string;
  /** `Group / Category` labels this payee was categorized as before, newest first. */
  payeeHistory: string[];
};

export type JevOption = { id: string; label: string };
export type JevSuggestion = { categoryId: string; confidence: number };
/** What one call answered: the categories it prefers (most probable first, top three) and the model that answered. */
export type JevAnswer = { suggestions: JevSuggestion[]; model: string };

export type JevCall = {
  key: string;
  facts: JevFacts;
  options: readonly JevOption[];
  /** Test seam: the real `fetch` by default. */
  fetchImpl?: typeof fetch;
};

const answerSchema = z
  .object({
    answers: z.record(
      z.string(),
      z.object({ type: z.string() }).passthrough(),
    ),
  })
  .passthrough();

const probabilitiesOf = (answer: Record<string, unknown>): Record<string, number> | null => {
  const parsed = z.record(z.string(), z.number()).safeParse(answer.probabilities);
  return parsed.success ? parsed.data : null;
};

/** What an HTTP status means for the run (401/402 stop it, 429/5xx are transient). */
function kindOfStatus(status: number): CategorizeFailureKind {
  if (status === 401 || status === 403) return 'rejected_key';
  if (status === 402) return 'no_credits';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server' : 'http';
}

/** One call. */
export async function classifyTransaction(call: JevCall): Promise<JevAnswer> {
  if (call.options.length === 0) throw new JevFailure('schema_mismatch', 'jev was given no category options');
  const body = {
    model: JEV_MODEL,
    state: {
      payee: call.facts.payee ?? '',
      bank_text: call.facts.bankText ?? '',
      memo: call.facts.memo ?? '',
      amount: call.facts.amount / 1000,
      date: call.facts.date,
      account: call.facts.account,
      same_payee_categorized_before_as: call.facts.payeeHistory,
    },
    questions: {
      category: {
        type: 'choice',
        instructions: 'Which budget category does this bank transaction belong to?',
        criteria: Object.fromEntries(call.options.map((option) => [option.id, option.label])),
      },
    },
  };
  const offered = new Set(call.options.map((option) => option.id));

  const doFetch = call.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${call.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    const message = redactKey(err instanceof Error ? err.message : String(err), call.key);
    throw new JevFailure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', message);
  }

  const text = redactKey(await response.text().catch(() => ''), call.key);
  if (!response.ok) {
    throw new JevFailure(kindOfStatus(response.status), `jev answered ${response.status}: ${text.slice(0, 300)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JevFailure('schema_mismatch', `jev did not answer json: ${text.slice(0, 300)}`);
  }
  const envelope = answerSchema.safeParse(json);
  if (!envelope.success) throw new JevFailure('schema_mismatch', `unexpected jev answer: ${text.slice(0, 300)}`);

  const answer = envelope.data.answers.category;
  if (!answer) throw new JevFailure('schema_mismatch', 'jev did not answer the category question');
  if (answer.type === 'refusal') throw new JevFailure('refusal', 'jev declined to answer the category question');
  if (answer.type !== 'choice') throw new JevFailure('answer_type', `unexpected jev answer type ${answer.type}`);

  const probabilities = probabilitiesOf(answer);
  if (!probabilities) throw new JevFailure('schema_mismatch', 'jev answered choice without probabilities');

  const suggestions = Object.entries(probabilities)
    .filter(([id, probability]) => offered.has(id) && probability > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, JEV_TOP)
    .map(([categoryId, confidence]) => ({ categoryId, confidence: Math.min(1, Math.max(0, confidence)) }));
  // The model that actually answered (`typesafe/jev-1.13-20260917`), which a
  // later answer may differ from; falls back to the one we asked for.
  const answered = envelope.data.model;
  const model = typeof answered === 'string' && MODEL_ID.test(answered) ? answered : JEV_MODEL;
  return { suggestions, model };
}

/**
 * The installation's shared Jev key. The entrypoints hand it over
 * (`configureJevEnv(process.env)`); handlers and activities read it from here
 * so the feature never touches `process.env` itself.
 */
let serverKey: string | null = null;

export function configureJevEnv(env: Record<string, string | undefined>): void {
  const key = (env.JEV_API_KEY ?? '').trim();
  serverKey = key.length > 0 ? key : null;
}

/** The installation's key, or null when `JEV_API_KEY` is unset. */
export function sharedJevKey(): string | null {
  return serverKey;
}

/**
 * One call with made-up data, to learn whether Jev accepts a key before it is
 * stored (and when the person asks to test the saved one). Throws the same
 * JevFailure kinds as a real call; the answer itself is discarded.
 */
export async function probeJevKey(key: string, fetchImpl?: typeof fetch): Promise<void> {
  await classifyTransaction({
    key,
    facts: {
      payee: 'Padaria Exemplo',
      bankText: 'CARTAO PADARIA EXEMPLO',
      amount: -1550,
      date: '2026-01-15',
      memo: null,
      account: 'Conta Corrente',
      payeeHistory: ['Food / Groceries'],
    },
    options: [
      { id: 'probe-food', label: 'Food / Groceries' },
      { id: 'probe-home', label: 'Home / Rent' },
    ],
    fetchImpl,
  });
}
