import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  type ViewInstance,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { createPortalOnWeb } from '@/ui/portal';

import type { Cents } from '../../domain/types';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { colors, radius } from '../theme';
import {
  appendQuickMathOp,
  draftCommitCents,
  draftMatchesValue,
  moneyDraftText,
  quickMathOpLabel,
  type QuickMathOp,
} from './moneyDraft.logic';

// Portal pressables must not steal focus from the editor — the mousedown
// focus shift would blur-commit the draft mid-edit. Same bundle and cast as
// register/dropdown.tsx (react-native-web forwards onMouseDown to the DOM at
// runtime, but PressableProps doesn't declare it).
const pressNoBlur = {
  onMouseDown: (e: { preventDefault: () => void }) => {
    e.preventDefault();
  },
} as unknown as { onMouseDown?: (e: { preventDefault: () => void }) => void };

/**
 * Money input editing integer cents via the pt-BR string form. Commits on
 * submit/blur; Esc-less platforms just blur to cancel-commit equal values.
 * `allowEmpty` starts the draft empty when cents is 0 (fresh entry rows)
 * instead of showing a pre-filled "0,00".
 *
 * `quickMath` (syscd-app-5xt) accepts arithmetic drafts ("50+20", "×2",
 * "÷2") evaluated left-to-right on integer cents, with a small operator
 * toggle (qbp) inside the field that opens the 2×2 + − × ÷ popover; tapping
 * an operator replaces a trailing operator instead of appending. Invalid
 * or empty expressions keep the prior value; `onEscape` cancels the edit.
 */
