/**
 * ESLint plugin `budget-i18n`, rule `no-untranslated-string`.
 *
 * Reports user-visible text that is not going through the i18n catalogs
 * (docs/i18n.md). CommonJS so both the client's CJS config and the ESM configs
 * of shared/api/admin can load it. Enabled per file set by the manifests in
 * `client/i18n-enforced/*.json` and `admin/i18n-enforced/*.json`
 * (see `shared/eslint/i18n-manifest.cjs`).
 *
 * Reports:
 *  1. JSX text containing a letter.
 *  2. A string literal, template literal or conditional/logical of literals in
 *     a user-facing JSX prop (label, title, placeholder, ...).
 *  3. An object property with a user-facing name holding such a literal.
 *  4. Any other string literal or template that looks like prose: two words of
 *     two or more letters separated by a space, or one capitalised word.
 *  5. A call to t() / tCommon() / tError() at module scope (it would freeze the
 *     locale the app booted with).
 *  6. With `{ forbidLegacyNames: true }`: imports of MONTH_ABBR, MONTH_NAMES,
 *     WEEKDAY_ABBR.
 *
 * Exempt: arguments of t/tCommon/tError/labels, console.*, new Error,
 * describe/test/it; comparisons and `case` labels; .startsWith/.includes/
 * RegExp arguments; imports; type positions; testID; style objects; test
 * files, __fixtures__ and i18n/ directories.
 * Escape hatch: `// eslint-disable-next-line budget-i18n/no-untranslated-string -- <reason>`.
 */
'use strict';

const USER_FACING_NAMES = new Set([
  'label', 'title', 'placeholder', 'accessibilityLabel', 'accessibilityHint', 'aria-label', 'sub', 'desc',
  'description', 'heading', 'helper', 'hint', 'emptyText', 'clearLabel', 'confirm', 'referenceLabel',
  'message', 'text', 'alt',
]);

/** JSX props that never carry display text, whatever the value looks like. */
const NON_TEXT_JSX_PROPS = new Set([
  'testID', 'nativeID', 'key', 'id', 'className', 'style', 'role', 'accessibilityRole', 'href', 'src', 'source',
  'type', 'd', 'viewBox', 'fill', 'stroke', 'transform', 'points', 'resizeMode', 'contentFit', 'autoComplete',
  'textContentType', 'keyboardType', 'returnKeyType', 'autoCapitalize', 'inputMode', 'enterKeyHint', 'cursor',
  'pointerEvents', 'name', 'htmlFor', 'rel', 'target', 'method', 'action', 'to', 'asChild', 'variant', 'size',
  'color', 'tintColor', 'family', 'sf', 'icon', 'glyph', 'kind', 'tone', 'mode', 'direction', 'align',
  'justify', 'position', 'edges', 'animation', 'easing', 'collation',
]);

/** Object keys whose string values are CSS or layout, not text (exempt from the prose check). */
const STYLE_KEY = new RegExp(
  '^(font(Family|Weight|Style|Variant|Size)?|border\\w*|outline\\w*|background\\w*|boxShadow|boxSizing|' +
    'text(Shadow|Align|Transform|Decoration\\w*|Overflow|AlignVertical)|transition\\w*|animation\\w*|transform\\w*|' +
    'filter|backdropFilter|cursor|display|flex\\w*|align\\w*|justify\\w*|overflow\\w*|position|whiteSpace|wordBreak|' +
    'wordWrap|listStyle\\w*|willChange|mixBlendMode|objectFit|pointerEvents|userSelect|resize|appearance|clipPath|' +
    'mask\\w*|margin\\w*|padding\\w*|gap|letterSpacing|lineHeight|verticalAlign|\\w*(Color|Width|Height)|top|left|' +
    'right|bottom|inset|zIndex|opacity|fill|stroke|elevation|aspectRatio|grid\\w*|scroll\\w*|touchAction)$',
);

