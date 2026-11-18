/**
 * The Plan grid's menu layer: delete confirmation, the bundle row menu,
 * the "name this bundle" popover and the row / group context menu.
 */
import { Pressable, Text, View } from 'react-native';

import { categoryOwnerId } from '../../domain/people';
import { isBatchTarget, menuTargetIds } from '../../domain/planSelection';
import { BundleNamePopover, BundleRowMenu, CategoryBundleItems } from '../BundleMenus';
import { RowMenu } from './RowMenu';
import { styles } from './styles';
import type { PlanGrid } from './types';
import type { RowMenuState } from './usePlanRowMenus';

export function PlanMenus({ grid }: { grid: PlanGrid }) {
  const { budget, menus, add, selection, bundleApi } = grid;
  const { confirmDelete, bundleMenu, bundlePop, menu } = menus;
  return (
    <>
      {confirmDelete ? (
        <Pressable style={styles.menuBackdrop} onPress={() => menus.setConfirmDelete(null)}>
          <Pressable style={[styles.rowMenuCard, { top: 44, right: 16 }]} onPress={() => undefined}>
            <Text style={styles.menuItemText}>
              This category has activity this month. Delete it? Its transactions keep their history.
            </Text>
            <View style={styles.sheetRow}>
              <Pressable
                style={styles.menuItem}
                accessibilityLabel="Confirm delete"
                onPress={menus.confirmDeleteNow}>
                <Text style={styles.menuItemTextDanger}>Delete</Text>
              </Pressable>
              <Pressable
                style={styles.menuItem}
                accessibilityLabel="Cancel delete"
                onPress={() => menus.setConfirmDelete(null)}>
                <Text style={styles.menuItemText}>Cancel</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      ) : null}
      {bundleMenu && budget.bundles.some((b) => b.id === bundleMenu.id) ? (
        <BundleRowMenu
          bundle={budget.bundles.find((b) => b.id === bundleMenu.id)!}
          x={bundleMenu.x}
          y={bundleMenu.y}
          onClose={() => menus.setBundleMenu(null)}
          onRename={() => {
            bundleApi.setRenamingId(bundleMenu.id);
            menus.setBundleMenu(null);
          }}
          onAddCategory={() => {
            const b = budget.bundles.find((x) => x.id === bundleMenu.id)!;
            menus.setBundleMenu(null);
            add.openAddCategoryInBundle(b);
          }}
          onUngroup={() => {
            bundleApi.ungroup(bundleMenu.id);
            menus.setBundleMenu(null);
          }}
        />
      ) : null}
      {bundlePop ? (
        <BundleNamePopover
          x={bundlePop.x}
          y={bundlePop.y}
          ids={bundlePop.ids}
          categories={budget.categories}
          onClose={() => menus.setBundlePop(null)}
          onSubmit={(ids, name) => {
            menus.setBundlePop(null);
            selection.clearChecked();
            bundleApi.createFrom(ids, name);
          }}
        />
      ) : null}
      {menu ? <PlanRowMenu key={menu.id} grid={grid} menu={menu} /> : null}
    </>
  );
}

/** The open row / group menu, wired to the screen's actions. */
function PlanRowMenu({ grid, menu }: { grid: PlanGrid; menu: RowMenuState }) {
  const { budget, shell, byPerson, menus, selection, bundleApi } = grid;
  const { checkedRows } = selection;
  const cat = menu.kind === 'category' ? budget.categories.find((c) => c.id === menu.id) : undefined;
  const batch = menu.kind === 'category' && isBatchTarget(checkedRows, menu.id);
  const bundleIds = cat ? menuTargetIds(checkedRows, cat.id) : [];
  return (
    <RowMenu
      menu={menu}
      desktop={shell.isDesktop}
      batch={batch}
      initialRename={menu.initialRename === true}
      bundleItems={
        cat ? (
          <CategoryBundleItems
            bundlesInGroup={budget.bundles.filter((b) => b.groupId === cat.groupId)}
            currentBundleId={cat.bundleId}
            onJoin={(bundleId) => {
              menus.setMenu(null);
              void bundleApi.join(bundleIds, bundleId);
            }}
            onNew={() => {
              menus.setMenu(null);
              menus.setBundlePop({ x: menu.x, y: menu.y, ids: bundleIds });
            }}
            onLeave={() => {
              menus.setMenu(null);
              bundleApi.leave(bundleIds);
            }}
          />
        ) : null
      }
      people={byPerson.people}
      currentOwnerId={menu.kind === 'category' ? categoryOwnerId(cat ?? {}) : undefined}
      onAssign={(userId) => menus.assignMenuTo(menu, userId)}
      name={menus.nameOf(menu.id, menu.kind)}
      onClose={() => menus.setMenu(null)}
      onRename={batch ? null : () => menus.startInlineRename(menu)}
      onHide={menu.kind === 'category' ? () => menus.hideFromMenu(menu) : null}
      onDelete={() => menus.deleteFromMenu(menu)}
      onCommitRename={(name) => menus.renameFromMenu(menu, name)}
    />
  );
}
