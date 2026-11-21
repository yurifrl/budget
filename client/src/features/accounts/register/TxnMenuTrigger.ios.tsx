/**
 * Native (iOS) register-row context menu, using UIKit-managed
 * `UIContextMenuInteraction` through `@expo/ui`'s `ContextMenu` — the mobile
 * counterpart of the desktop-only `TxnRowMenu` popup. Same action set as
 * `useTxnRowMenuActions`; Delete maps to the system destructive role (red
 * label). Disabled states mirror the desktop menu. Submenus stay SwiftUI
 * `Menu`s — inside `contextMenu(menuItems:)` they compose into native
 * submenus.
 *
 * The trigger is the WHOLE row: the `ContextMenu` runs inside a `<Host>`
 * SwiftUI tree, and the row's `Pressable` is bridged into the trigger slot via
 * `RNHostView matchContents` — a long-press anywhere on the row opens the
 * system menu, no ⋯ kebab. Tap-to-edit still works because the hosted
 * `Pressable` keeps handling its own presses (long-press is consumed by the
 * context menu interaction). `matchContents` (vertical on both bridges) sizes
 * the host to the row's natural height so the list layout is unchanged.
 *
 * `ContextMenu` (not `Menu`): the system owns presentation and dismissal, so
 * menu interactions can't orphan gesture state in the SwiftUI hosting tree
 * (`Menu` did — after one menu interaction the whole register list stopped
 * responding to taps until relaunch). A `ContextMenu.Preview` raises the row
 * as a rounded bubble when the menu opens; the resting row is untouched.
 */
import type { ReactElement } from "react";
import { StyleSheet, View } from "react-native";

import { tCommon } from "@shared/i18n/common";
import { Button, ContextMenu, Host, Menu, RNHostView } from "@expo/ui/swift-ui";
import { disabled } from "@expo/ui/swift-ui/modifiers";

import type { Budget, RepeatFrequency, Transaction } from "@/domain/types";
import { displayFlagLabel } from "@/domain/flagLabels";
import { useFlagLabels } from "@/state/useDisplayPrefs";
import { useMoneyFormat } from "@/ui/moneyFormat";
import { REPEAT_FREQS, REPEAT_LABELS } from "./InlineAddRow";
import { FLAG_COLORS, colors } from "@/ui/theme";
import { t } from "./i18n";
import { useTxnRowMenuActions } from "./txnRowMenuShared";

