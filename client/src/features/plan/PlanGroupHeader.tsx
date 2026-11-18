/** Plan grid: one category group's header row (collapse toggle, owners, ＋ / ⋯, roll-up totals). */
import { Pressable, Text, TextInput, View } from 'react-native';

import { AvatarStack } from '@/ui/avatar/AvatarStack';

import { groupRollup } from '@/domain/engine';
import {
  categoriesForPerson,
  distinctOwners,
  PERSON_ALL,
  personFor,
  personLabel,
  rollupForPerson,
  sumActivityFor,
  toAvatarPerson,
  type Person,
} from '@/domain/people';
import type { CategoryGroup } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';
import { styles } from './styles';
import type { PlanGrid } from './types';

export function PlanGroupHeader({ grid, group }: { grid: PlanGrid; group: CategoryGroup }) {
  const { budget, bm, shell, byPerson, phoneActivity, menus, add, groups, anchorAt } = grid;
  const { formatMoney } = useMoneyFormat();
  const groupCats = budget.categories.filter((c) => c.groupId === group.id);
  const roll =
    byPerson.person === PERSON_ALL
      ? groupRollup(budget, bm, group.id)
      : rollupForPerson(bm, groupCats, byPerson.person, null);
  const groupOwners = distinctOwners(categoriesForPerson(groupCats.filter((c) => !c.hidden), byPerson.person))
    .map((id) => personFor(byPerson.people, id))
    .filter((p): p is Person => p !== null);
  const isCollapsed = !!groups.collapsed[group.id];
  return (
    <View style={styles.groupRow}>
      {menus.rename?.kind === 'group' && menus.rename.id === group.id ? (
        <TextInput
          value={menus.draftName}
          onChangeText={menus.setDraftName}
          onSubmitEditing={menus.commitRename}
          onBlur={menus.commitRename}
          autoFocus
          style={styles.renameInput}
          accessibilityLabel="Rename group"
        />
      ) : (
        <Pressable
          style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}
          onPress={() => groups.toggleGroupCollapsed(group.id)}
          accessibilityLabel={`Toggle ${group.name} group`}>
          <Text style={styles.groupName}>
            {isCollapsed ? '▸' : '⌄'} {group.name}
          </Text>
          {groupOwners.length > 0 ? (
            <View
              style={{ marginLeft: 8 }}
              accessible
              accessibilityLabel={`Categories of ${groupOwners.map(personLabel).join(', ')}`}>
              <AvatarStack people={groupOwners.map(toAvatarPerson)} max={3} size={16} ring={colors.bg} />
            </View>
          ) : null}
        </Pressable>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          style={styles.rowMenuBtn}
          accessibilityLabel={`Add category to ${group.name}`}
          onPress={() => add.openAddCategory(group.id)}>
          <Text style={styles.rowMenuText}>＋</Text>
        </Pressable>
        <Pressable
          style={styles.rowMenuBtn}
          accessibilityLabel={`${group.name} group options`}
          onPress={(e) => {
            const px = e.nativeEvent.pageX;
            const py = e.nativeEvent.pageY;
            anchorAt(px, py, (x, y) =>
              menus.setMenu({ id: group.id, kind: 'group', x, y }));
          }}>
          <Text style={styles.rowMenuText}>⋯</Text>
        </Pressable>
        <Text style={[styles.groupTotal, styles.colNum, shell.isPhone && styles.colNumPhone]}>{formatMoney(
          phoneActivity
            ? sumActivityFor(
                bm,
                budget.categories.filter((cat) => cat.groupId === group.id),
                byPerson.activity,
              )
            : roll.assigned,
        )}</Text>
        <Text style={[styles.groupTotal, styles.colAvail, shell.isPhone && styles.colAvailPhone]}>{formatMoney(roll.available)}</Text>
      </View>
    </View>
  );
}
