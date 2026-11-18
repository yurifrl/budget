/**
 * Small shared UI pieces for the Budget screens, styled after `mocks/demo.html`
 * (pills, progress bars, buttons, overlay sheets). React Native primitives only
 * — they render identically on web (react-native-web) and iOS.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortalOnWeb } from '@/ui/portal';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
  type ViewInstance,
  type GestureResponderEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import Svg, { Circle } from 'react-native-svg';

import { useMoneyFormat } from '../model/useDisplayPrefs';
import { evalQuickMath } from '../domain/quickmath';
import type { Cents, FundingState } from '../domain/types';
import { barColor, colors, pillColors, radius } from './theme';

/** YNAB-style target-progress ball (syscd-app-6jns): a small ring that fills
 * clockwise with the category's funding progress. Null/undefined renders
 * nothing — only categories with a target show it. */
function ProgressBall({ state, progress }: { state: FundingState; progress: number }) {
  const pct = Math.max(0, Math.min(1, progress));
  const r = 5.5;
  const c = 2 * Math.PI * r;
  return (
    <Svg width={15} height={15} viewBox="0 0 15 15">
      <Circle cx={7.5} cy={7.5} r={r} stroke={colors.faint} strokeWidth={2.5} fill="none" />
      <Circle
        cx={7.5}
        cy={7.5}
        r={r}
        stroke={barColor(state)}
        strokeWidth={2.5}
        fill="none"
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 7.5 7.5)"
      />
    </Svg>
  );
}

/** The AVAILABLE pill, colored by funding state. `progress` (0..1) shows the
 * YNAB target ball left of the amount when set. */
export function Pill({
  state,
  cents,
  progress,
  small = false,
  onPress,
}: {
  state: FundingState;
  cents: Cents;
  progress?: number | null;
  /** Compact padding/font — phone rows, where a wide amount ("R$ 4.453,69")
   * would overflow the AVAILABLE cell over the ASSIGNED column. */
  small?: boolean;
  /** Receives the press event: web pill presses anchor the move popover at
   * the pill (syscd-app-pjtv) via nativeEvent.pageX/pageY. */
  onPress?: (e: GestureResponderEvent) => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const c = pillColors(state);
  const pill = (
    <View style={[styles.pill, small && styles.pillSmall, { backgroundColor: c.bg }]}>
      {progress != null ? <ProgressBall state={state} progress={progress} /> : null}
      <Text style={[styles.pillText, small && styles.pillTextSmall, { color: c.fg }]}>{formatMoney(cents)}</Text>
    </View>
  );
  if (!onPress) return pill;
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityLabel="Available — move money">
      {pill}
    </Pressable>
  );
}

/** Funding progress bar under a category row (assigned vs needed). */
export function FundingBar({ state, fraction }: { state: FundingState; fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction));
  return (
    <View style={styles.barTrack}>
      <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: barColor(state) }]} />
    </View>
  );
}

export function IndigoButton({ label, onPress, disabled, style }: { label: string; onPress?: () => void; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={[styles.btnIndigo, style, disabled && styles.btnIndigoOff]} accessibilityRole="button">
      <Text style={[styles.btnIndigoText, disabled && styles.btnIndigoTextOff]}>{label}</Text>
    </Pressable>
  );
}

