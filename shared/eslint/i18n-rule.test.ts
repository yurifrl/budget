import { describe, expect, it } from 'bun:test';
import { Linter, RuleTester } from 'eslint';
import { createRequire } from 'node:module';
import tseslint from 'typescript-eslint';

const require = createRequire(import.meta.url);

// CommonJS plugin shared with the client and admin ESLint configs.
const plugin = require('./i18n-rule.cjs') as { rules: Record<string, unknown> };
const { parseManifest } = require('./i18n-manifest.cjs') as { parseManifest: (text: string, name: string) => { files: string[]; ignores: string[] } };

RuleTester.describe = describe;
RuleTester.it = it;
// No RuleTester.itOnly: reading `it.only` throws under CI=true in bun ("`.only` is disabled in CI").

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser as never,
    parserOptions: { ecmaFeatures: { jsx: true } },
    sourceType: 'module',
  },
});

const rule = plugin.rules['no-untranslated-string'] as never;
const tsx = (code: string, extra: object = {}) => ({ code, filename: 'src/features/x/Screen.tsx', ...extra });
const legacy = { options: [{ forbidLegacyNames: true }] };

tester.run('no-untranslated-string', rule, {
  valid: [
    // translated
    tsx(`const A = () => <Text>{t('merge.title')}</Text>;`),
    tsx(`const A = () => <Row label={t('x.label')} sub={t('x.sub', { name: 'Foo Bar' })} />;`),
    // JSX text with no letter
    tsx(`const A = () => <Text>· 12 / 30 —</Text>;`),
    tsx(`const A = () => <Text>{' '}</Text>;`),
    tsx(`const A = () => <Text>{'$'}{n}</Text>;`),
    // user-facing prop holding no letter
    tsx(`const A = () => <Input placeholder="…" accessibilityLabel="%" />;`),
    tsx(`const A = () => <Row label={name} sub={a ? b : c} />;`),
    // comparisons, case labels, search methods, regexp
    tsx(`if (kind === 'Hello world') {}`),
    tsx(`if ('Hello world' !== kind) {}`),
    tsx(`switch (k) { case 'Hello world': break; }`),
    tsx(`s.startsWith('Reconciliation Adjustment'); s.includes('Hello world'); new RegExp('Hello world');`),
    // developer text
    tsx(`console.warn('Something went wrong here'); throw new Error('Unexpected state here');`),
    tsx(`throw new TypeError('Unexpected state here');`),
    // imports, types, directives
    tsx(`import x from 'some package name';`),
    tsx(`type K = 'Hello world' | 'Another one'; interface P { kind: 'Hello world' }`),
    tsx(`enum E { A = 'Hello world' }`),
    tsx(`'use client'; const a = 1;`),
    // testID, style, svg
    tsx(`const A = () => <View testID="Hello world" style={{ fontFamily: 'Helvetica Neue', border: '1px solid red' }} />;`),
    tsx(`const A = () => <Path d="M 10 10 L 20 20 Z" fill="none" />;`),
    tsx(`const s = StyleSheet.create({ a: { fontFamily: 'Helvetica Neue', cursor: 'not allowed' } });`),
    // wire values and identifiers: no prose shape
    tsx(`const k = 'income'; const u = 'https://example.com/a'; const id = 'plan_state'; const c = '#fff'; const m = 'POST';`),
    tsx(`const css = 'ease-in ease-out'; const d = '0.2s linear';`),
    // colours, URLs, markup and RTK tags are not text
    tsx(`const theme = { text: '#eef1f7', label: 'rgba(0, 0, 0, 0.5)' }; const svg = '<svg xmlns="x"></svg>';`),
    tsx(`const api = createApi({ tagTypes: ['Budgets', 'Pending Items'], endpoints: () => ({ a: { providesTags: ['Payees'] } }) });`),
    tsx(`dispatch(api.util.invalidateTags(['Budgets']));`),
    // object keys
    tsx(`const o = { 'Hello world': 1, Total: 2 };`),
    tsx(`const v = o['Hello world'];`),
    // t() inside a function, getter, and t.for / labels at module scope
    tsx(`const f = () => t('a.b');`),
    tsx(`const T = { get a() { return t('a.b'); } };`),
    tsx(`function g() { return tCommon('cancel'); }`),
    tsx(`export const R = labels(t, { weekly: 'repeat.weekly' }); const s = t.for('en')('a');`),
    tsx(`class C { f() { return tError('not_found'); } }`),
    // exempt files
    { code: `const a = <Text>Hello world</Text>;`, filename: 'src/features/x/Screen.test.tsx' },
    { code: `const a = 'Hello world';`, filename: 'src/domain/__fixtures__/data.ts' },
    { code: `export default { a: 'Hello world' };`, filename: 'src/features/x/i18n/en.ts' },
    // legacy names are fine unless the option is on
    tsx(`import { MONTH_ABBR } from '@/domain/format';`),
  ],
  invalid: [
    // 1. JSX text
    { ...tsx(`const A = () => <Text>Save changes</Text>;`), errors: [{ messageId: 'jsxText' }] },
    { ...tsx(`const A = () => <Text>  Total: <Text>{n}</Text></Text>;`), errors: [{ messageId: 'jsxText' }] },
    { ...tsx(`const A = () => <Text>Ok</Text>;`), errors: [{ messageId: 'jsxText' }] },
    // 2. user-facing prop: literal, template, conditional of literals, logical fallback
    { ...tsx(`const A = () => <Row label="Rename" />;`), errors: [{ messageId: 'userFacing', data: { text: 'Rename', name: 'label' } }] },
    { ...tsx(`const A = () => <Row title={'x y'} />;`), errors: [{ messageId: 'userFacing' }] },
    { ...tsx(`const A = () => <Row sub={\`\${n} items\`} />;`), errors: [{ messageId: 'userFacing' }] },
    { ...tsx(`const A = () => <Row label={on ? 'Hide' : 'Show'} />;`), errors: [{ messageId: 'userFacing' }, { messageId: 'userFacing' }] },
    { ...tsx(`const A = () => <Row label={name ?? 'none'} />;`), errors: [{ messageId: 'userFacing', data: { text: 'none', name: 'label' } }] },
    { ...tsx(`const A = () => <Input aria-label="search" placeholder="type" alt="logo" />;`), errors: [{ messageId: 'userFacing' }, { messageId: 'userFacing' }, { messageId: 'userFacing' }] },
    // 3. object property with a user-facing name
    { ...tsx(`const rows = [{ label: 'weekly', value: 'w' }];`), errors: [{ messageId: 'userFacing', data: { text: 'weekly', name: 'label' } }] },
    { ...tsx(`const o = { 'description': on ? 'a' : 'b' };`), errors: [{ messageId: 'userFacing' }, { messageId: 'userFacing' }] },
    // 4. prose elsewhere
    { ...tsx(`Alert.alert('Remove bank', 'This cannot be undone.');`), errors: [{ messageId: 'prose' }, { messageId: 'prose' }] },
    { ...tsx(`const msg = \`Saved \${n} rows today\`;`), errors: [{ messageId: 'prose' }] },
    { ...tsx(`setError('Reconciliation');`), errors: [{ messageId: 'prose' }] },
    { ...tsx(`const A = () => <Foo caption="Hello world" />;`), errors: [{ messageId: 'prose' }] },
    { ...tsx(`export const SENTENCE = 'Nothing to show';`), errors: [{ messageId: 'prose' }] },
    { ...tsx(`const x = cond ? 'Not found' : 'Done.';`), errors: [{ messageId: 'prose' }, { messageId: 'prose' }] },
    // 5. t() at module scope
    { ...tsx(`const TITLE = t('a.b');`), errors: [{ messageId: 'moduleScope', data: { name: 't' } }] },
    { ...tsx(`export const X = { a: tCommon('cancel') };`), errors: [{ messageId: 'moduleScope' }] },
    { ...tsx(`const e = tError('not_found');`), errors: [{ messageId: 'moduleScope' }] },
    // 6. legacy names behind the option
    { ...tsx(`import { MONTH_ABBR, WEEKDAY_ABBR, formatMonth } from '@/domain/format';`, legacy), errors: [{ messageId: 'legacyName' }, { messageId: 'legacyName' }] },
    { ...tsx(`import { MONTH_NAMES as M } from './format';`, legacy), errors: [{ messageId: 'legacyName' }] },
  ],
});