const LEGACY_NAMES = new Set(['MONTH_ABBR', 'MONTH_NAMES', 'WEEKDAY_ABBR']);
const TRANSLATE_FNS = new Set(['t', 'tCommon', 'tError']);
const EXEMPT_CALLEES = new Set(['t', 'tCommon', 'tError', 'labels', 'describe', 'test', 'it', 'require', 'Symbol', 'RegExp']);
const EXEMPT_METHODS = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search']);
const TS_EXPRESSION_WRAPPERS = new Set([
  'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression',
]);
const COMPARISON_OPERATORS = new Set(['==', '===', '!=', '!==']);

const HAS_LETTER = /\p{L}/u;
// Two words of 2+ letters separated by spaces; a hyphen, dot, digit or underscore next to a word disqualifies it
// ("ease-in ease-out", "0.2s linear", "flex_row nowrap").
const TWO_WORDS = /(?<![\w\-.#/:@$%])\p{L}{2,}(?![\w\-.#/:@$%]) +(?<![\w\-.#/:@$%])\p{L}{2,}(?![\w\-.#/:@$%])/u;
const ONE_CAPITALISED_WORD = /^\p{Lu}\p{Ll}{1,}[.:!?…]?$/u;

function looksLikeProse(text) {
  const trimmed = text.trim();
  if (!HAS_LETTER.test(trimmed)) return false;
  return TWO_WORDS.test(trimmed) || ONE_CAPITALISED_WORD.test(trimmed);
}

function nameOfKey(key, computed) {
  if (computed) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  return null;
}

/** Static text of a string literal or template literal; null when the node is neither. */
function staticText(node) {
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ');
  return null;
}

const isTypePosition = (node) => node.type.startsWith('TS') && !TS_EXPRESSION_WRAPPERS.has(node.type);

function isTestOrFixture(filename) {
  const f = filename.replace(/\\/g, '/');
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) ||
    /(^|\/)__fixtures__\//.test(f) ||
    /(^|\/)__tests__\//.test(f) ||
    /(^|\/)i18n\//.test(f)
  );
}

/** Walk up from `node` through value-preserving wrappers; return the slot that receives the value. */
function valueSlot(node) {
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'ConditionalExpression' && parent.test !== child) {
      child = parent;
      parent = parent.parent;
    } else if (parent.type === 'LogicalExpression' || TS_EXPRESSION_WRAPPERS.has(parent.type)) {
      child = parent;
      parent = parent.parent;
    } else {
      break;
    }
  }
  return { child, parent };
}

/** Name of the user-facing JSX prop or object property that receives `node`, else null. */
function userFacingSlotName(node) {
  const { child, parent } = valueSlot(node);
  if (!parent) return null;
  if (parent.type === 'JSXExpressionContainer' && parent.parent && parent.parent.type === 'JSXAttribute') {
    const attr = parent.parent;
    if (attr.name.type === 'JSXIdentifier' && USER_FACING_NAMES.has(attr.name.name)) return attr.name.name;
    return null;
  }
  if (parent.type === 'JSXAttribute' && parent.value === child) {
    return parent.name.type === 'JSXIdentifier' && USER_FACING_NAMES.has(parent.name.name) ? parent.name.name : null;
  }
  if (parent.type === 'Property' && parent.value === child && parent.parent && parent.parent.type === 'ObjectExpression') {
    const name = nameOfKey(parent.key, parent.computed);
    return name !== null && USER_FACING_NAMES.has(name) ? name : null;
  }
  return null;
}