export function MoneyInput({
  cents,
  onCommit,
  autoFocus,
  style,
  allowEmpty = false,
  quickMath = false,
  signed = false,
  onEscape,
}: {
  cents: Cents;
  onCommit: (next: Cents, rawText?: string) => void;
  autoFocus?: boolean;
  style?: StyleProp<TextStyle>;
  allowEmpty?: boolean;
  quickMath?: boolean;
  /** Signed entry: the typed operand is the sign ("-115,00" / "+115,00"). */
  signed?: boolean;
  onEscape?: () => void;
}) {
  const { formatAmount, parseMoney, masked } = useMoneyFormat();
  const initial = useRef(moneyDraftText(cents, { allowEmpty, signed }, formatAmount));
  const [text, setText] = useState(initial.current);
  const [opsOpen, setOpsOpen] = useState(false);
  const opsOpenRef = useRef(false);
  const insideDownRef = useRef(false);
  const cancelledRef = useRef(false);
  const inputRef = useRef<TextInputInstance>(null);
  const wrapRef = useRef<ViewInstance>(null);
  const popRef = useRef<ViewInstance>(null);
  // Web: document-coords anchor for the portal-rendered popover.
  const [qmAnchor, setQmAnchor] = useState<{ left: number; top: number } | null>(null);
  const centsRef = useRef(cents);
  // Re-sync ONLY when the value changes externally (e.g. a sheet sets its
  // default) — never while the user is typing. The old draft-reset fired
  // whenever parseMoney(text) !== cents, which snapped EVERY in-progress edit
  // back to the committed value (deletions/keystrokes reverted instantly).
  // The "draft already parses to the new value" skip keeps a currency-prefixed
  // draft (e.g. "$10") visible after its own commit.
  useEffect(() => {
    if (centsRef.current === cents) return;
    centsRef.current = cents;
    if (draftMatchesValue(text, cents, allowEmpty, parseMoney)) return;
    initial.current = moneyDraftText(cents, { allowEmpty, signed }, formatAmount);
    setText(initial.current);
  }, [cents, allowEmpty, text, signed, formatAmount, parseMoney]);
  useEffect(() => {
    opsOpenRef.current = opsOpen;
  }, [opsOpen]);

  const measureQmAnchor = useCallback(() => {
    if (process.env.EXPO_OS !== 'web') return;
    const node = wrapRef.current as unknown as HTMLElement | null;
    const rect = node?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    const left = rect.left + window.scrollX;
    const top = rect.bottom + window.scrollY + 3; // same gap as the inline popover
    setQmAnchor((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, []);

  useLayoutEffect(() => {
    if (opsOpen) measureQmAnchor();
    else setQmAnchor(null);
  }, [measureQmAnchor, opsOpen]);

  // Keep the portal popover glued to the field while anything scrolls
  // (capture: scroll events don't bubble) or the window resizes.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web' || !opsOpen) return;
    window.addEventListener('scroll', measureQmAnchor, { capture: true });
    window.addEventListener('resize', measureQmAnchor);
    return () => {
      window.removeEventListener('scroll', measureQmAnchor, { capture: true });
      window.removeEventListener('resize', measureQmAnchor);
    };
  }, [measureQmAnchor, opsOpen]);

  // A press counts as "inside this editor" when it lands in the field
  // wrapper or the popover — which lives outside the wrapper's DOM subtree
  // on web (portal on document.body), hence both refs.
  const insideEditor = (target: Node) => {
    const contains = (ref: { current: unknown }) => {
      const node = ref.current as unknown as HTMLElement | null;
      return !!node && (node === target || node.contains(target));
    };
    return contains(wrapRef) || contains(popRef);
  };

  const commitNow = () => {
    if (cancelledRef.current) return;
    // Privacy mask: YNAB parity — "Changes to amounts will not be saved."
    if (masked) return;
    // Signed mode: parseMoney already reads the typed operand ("-115,00" /
    // "+115,00" / bare = positive); quick-math mode falls back to the prior
    // value on an unparseable draft; plain mode parses the magnitude.
    const next = draftCommitCents(text, cents, { signed, quickMath }, parseMoney);
    // Quick-math: invalid/empty drafts keep the prior value but still end the
    // edit (Enter or an outside blur always closes the editor). Other modes
    // only commit on an actual change.
    if (next !== cents || quickMath) onCommit(next, text);
  };

  // Web: a mousedown inside this field must not count as a committing blur
  // (opening the operator popover or pressing an operator blurs the input
  // without the user finishing the edit); an outside mousedown closes the
  // popover and the resulting blur commits, like a normal blur.
  useEffect(() => {
    if (!quickMath || process.env.EXPO_OS !== 'web') return;
    const onDocMouseDown = (e: MouseEvent) => {
      const inside = insideEditor(e.target as Node);
      insideDownRef.current = inside;
      if (opsOpenRef.current && !inside) setOpsOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [quickMath]);

  // Web: Escape must work wherever focus sits — the operator cells steal
  // focus on press (RN-web presses move it to the cell div), so the editor
  // listens at the document level while mounted. RN-web's root keydown
  // handling calls stopPropagation, so bubble-phase listeners past the app
  // root never fire; listen in the capture phase instead, and claim Escape
  // only when focus sits inside this editor (don't steal it from overlays).
  // First Esc closes the popover, the next cancels the edit uncommitted.
  useEffect(() => {
    if (!quickMath || process.env.EXPO_OS !== 'web') return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      if (!active || !insideEditor(active)) return;
      e.preventDefault();
      if (opsOpenRef.current) {
        setOpsOpen(false);
        inputRef.current?.focus();
      } else {
        cancelledRef.current = true;
        setText(initial.current);
        onEscape?.();
      }
    };
    document.addEventListener('keydown', onDocKeyDown, true);
    return () => document.removeEventListener('keydown', onDocKeyDown, true);
  }, [onEscape, quickMath]);

  const toggleOps = () => {
    setOpsOpen(!opsOpen);
    // Chrome moves focus to the pressed cell on mousedown (pointerdown
    // preventDefault doesn't stop that), so refocus the text input a tick
    // later — after RN's press handling — to keep typing landing in the
    // field while the popover is up, exactly like YNAB.
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const insertOp = (op: QuickMathOp) => {
    // qbp: a draft ending in an operator gets it replaced — '+ then ×' is
    // '5×', not '5+×' (which evalQuickMath would reject). Mid-expression
    // operators still append ('5+2' + '−' → '5+2−').
    setText((t) => appendQuickMathOp(t, op));
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  if (!quickMath) {
    return (
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={commitNow}
        onBlur={commitNow}
        autoFocus={autoFocus}
        selectTextOnFocus
        keyboardType="decimal-pad"
        style={[styles.moneyInput, style]}
        accessibilityLabel="Amount"
      />
    );
  }

  const qmRows = ([['+', '−'], ['×', '÷']] as const).map((row) => (
    <View key={row[0]} style={styles.qmPopRow}>
      {row.map((op) => (
        <Pressable
          key={op}
          {...pressNoBlur}
          onPress={() => insertOp(op)}
          accessibilityLabel={quickMathOpLabel(op)}
          style={({ pressed }) => [styles.qmBtn, pressed && { backgroundColor: colors.hover }]}>
          <Text style={styles.qmBtnGlyph}>{op}</Text>
        </Pressable>
      ))}
    </View>
  ));

  // Web: mount the popover on document.body so it can paint above sibling
  // rows (every RN-web View inside a list paints its own z-0 stacking
  // context, so an in-place popover is overlapped by later rows). The
  // anchor is re-measured on scroll/resize while open.
  const qmHost = process.env.EXPO_OS === 'web' && typeof document !== 'undefined' ? document.body : null;
  const qmPortal =
    qmHost && qmAnchor && createPortalOnWeb
      ? createPortalOnWeb(
          <View ref={popRef} style={[styles.qmPopPortal, { left: qmAnchor.left, top: qmAnchor.top }]}>
            {qmRows}
          </View>,
          qmHost,
        )
      : null;
  // Native: keep the popover in place; there's no stacking-context problem
  // there and no document to portal onto.
  const qmInline = opsOpen && !qmPortal ? <View ref={popRef} style={styles.qmPop}>{qmRows}</View> : null;

  return (
    // `style` stays a text style for the plain TextInput path; in quick-math
    // mode it lands on the wrapper (callers there pass no style or a simple
    // View-safe one).
    <View
      ref={wrapRef}
      style={signed ? [styles.moneyInputSigned, style as unknown as ViewStyle] : [styles.moneyInput, styles.qmWrap, style as unknown as ViewStyle]}
    >
      {signed ? null : (
        <Pressable
          onPointerDown={(e) => e.preventDefault()}
          onPress={toggleOps}
          accessibilityLabel="Quick math operators"
          style={({ pressed }) => [styles.qmToggle, pressed && { backgroundColor: colors.hover }]}>
          <Text style={styles.qmToggleGlyph}>±</Text>
        </Pressable>
      )}
      <TextInput
        ref={inputRef}
        value={text}
        onChangeText={(t) => {
          cancelledRef.current = false;
          setText(t);
        }}
        onSubmitEditing={() => {
          setOpsOpen(false);
          commitNow();
        }}
        onBlur={() => {
          if (insideDownRef.current || cancelledRef.current) {
            insideDownRef.current = false;
            return;
          }
          commitNow();
        }}
        autoFocus={autoFocus}
        selectTextOnFocus
        keyboardType={signed ? 'numbers-and-punctuation' : 'decimal-pad'}
        style={styles.qmText}
        accessibilityLabel="Amount"
      />
      {qmPortal}
      {qmInline}
    </View>
  );
}

const styles = StyleSheet.create({
  moneyInput: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    color: colors.text,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 14,
    fontWeight: '700',
    minWidth: 110,
    textAlign: 'right',
  },
  // Quick-math wrapper (syscd-app-5xt): operator cluster left, value right.
  qmWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 10,
  },
  // qbp: one small operator toggle replaces the old 4-cell strip; it opens
  // the same 2×2 + − × ÷ popover.
  qmToggle: {
    width: 18,
    height: 18,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4,
  },
  qmToggleGlyph: { color: colors.muted, fontSize: 12, lineHeight: 14 },
  qmText: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    fontWeight: '700',
    paddingVertical: 6,
    textAlign: 'right',
  },
  qmPop: {
    position: 'absolute',
    left: 0,
    top: '100%',
    marginTop: 3,
    zIndex: 50,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 4,
  },
  // Web portal variant of qmPop (syscd-app-5xt): mounts on document.body at
  // document coords from measureQmAnchor, above every row. Shadow mirrors
  // the register dropdown portal convention.
  qmPopPortal: {
    position: 'absolute',
    zIndex: 60,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 4,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  },
  qmPopRow: { flexDirection: 'row' },
  qmBtn: {
    width: 40,
    height: 34,
    margin: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 6,
  },
  qmBtnGlyph: { color: colors.text, fontSize: 18, fontWeight: '700' },
  // Signed AmountCell wrapper: standard outlined input, no inner ± toggle.
  moneyInputSigned: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
});
