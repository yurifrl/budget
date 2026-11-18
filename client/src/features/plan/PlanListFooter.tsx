/** Plan grid footer: the "hidden categories" section and the add-category-group row. */
import { Pressable, Text, View } from 'react-native';

import type { MoneyFormat } from '@/domain/format';
import { categoryFigures } from '@/domain/zeroSum';
import { InlineAddRow } from './InlineAddRow';
import { styles } from './styles';
import type { PlanGrid } from './types';
import type { HiddenSection } from './useHiddenSection';

/** Hook-free on purpose: the SectionList remounts its footer on every screen render. */
export function PlanListFooter({
  grid,
  hidden,
  formatMoney,
}: {
  grid: Pick<PlanGrid, 'bm' | 'add'>;
  hidden: HiddenSection;
  formatMoney: MoneyFormat['formatMoney'];
}) {
  const { bm, add } = grid;
  const { hiddenCats } = hidden;
  return (
    <View>
      {hidden.showHiddenRow && hiddenCats.length > 0 ? (
        <View>
          <Pressable
            style={styles.groupRow}
            onPress={hidden.toggleHidden}
            accessibilityLabel="Hidden categories">
            <Text style={styles.groupName}>
              {hidden.hiddenOpen ? '⌄' : '▸'} Categorias ocultas ({hiddenCats.length})
            </Text>
            <View style={{ flexDirection: 'row' }}>
              <Text style={[styles.groupTotal, styles.colAvail]}>{formatMoney(hidden.hiddenTotal)}</Text>
            </View>
          </Pressable>
          {hidden.hiddenOpen
            ? hiddenCats.map((c) => (
                <View
                  key={c.id}
                  style={[styles.trow, { flexDirection: 'row', alignItems: 'center' }]}>
                  <Text style={[styles.catName, { flex: 1 }]} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={[styles.numText, styles.colAvail]}>
                    {formatMoney(categoryFigures(bm, c.id).available)}
                  </Text>
                  <Pressable
                    style={styles.rowMenuBtn}
                    accessibilityLabel={`Restore ${c.name}`}
                    onPress={() => hidden.restore(c.id)}>
                    <Text style={styles.rowMenuText}>Restore</Text>
                  </Pressable>
                </View>
              ))
            : null}
        </View>
      ) : null}
      {add.addingGroup === 'footer' ? (
        <InlineAddRow
          placeholder="Group name"
          accessibilityLabel="New group name"
          onCommit={add.commitAddGroup}
          onCancel={() => add.setAddingGroup(null)}
        />
      ) : (
        <Pressable
          style={styles.addRow}
          onPress={() => add.setAddingGroup('footer')}
          accessibilityLabel="Add category group">
          <Text style={styles.addRowText}>＋ Adicionar grupo de categorias</Text>
        </Pressable>
      )}
    </View>
  );
}
