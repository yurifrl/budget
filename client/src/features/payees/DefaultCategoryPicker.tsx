import type { PayeeAdminRow } from '@/budget/data/rows';
import type { Budget, MonthKey } from '@/domain/types';
import { useBudgetMonth } from '@/state/useBudgetMonth';
import { CategoryDropdown } from '@/ui/dropdown/CategoryDropdown';

/** Fixed-mode default-category picker (reuses the register's CategoryDropdown). */
export function DefaultCategoryPicker({
  payee,
  budget,
  month,
  onCommit,
  onCreateError,
  addCategory,
  budgetId,
}: {
  payee: PayeeAdminRow;
  budget: Budget;
  month: MonthKey;
  onCommit: (defaultCategoryId: string | null) => void;
  onCreateError: (err: unknown) => void;
  addCategory: (
    arg: { budgetId: string; groupId: string; name: string; sortOrder: number },
  ) => { unwrap: () => Promise<{ id: string }> };
  budgetId: string;
}) {
  const bm = useBudgetMonth(budget, month);
  const current = budget.categories.find((c) => c.id === payee.default_category_id) ?? null;
  const placeholder = current
    ? `${current.name} (${budget.groups.find((g) => g.id === current.groupId)?.name ?? ''})`
    : 'None';

  const createCategory = async (query: string, assign: (id: string) => void) => {
    const group = budget.groups[0];
    if (!group || !query) return;
    try {
      const created = await addCategory({
        budgetId,
        groupId: group.id,
        name: query,
        sortOrder: budget.categories.length,
      }).unwrap();
      assign(created.id);
    } catch (err) {
      onCreateError(err);
    }
  };

  return (
    <CategoryDropdown
      categories={budget.categories}
      groups={budget.groups}
      bundles={budget.bundles}
      currentCategoryId={payee.default_category_id}
      bm={bm}
      // Transfer accounts make no sense as a default category; the empty list
      // leaves the menu's Payment/Transfer view with nothing to pick.
      accounts={[]}
      payeeValue={payee.name}
      onPick={(picked) => onCommit(picked)}
      onCreate={(query) => void createCategory(query, (id) => onCommit(id))}
      onTransferPick={() => undefined}
      placeholder={placeholder}
      chevron
      accessibilityLabel="Default category"
    />
  );
}
