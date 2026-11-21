/** Plan grid footer: the "hidden categories" section and the add-category-group row. */
import { Pressable, Text, View } from 'react-native';

import type { MoneyFormat } from '@/domain/format';
import { categoryFigures } from '@/domain/zeroSum';
import { t } from './i18n';
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
            accessibilityLabel={t('hidden.label')}>
            <Text style={styles.groupName}>
              {hidden.hiddenOpen ? '⌄' : '▸'} {t('hidden.heading', { count: hiddenCats.length })}
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
                    accessibilityLabel={t('hidden.restoreLabel', { name: c.name })}
                    onPress={() => hidden.restore(c.id)}>
                    <Text style={styles.rowMenuText}>{t('hidden.restore')}</Text>
                  </Pressable>
                </View>
              ))
            : null}
        </View>
      ) : null}
      {add.addingGroup === 'footer' ? (
        <InlineAddRow
          placeholder={t('group.newPlaceholder')}
          accessibilityLabel={t('group.newLabel')}
          onCommit={add.commitAddGroup}
          onCancel={() => add.setAddingGroup(null)}
        />
      ) : (
        <Pressable
          style={styles.addRow}
          onPress={() => add.setAddingGroup('footer')}
          accessibilityLabel={t('group.addLabel')}>
          <Text style={styles.addRowText}>{t('group.addButton')}</Text>
        </Pressable>
      )}
    </View>
  );
}
