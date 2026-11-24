/**
 * The read-only tools the categorizer offers the model. Every tool is built
 * with one budget id baked in and reads through ./store, whose SQL puts that
 * id in the WHERE clause: a transaction, payee or category of another budget is
 * never returned, whatever id the model asks for.
 *
 * Arguments come from the model: they are untrusted and validated per tool,
 * and ids must be uuids before they reach a uuid column. EVERY failure — bad
 * argument, not found, database error — becomes a JSON `{ error }` the model
 * can react to; nothing throws out of `execute` into the conversation loop.
 */
import { z } from '@shared/zod';

import type { AiTool, AiToolCall } from '../ai';
import type { Queryable } from '../core/db';
import * as store from './store';

export const LIST_CATEGORIES = 'list_categories';
export const GET_TRANSACTION = 'get_transaction';
export const PAYEE_HISTORY = 'payee_history';
export const SEARCH_SIMILAR_TRANSACTIONS = 'search_similar_transactions';

/**
 * Hard size of one tool result the model may receive. Store functions cap every
 * untrusted string; this is the backstop that keeps a whole result (many
 * categories, many matches) from blowing the input side of the token budget.
 * list_categories drops its notes before giving up.
 */
export const MAX_TOOL_RESULT_CHARS = 40_000;

const bounded = (json: string): string =>
  json.length <= MAX_TOOL_RESULT_CHARS
    ? json
    : JSON.stringify({ error: 'tool result too large; answer with what you have' });

export const TOOL_DEFINITIONS: readonly AiTool[] = [
  {
    name: LIST_CATEGORIES,
    description:
      'List the budget categories you may choose from: live, visible groups and categories with their ids and notes. Call this before suggesting anything; only these ids are accepted.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: GET_TRANSACTION,
    description:
      'Read one transaction of this budget: date, signed amount in milliunits, account, payee, memo, current category and the bank-supplied facts. Ids from another budget are not found.',
    parameters: {
      type: 'object',
      properties: { transaction_id: { type: 'string', description: 'The transaction id (a uuid) as given in the task or by search_similar_transactions.' } },
      required: ['transaction_id'],
      additionalProperties: false,
    },
  },
  {
    name: PAYEE_HISTORY,
    description:
      'How this payee was categorized before, in this budget: categories, transaction counts and the most recent date. Use it when the payee id is known.',
    parameters: {
      type: 'object',
      properties: { payee_id: { type: 'string', description: 'The payee id (a uuid); omit when the transaction has none.' } },
      required: ['payee_id'],
      additionalProperties: false,
    },
  },
  {
    name: SEARCH_SIMILAR_TRANSACTIONS,
    description:
      'Find already-categorized transactions of this budget whose payee, imported description or memo contain words of the query (for example a merchant name). Returns their category, newest first.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Words to look for, e.g. "uber trip".' },
        limit: { type: 'integer', description: '1 to 10 results (default 8).' },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
];

const uuid = z.string().uuid();
const getTransactionArgs = z.object({ transaction_id: uuid });
const payeeHistoryArgs = z.object({ payee_id: uuid });
const searchArgs = z.object({
  description: z.string().trim().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(10).optional(),
});

/**
 * Query words for the store: NFD-folded, lowercased, alphanumerics only, 3+
 * chars, deduped, at most 8. Guarantees no LIKE wildcard can arrive from the
 * model and keeps the `%word%` match honest.
 */
export function searchTokens(description: string): string[] {
  const words = description
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3)
    .map((word) => word.slice(0, 40));
  return [...new Set(words)].slice(0, 8);
}

export type CategorizeTools = {
  definitions: readonly AiTool[];
  /** Run one tool call; always answers a JSON string for the model. */
  execute(call: AiToolCall): Promise<string>;
};

export function createTools(db: Queryable, budgetId: string): CategorizeTools {
  const execute = async (call: AiToolCall): Promise<string> => {
    switch (call.name) {
      case LIST_CATEGORIES: {
        const categories = await store.listCategoryChoices(db, budgetId);
        // Notes are the optional, largest part of the answer: drop them rather
        // than the ids when a big budget would exceed the result cap.
        const serialize = (includeNotes: boolean) => {
          const groups = new Map<string, { group_id: string; group_name: string; categories: { category_id: string; name: string; note?: string | null }[] }>();
          for (const category of categories) {
            const group = groups.get(category.group_id) ?? { group_id: category.group_id, group_name: category.group_name, categories: [] };
            group.categories.push(
              includeNotes
                ? { category_id: category.id, name: category.name, note: category.note }
                : { category_id: category.id, name: category.name },
            );
            groups.set(category.group_id, group);
          }
          return JSON.stringify({ groups: [...groups.values()] });
        };
        const withNotes = serialize(true);
        return bounded(withNotes.length <= MAX_TOOL_RESULT_CHARS ? withNotes : serialize(false));
      }
      case GET_TRANSACTION: {
        const args = getTransactionArgs.parse(call.arguments);
        const transaction = await store.getAgentTransaction(db, budgetId, args.transaction_id);
        return bounded(JSON.stringify(transaction ?? { found: false }));
      }
      case PAYEE_HISTORY: {
        const args = payeeHistoryArgs.parse(call.arguments);
        const history = await store.payeeHistory(db, budgetId, args.payee_id);
        return bounded(JSON.stringify({ history, total: history.reduce((sum, row) => sum + row.transactions, 0) }));
      }
      case SEARCH_SIMILAR_TRANSACTIONS: {
        const args = searchArgs.parse(call.arguments);
        const transactions = await store.searchSimilar(db, budgetId, searchTokens(args.description), args.limit ?? 8);
        return bounded(JSON.stringify({ transactions }));
      }
      default:
        return JSON.stringify({ error: `unknown tool ${call.name}` });
    }
  };

  return {
    definitions: TOOL_DEFINITIONS,
    async execute(call) {
      try {
        return await execute(call);
      } catch (error) {
        // A tool never throws into the agent loop: the model sees the failure
        // and can correct itself, and one bad guess cannot fail a paid chunk.
        if (error instanceof z.ZodError) return JSON.stringify({ error: 'invalid arguments', issues: error.issues.map((i) => i.message) });
        return JSON.stringify({ error: 'tool lookup failed' });
      }
    },
  };
}