export function GhostButton({ label, onPress, style }: { label: string; onPress?: () => void; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable onPress={onPress} style={[styles.btnGhost, style]} accessibilityRole="button">
      <Text style={styles.btnGhostText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Centered overlay sheet (mock `.overlay` + `.sheet`): a dim scrim with a card.
 * Tapping the scrim dismisses.
 */
export function OverlaySheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A row inside an OverlaySheet (mock `.sheet-item`). */
export function SheetItem({
  icon,
  label,
  sub,
  active,
  onPress,
}: {
  icon?: string;
  label: string;
  sub?: string;
  active?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetItem,
        active && { backgroundColor: colors.indigoSoft },
        pressed && { backgroundColor: colors.hover },
      ]}>
      {icon ? (
        <View style={styles.sheetItemIcon}>
          <Text style={{ fontSize: 14 }}>{icon}</Text>
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.sheetItemLabel}>{label}</Text>
        {sub ? <Text style={styles.sheetItemSub}>{sub}</Text> : null}
      </View>
      {active ? <Text style={{ color: colors.indigo2 }}>✓</Text> : null}
    </Pressable>
  );
}

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
 * Signed pt-BR draft text: "-1.314,51" / "+1.314,51"; 0 → empty. The operand
 * in the string IS the storage sign — a bare number reads as positive.
 */
function signedAmountText(cents: Cents, formatAmount: (cents: Cents) => string): string {
  if (cents === 0) return '';
  return cents < 0 ? formatAmount(cents) : `+${formatAmount(cents)}`;
}

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
  const initial = useRef(allowEmpty && cents === 0 ? '' : signed ? signedAmountText(cents, formatAmount) : formatAmount(cents));
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
    if (parseMoney(text) === cents && !(allowEmpty && cents === 0 && text !== '')) return;
    initial.current = allowEmpty && cents === 0 ? '' : signed ? signedAmountText(cents, formatAmount) : formatAmount(cents);
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
    const next = signed
      ? parseMoney(text)
      : quickMath
        ? (evalQuickMath(text, cents, { parseMoney }) ?? cents)
        : parseMoney(text);
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

  const insertOp = (op: '+' | '−' | '×' | '÷') => {
    // qbp: a draft ending in an operator gets it replaced — '+ then ×' is
    // '5×', not '5+×' (which evalQuickMath would reject). Mid-expression
    // operators still append ('5+2' + '−' → '5+2−').
    setText((t) => {
      const trimmed = t.trimEnd();
      return /[+−×÷]$/.test(trimmed) ? trimmed.slice(0, -1) + op : t + op;
    });
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
          accessibilityLabel={`${op === '+' ? 'Add' : op === '−' ? 'Subtract' : op === '×' ? 'Multiply' : 'Divide'} operator`}
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

/**
 * Hero amount field (mobile category detail / move-money pages): one large
 * centered input — the amount IS the page's headline. Same draft/commit
 * semantics as MoneyInput (blur/Enter commits, parseMoney reads pt-BR drafts,
 * the privacy mask blocks saving) without the operator popover; Escape resets
 * the draft. External cents changes re-seed the draft only while unfocused.
 */
export function BigMoneyInput({
  cents,
  onCommit,
  autoFocus = false,
  accent = colors.indigo2,
  color = colors.text,
  accessibilityLabel = 'Amount',
}: {
  cents: Cents;
  onCommit: (next: Cents) => void;
  autoFocus?: boolean;
  /** Focus-ring color (cover flows may pass red). */
  accent?: string;
  color?: string;
  accessibilityLabel?: string;
}) {
  const { formatAmount, parseMoney, masked } = useMoneyFormat();
  const [text, setText] = useState(() => formatAmount(cents));
  const [focused, setFocused] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (focused) return;
    if (parseMoney(text) === cents) return;
    setText(formatAmount(cents));
  }, [cents, focused, text, formatAmount, parseMoney]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    // Privacy mask: YNAB parity — "Changes to amounts will not be saved."
    if (masked) return;
    const next = parseMoney(text);
    // Normalize the visible draft ("100" → "100,00") even when the parsed
    // value didn't change — the sync effect can't (parse-equal early return).
    const formatted = formatAmount(next);
    if (formatted !== text) setText(formatted);
    if (next !== cents) onCommit(next);
  };

  return (
    <View style={[styles.bigMoney, focused && { borderColor: accent }]}>
      <TextInput
        value={text}
        onChangeText={setText}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onSubmitEditing={commit}
        onKeyPress={(e) => {
          if (e.nativeEvent.key !== 'Escape') return;
          cancelledRef.current = true;
          setText(formatAmount(cents));
        }}
        autoFocus={autoFocus}
        selectTextOnFocus
        keyboardType="numbers-and-punctuation"
        style={[styles.bigMoneyText, { color }]}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

/**
 * Amount (shared with the register and the import preview): one signed input
 * — "-115,00" (outflow, red) / "+115,00" or bare digits (inflow, green). The
 * typed operand IS the sign; a bare number saves as positive. No direction
 * toggle, no box — the input carries the standard outlined style. The optional
 * `style` sizes the field (e.g. a flexed register column).
 */
export function AmountCell({
  outflowCents,
  inflowCents,
  onChange,
  style,
}: {
  outflowCents: Cents;
  inflowCents: Cents;
  onChange: (patch: { outflowCents: Cents; inflowCents: Cents }, rawText?: string) => void;
  style?: StyleProp<TextStyle>;
}) {
  const isOutflow = outflowCents !== 0 || inflowCents === 0;
  // Storage sign in the field: outflow renders "−55,90" so editing digits
  // re-commits as an outflow (next < 0), not silently flipping to inflow.
  const cents = isOutflow ? -outflowCents : inflowCents;
  return (
    <MoneyInput
      signed
      allowEmpty
      cents={cents}
      onCommit={(next, rawText) =>
        next < 0
          ? onChange({ outflowCents: -next, inflowCents: 0 }, rawText)
          : onChange({ outflowCents: 0, inflowCents: next }, rawText)
      }
      style={[styles.amountValue, cents !== 0 && (isOutflow ? styles.amountOutValue : styles.amountInValue), style]}
    />
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    alignSelf: 'flex-end',
  },
  pillText: { fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'] },
  pillSmall: { paddingHorizontal: 7, gap: 4 },
  pillTextSmall: { fontSize: 12 },
  // Hero amount field (BigMoneyInput): the amount as the page's headline.
  // stretch: parents center their children (hero rows), the field fills them.
  bigMoney: {
    alignSelf: 'stretch',
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.r,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  bigMoneyText: {
    width: '100%',
    fontSize: 34,
    fontWeight: '800',
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    paddingVertical: 0,
  },
  barTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.grayPillBg,
    overflow: 'hidden',
    marginTop: 6,
  },
  barFill: { height: 3, borderRadius: 2 },
  btnIndigo: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 9,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  btnIndigoText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  btnIndigoOff: { opacity: 0.5 },
  btnIndigoTextOff: { opacity: 0.8 },
  btnGhost: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 13,
    alignItems: 'center',
  },
  btnGhostText: { color: colors.text, fontWeight: '600', fontSize: 13 },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  sheet: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.r,
    padding: 8,
    width: '100%',
    maxWidth: 420,
    maxHeight: '85%',
  },
  sheetTitle: {
    fontSize: 10,
    color: colors.faint,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    paddingHorizontal: 11,
    paddingTop: 9,
    paddingBottom: 5,
    fontWeight: '700',
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 11,
    borderRadius: radius.sm,
  },
  sheetItemIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.card2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetItemLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  sheetItemSub: { color: colors.faint, fontSize: 11 },
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
  amountValue: { flex: 1, minWidth: 0, textAlign: 'right', fontSize: 13, paddingVertical: 4, paddingHorizontal: 6 },
  amountOutValue: { color: colors.redFg },
  amountInValue: { color: colors.greenPillFg },
});
