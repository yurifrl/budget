/**
 * Flag derivation: one CLI flag per top-level zod input key, typed from the
 * schema's JSON Schema. Complex shapes (arrays, objects, unions) become a
 * `json` flag that takes a JSON literal; `--input` carries whole objects.
 */
import { z } from '@shared/zod';

import { inputLocations, type OperationContract } from '@shared/operation-contract';

export type FlagType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';

export interface FlagSpec {
  /** Input key (snake_case). */
  key: string;
  /** Flag name without dashes (kebab-case). */
  flag: string;
  type: FlagType;
  enumValues?: string[];
  required: boolean;
  description?: string;
  location: 'path' | 'query' | 'body';
  /** Booleans also get a `--no-<flag>` form. */
}

type JsonSchema = Record<string, unknown>;

export const kebab = (key: string): string => key.replace(/_/g, '-');

/** JSON Schema of a contract's input, as the caller must send it. */
export function inputJsonSchema(contract: OperationContract): JsonSchema {
  return z.toJSONSchema(contract.input, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
}

function classify(prop: JsonSchema): { type: FlagType; enumValues?: string[] } {
  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((v) => typeof v === 'string')) {
    return { type: 'enum', enumValues: prop.enum as string[] };
  }
  if (typeof prop.const === 'string') return { type: 'enum', enumValues: [prop.const] };
  const union = (prop.anyOf ?? prop.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(union)) {
    const nonNull = union.filter((s) => s.type !== 'null');
    if (nonNull.length === 1) return classify(nonNull[0]!);
    return { type: 'json' };
  }
  let t = prop.type;
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    t = nonNull.length === 1 ? nonNull[0] : undefined;
  }
  if (t === 'string') return { type: 'string' };
  if (t === 'number') return { type: 'number' };
  if (t === 'integer') return { type: 'integer' };
  if (t === 'boolean') return { type: 'boolean' };
  return { type: 'json' };
}

export function deriveFlags(contract: OperationContract): FlagSpec[] {
  const schema = inputJsonSchema(contract);
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  const loc = inputLocations(contract);
  return Object.entries(props).map(([key, prop]) => ({
    key,
    flag: kebab(key),
    ...classify(prop),
    required: required.has(key),
    description: typeof prop.description === 'string' ? prop.description : undefined,
    location: loc.path.includes(key) ? 'path' : loc.query.includes(key) ? 'query' : 'body',
  }));
}

export class UsageError extends Error {}

// Control characters never belong in a flag value (hallucinated/pasted garbage).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Coerce one raw flag value to the typed input value. */
export function coerceFlag(spec: FlagSpec, raw: string): unknown {
  const name = `--${spec.flag}`;
  switch (spec.type) {
    case 'string':
    case 'enum': {
      if (CONTROL.test(raw)) throw new UsageError(`${name}: value contains control characters`);
      if (spec.location === 'path' && /[/?#%\\]|\.\./.test(raw)) {
        throw new UsageError(`${name}: a path identifier must not contain / ? # % \\ or ..`);
      }
      if (spec.type === 'enum' && !spec.enumValues!.includes(raw)) {
        throw new UsageError(`${name}: must be one of ${spec.enumValues!.join(', ')}`);
      }
      return raw;
    }
    case 'number':
    case 'integer': {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) throw new UsageError(`${name}: expected a number, got "${raw}"`);
      if (spec.type === 'integer' && !Number.isInteger(n))
        throw new UsageError(`${name}: expected an integer, got "${raw}"`);
      return n;
    }
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        throw new UsageError(`${name}: expected a JSON value, got "${raw}"`);
      }
    case 'boolean':
      return raw === 'true';
  }
}

export function flagUsage(spec: FlagSpec): string {
  const value =
    spec.type === 'boolean'
      ? ''
      : spec.type === 'enum'
        ? ` <${spec.enumValues!.join('|')}>`
        : spec.type === 'json'
          ? ' <json>'
          : ` <${spec.type}>`;
  return `--${spec.flag}${value}`;
}