function isExemptContext(node) {
  let child = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (isTypePosition(parent)) return true;
    switch (parent.type) {
      case 'ImportDeclaration':
      case 'ImportExpression':
      case 'TaggedTemplateExpression':
        return true;
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (parent.source === child) return true;
        break;
      case 'ExpressionStatement':
        if (parent.directive !== undefined) return true;
        break;
      case 'SwitchCase':
        if (parent.test === child) return true;
        break;
      case 'BinaryExpression':
        if (COMPARISON_OPERATORS.has(parent.operator) || parent.operator === 'in') return true;
        break;
      case 'Property':
        if (parent.key === child && !parent.computed) return true;
        if (parent.value === child && parent.parent && parent.parent.type === 'ObjectExpression') {
          const name = nameOfKey(parent.key, parent.computed);
          if (name !== null && STYLE_KEY.test(name)) return true;
        }
        break;
      case 'PropertyDefinition':
      case 'MethodDefinition':
        if (parent.key === child && !parent.computed) return true;
        break;
      case 'MemberExpression':
        if (parent.property === child && parent.computed) return true;
        break;
      case 'JSXAttribute':
        if (parent.name.type === 'JSXIdentifier' && NON_TEXT_JSX_PROPS.has(parent.name.name)) return true;
        if (parent.name.type === 'JSXNamespacedName') return true;
        break;
      case 'CallExpression':
      case 'NewExpression': {
        if (parent.callee === child) break;
        const callee = parent.callee;
        const name = calleeName(callee);
        if (name !== null && (EXEMPT_CALLEES.has(name) || /^([A-Z]\w*)?Error$/.test(name))) return true;
        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
          if (callee.object.type === 'Identifier' && callee.object.name === 'console') return true;
          if (callee.object.type === 'Identifier' && callee.object.name === 'StyleSheet') return true;
          if (callee.object.type === 'Identifier' && ['describe', 'test', 'it'].includes(callee.object.name)) return true;
          if (EXEMPT_METHODS.has(callee.property.name)) return true;
        }
        break;
      }
      default:
        break;
    }
  }
  return false;
}

/** True when the nearest enclosing function-like scope exists (the call is not at module scope). */
function insideFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ArrowFunctionExpression') return true;
    if (p.type === 'StaticBlock') return false;
    if (p.type === 'PropertyDefinition' && !p.static) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Disallow user-visible strings that bypass the i18n catalogs (docs/i18n.md).' },
    schema: [
      {
        type: 'object',
        properties: { forbidLegacyNames: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    messages: {
      jsxText: 'Untranslated JSX text "{{text}}": use t(\'key\') from the feature\'s i18n catalog (docs/i18n.md).',
      userFacing: 'Untranslated string "{{text}}" in user-facing `{{name}}`: use t(\'key\') (docs/i18n.md).',
      prose: 'String "{{text}}" looks like user-visible text: use t(\'key\'), or disable with a reason (docs/i18n.md).',
      moduleScope: '{{name}}() at module scope freezes the boot locale: call it inside a function or getter, or use labels(t, {...}).',
      legacyName: '{{name}} is English-only: use monthAbbr()/monthName()/weekdayAbbr() from @/domain/format.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isTestOrFixture(filename)) return {};
    const options = context.options[0] ?? {};

    const shorten = (text) => {
      const one = text.replace(/\s+/g, ' ').trim();
      return one.length > 40 ? `${one.slice(0, 37)}...` : one;
    };

    function checkString(node) {
      const text = staticText(node);
      if (text === null || text.trim() === '') return;
      if (isExemptContext(node)) return;
      const slot = userFacingSlotName(node);
      if (slot !== null) {
        if (HAS_LETTER.test(text)) context.report({ node, messageId: 'userFacing', data: { text: shorten(text), name: slot } });
        return;
      }
      if (looksLikeProse(text)) context.report({ node, messageId: 'prose', data: { text: shorten(text) } });
    }

    return {
      JSXText(node) {
        if (HAS_LETTER.test(node.value)) context.report({ node, messageId: 'jsxText', data: { text: shorten(node.value) } });
      },
      Literal: checkString,
      TemplateLiteral: checkString,
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== null && TRANSLATE_FNS.has(name) && !insideFunction(node)) {
          context.report({ node, messageId: 'moduleScope', data: { name } });
        }
      },
      ImportSpecifier(node) {
        if (!options.forbidLegacyNames) return;
        const imported = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
        if (LEGACY_NAMES.has(imported)) context.report({ node, messageId: 'legacyName', data: { name: imported } });
      },
    };
  },
};

module.exports = {
  meta: { name: 'budget-i18n' },
  rules: { 'no-untranslated-string': rule },
};
