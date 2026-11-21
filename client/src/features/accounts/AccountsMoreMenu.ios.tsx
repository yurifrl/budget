/**
 * All Accounts "more" menu (iOS) — the phone ⋯ actions as a native SwiftUI
 * `Menu` through `@expo/ui`: a tap on the ⋯ opens the system menu (a kebab
 * button is a tap control, unlike register rows where long-press is the
 * convention — those use `ContextMenu`, see TxnMenuTrigger.ios.tsx). The
 * trigger is a fully native SwiftUI button (SF Symbol `ellipsis`), so no RN
 * `Pressable` competes with the menu gesture; SF Symbols follow the system
 * dark/light appearance. Items: File Import, Reconcile (account scope only),
 * Show/Hide Reconciled, Edit Account (account scope only), Link Account
 * (routes to the linked-banks hub).
 */

import { Button, Host, Menu } from '@expo/ui/swift-ui';
import { foregroundStyle, font } from '@expo/ui/swift-ui/modifiers';

import { colors } from '@/ui/theme';
import { t } from './i18n';

export function AccountsMoreMenu({
  onImport,
  onReconcile,
  showReconciled,
  onToggleReconciled,
  onEditAccount,
}: {
  /** Open the file-import flow. */
  onImport: () => void;
  /** Start a reconcile session — omitted when no account is selected. */
  onReconcile?: () => void;
  /** Whether reconciled rows are currently shown (menu label flips). */
  showReconciled: boolean;
  onToggleReconciled: (show: boolean) => void;
  /** Edit the selected account — omitted on the All Accounts scope. */
  onEditAccount?: () => void;
}) {
  // Pure-SwiftUI trigger (no RN child to size the Host's Yoga node), so the
  // Host gets an explicit frame — without it Yoga measures 0 width and the
  // trigger renders invisible on cold start (dots disappear).
  return (
    <Host style={{ width: 34, height: 34 }}>
      <Menu
        label=""
        systemImage="ellipsis"
        modifiers={[font({ size: 20, weight: 'bold' }), foregroundStyle(colors.indigo3)]}
      >
        <Button label={t('action.import')} systemImage="square.and.arrow.down" onPress={onImport} />
        {onReconcile ? (
          <Button label={t('action.reconcile')} systemImage="checkmark.seal" onPress={onReconcile} />
        ) : null}
        <Button
          label={showReconciled ? t('action.hideReconciled') : t('action.showReconciled')}
          systemImage={showReconciled ? 'eye.slash' : 'eye'}
          onPress={() => onToggleReconciled(!showReconciled)}
        />
        {onEditAccount ? (
          <Button label={t('action.editAccount')} systemImage="pencil" onPress={onEditAccount} />
        ) : null}
      </Menu>
    </Host>
  );
}