export function TxnMenuTrigger({
  txn,
  budget,
  budgetId,
  onEditMemo,
  children,
}: {
  txn: Transaction;
  budget: Budget;
  budgetId: string;
  /** Memo… opens the row editor focused on this transaction. */
  onEditMemo: (txn: Transaction) => void;
  /** The row content — hosted as the long-press trigger. */
  children: ReactElement;
}) {
  const flagLabels = useFlagLabels();
  const { formatDate, formatMoney } = useMoneyFormat();
  const {
    approve,
    reject,
    setClear,
    setFlag,
    categorize,
    makeRepeat,
    moveTo,
    duplicate,
    doDelete,
    match,
    unmatch,
    exportCsv,
    candidates,
    moveTargets,
    busy,
  } = useTxnRowMenuActions({ txn, budget, budgetId, onClose: () => undefined });

  const hasCandidates = candidates.length > 0;
  const canMove = moveTargets.length > 0;

  // Reconciled rows have no menu (the kebab was already hidden for them).
  if (txn.cleared === "reconciled") return <>{children}</>;

  return (
    <Host matchContents={{ vertical: true }}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <RNHostView matchContents={{ vertical: true }}>
            <View>
              {children}
            </View>
          </RNHostView>
        </ContextMenu.Trigger>
        {/*
          Custom lifted preview (contextMenu(menuItems:preview:), iOS 16+):
          the same row content raised as a rounded card. Vertical-only
          matchContents pins the preview's height to the row's measured height
          while SwiftUI stretches it to the preview width and reports that
          width back to yoga — content stays left-anchored and overflow clips
          on the right, mirroring how resting rows clip at the screen edge.
          Both-axes would pin the frame to the row's own (wider) measured
          width, centering it and clipping the payee's left edge.
        */}
        <ContextMenu.Preview>
          <RNHostView matchContents={{ vertical: true }}>
            <View style={previewBubble.container}>
              {children}
            </View>
          </RNHostView>
        </ContextMenu.Preview>
        <ContextMenu.Items>
          <Button
            label={t('menu.approve')}
            systemImage="checkmark"
            modifiers={[disabled(txn.approved)]}
            onPress={approve}
          />
          <Button
            label={t('menu.reject')}
            systemImage="xmark"
            modifiers={[disabled(txn.approved || txn.importId == null)]}
            onPress={reject}
          />
          <Button
            label={t('menu.markCleared')}
            systemImage="checkmark.circle"
            modifiers={[disabled(txn.cleared !== "uncleared")]}
            onPress={() => setClear("cleared")}
          />
          <Button
            label={t('menu.markUncleared')}
            systemImage="circle"
            modifiers={[disabled(txn.cleared !== "cleared")]}
            onPress={() => setClear("uncleared")}
          />
          <Menu
            label={t('menu.match')}
            systemImage="arrow.left.arrow.right"
            modifiers={[disabled(!hasCandidates || busy)]}
          >
            {hasCandidates
              ? candidates.map((c) => (
                  <Button
                    key={c.id}
                    label={t('menu.matchOption', {
                      payee: c.payee,
                      date: formatDate(c.date),
                      amount: formatMoney(Math.abs(c.inflow - c.outflow)),
                    })}
                    onPress={() => match(c)}
                  />
                ))
              : null}
          </Menu>
          <Button
            label={t('menu.unmatch')}
            systemImage="link.badge.plus"
            modifiers={[disabled(!txn.matchedTransactionId || busy)]}
            onPress={unmatch}
          />
          <Button
            label={t('menu.duplicate')}
            systemImage="plus.square.on.square"
            modifiers={[disabled(busy)]}
            onPress={duplicate}
          />
          <Button
            label={t('menu.memoShort')}
            systemImage="square.and.pencil"
            onPress={() => onEditMemo(txn)}
          />
          <Menu
            label={t('menu.makeRepeating')}
            systemImage="arrow.triangle.2.circlepath"
            modifiers={[
              disabled(txn.repeatRuleId != null || txn.upcoming || busy),
            ]}
          >
            {REPEAT_FREQS.map((f: RepeatFrequency) => (
              <Button
                key={f}
                label={REPEAT_LABELS[f]}
                onPress={() => makeRepeat(f)}
              />
            ))}
          </Menu>
          <Menu label={t('menu.flag')} systemImage="flag">
            {FLAG_COLORS.map(({ key }) => (
              <Button
                key={key}
                label={displayFlagLabel(flagLabels, key)}
                onPress={() => setFlag(key)}
              />
            ))}
            <Button label={t('menu.noFlagTitleCase')} onPress={() => setFlag(null)} />
          </Menu>
          <Menu label={t('menu.categorize')} systemImage="tag">
            <Button label={t('menu.uncategorized')} onPress={() => categorize(null)} />
            {budget.categories.map((cat) => (
              <Button
                key={cat.id}
                label={cat.name}
                onPress={() => categorize(cat.id)}
              />
            ))}
          </Menu>
          <Menu
            label={t('menu.moveToAccount')}
            systemImage="arrowshape.turn.up.right"
            modifiers={[disabled(!canMove || busy)]}
          >
            {canMove
              ? moveTargets.map((a) => (
                  <Button
                    key={a.id}
                    label={a.name}
                    onPress={() => moveTo(a.id)}
                  />
                ))
              : null}
          </Menu>
          <Button
            label={t('menu.export')}
            systemImage="square.and.arrow.up"
            onPress={() => void exportCsv()}
          />
          <Button
            label={tCommon('delete')}
            systemImage="trash"
            role="destructive"
            onPress={doDelete}
          />
        </ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}

/** Card look for the long-press preview so the row lifts as a rounded bubble. */
const previewBubble = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: 12,
    overflow: "hidden",
  },
});
