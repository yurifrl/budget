/**
 * Types of the i18n engine. A catalog is a flat object: dotted key -> message.
 * A message is a string with `{placeholders}` or a `{ one, other }` plural.
 * Everything here is type-level; see `index.ts` for the runtime.
 */

export type Locale = 'en' | 'pt-BR';

/** Plural message: `count` picks the form (see `plural.ts`). */
export interface PluralMessage {
  readonly one: string;
  readonly other: string;
}

export type Message = string | PluralMessage;

/** The shape of an English catalog (`en.ts`). */
export type Catalog = { readonly [key: string]: Message };

/**
 * What a non-English catalog must be: the same keys as the English one, each
 * a string where English has a string and a `{ one, other }` pair where English
 * has a plural. A missing key, an extra key or a shape mismatch is a tsc error.
 */
export type Translation<E extends Catalog> = {
  readonly [K in keyof E]: E[K] extends string ? string : PluralMessage;
};

/** `'a {x} b {y}'` -> `'x' | 'y'`. */
export type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}`
  ? (P extends `${string}${' ' | '\n' | '{'}${string}` ? never : P) | Placeholders<Rest>
  : never;

/** Placeholder names a message takes (a plural also always takes `count`). */
export type ParamNames<M extends Message> = M extends string
  ? Placeholders<M>
  : M extends { readonly one: infer A extends string; readonly other: infer B extends string }
    ? Placeholders<A> | Placeholders<B> | 'count'
    : never;

export type ParamValue = string | number;

/** The params object of a message; `count` is a number for a plural message. */
export type ParamsOf<M extends Message> = {
  readonly [P in ParamNames<M>]: P extends 'count' ? (M extends string ? ParamValue : number) : ParamValue;
};

/** Rest arguments of `t(key, ...args)`: none for a message with no placeholders, else one params object. */
export type ArgsOf<M extends Message> = [ParamNames<M>] extends [never] ? [] : [params: ParamsOf<M>];

/** Keys of `E` whose message takes no params. */
export type ParamlessKey<E extends Catalog> = {
  [K in keyof E & string]: [ParamNames<E[K]>] extends [never] ? K : never;
}[keyof E & string];

/** A translate function, bound to the active locale or to an explicit one. */
export interface TranslateFn<E extends Catalog> {
  <K extends keyof E & string>(key: K, ...args: ArgsOf<E[K]>): string;
}

/** What `defineMessages` returns: `t` itself plus `t.for(locale)`. */
export interface Translator<E extends Catalog> extends TranslateFn<E> {
  /** Translate into an explicit locale (API server: the singleton is wrong across concurrent requests). Never pseudo-wrapped. */
  for(locale: Locale): TranslateFn<E>;
  /** Namespace name, as registered. */
  readonly namespace: string;
  /** The English catalog (source of truth for keys). */
  readonly messages: E;
}

/** Options of `defineMessages`. Keys are checked against the English catalog. */
export interface MessageOptions<E extends Catalog> {
  /** Keys whose pt-BR text is deliberately identical to English (the catalog test flags any other). */
  readonly sameAsEnglish?: readonly (keyof E & string)[];
  /** Key prefixes built dynamically (`t(\`repeat.${k}\`)`): exempt from the catalog test's unused-key check. */
  readonly dynamicPrefixes?: readonly string[];
  /** Exempt every key from the unused-key check (shared `common` and `errors` namespaces). */
  readonly skipUnusedCheck?: boolean;
}

/** One registered namespace, as the catalog test sees it. */
export interface RegisteredNamespace {
  readonly name: string;
  readonly en: Catalog;
  readonly catalogs: Readonly<Record<Locale, Catalog>>;
  readonly sameAsEnglish: ReadonlySet<string>;
  readonly dynamicPrefixes: readonly string[];
  readonly skipUnusedCheck: boolean;
}
