/** Plan grid: a bundle roll-up row wired to the screen's bundle actions, menu and drag state. */
import { bundleRowKey } from '@/domain/bundleDrop';
import { dropLabel } from '@/domain/planDrop';
import { BundleRow, type BundleItem } from './BundleRow';
import type { PlanGrid } from './types';

export function PlanBundleRow({ grid, item: c }: { grid: PlanGrid; item: BundleItem }) {
  const { budget, shell, bundleApi, menus, anchorAt, rowRefs } = grid;
  const { drag, dropAt } = grid.drag;
  const key = bundleRowKey(c.bundle.id);
  const hover = drag && dropAt?.rowId === key ? dropAt.intent : null;
  return (
    <BundleRow
      item={c}
      expanded={!!bundleApi.expanded[c.bundle.id]}
      onToggle={() => bundleApi.toggle(c.bundle.id)}
      onMenu={(px, py) => anchorAt(px, py, (x, y) => menus.setBundleMenu({ id: c.bundle.id, x, y }))}
      renaming={bundleApi.renamingId === c.bundle.id}
      onRename={(name) => bundleApi.rename(c.bundle.id, name)}
      onRenameDone={() => bundleApi.setRenamingId(null)}
      dropLabel={hover === 'bundle' ? dropLabel(dropAt!, budget.categories, budget.bundles) : null}
      dropLine={hover === 'before' ? 'top' : hover === 'after' ? 'bottom' : null}
      isPhone={shell.isPhone}
      showActivity={grid.showActivity}
      showAssignedAsActivity={grid.phoneActivity}
      rowRef={(el) => {
        if (el) rowRefs.current.set(key, el);
        else rowRefs.current.delete(key);
      }}
    />
  );
}