describe('manifest parsing', () => {
  it('accepts files and optional ignores', () => {
    expect(parseManifest('{"files":["src/a/**/*.tsx"]}', 'a.json')).toEqual({ files: ['src/a/**/*.tsx'], ignores: [] });
    expect(parseManifest('{"files":["a"],"ignores":["b"]}', 'a.json').ignores).toEqual(['b']);
  });
  it('rejects bad shapes with the file name', () => {
    expect(() => parseManifest('{', 'x.json')).toThrow('i18n-enforced/x.json');
    expect(() => parseManifest('{"files":[]}', 'x.json')).toThrow('"files"');
    expect(() => parseManifest('{"files":["a"],"ignores":"b"}', 'x.json')).toThrow('"ignores"');
  });
});

describe('escape hatch', () => {
  const linter = new Linter();
  const config = (): Linter.Config[] => [
    {
      files: ['**/*.tsx'],
      languageOptions: { parser: tseslint.parser as never, parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { 'budget-i18n': plugin as never },
      rules: { 'budget-i18n/no-untranslated-string': 'error' },
    },
  ];
  it('reports without the comment and honours disable-next-line with a reason', () => {
    const bare = `const a = <Text>Hello</Text>;`;
    expect(linter.verify(bare, config(), 'x.tsx')).toHaveLength(1);
    const disabled = `// eslint-disable-next-line budget-i18n/no-untranslated-string -- brand name\n${bare}`;
    expect(linter.verify(disabled, config(), 'x.tsx')).toHaveLength(0);
  });
});
