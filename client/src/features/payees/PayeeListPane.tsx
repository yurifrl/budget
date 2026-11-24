import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { colors } from '@/ui/theme';
import { t } from './i18n';
import { styles } from './styles';
import type { PayeeAdmin } from './usePayeeAdmin';
import { displaySystemName } from '@/domain/systemNames';

/** Left pane: the inline add row and the searchable payee list with usage counts. */
export function PayeeListPane({ admin, fill }: { admin: PayeeAdmin; /** Phone: the list takes the whole width. */ fill?: boolean }) {
  const { newName, setNewName, addNewPayee, busy, filtered, search, select, selectedId } = admin;
  return (
    <ScrollView style={[styles.listPane, fill && { width: '100%', flexGrow: 1 }]} contentContainerStyle={styles.listContent}>
      <View style={styles.addRow}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={addNewPayee}
          placeholder={t('list.addPlaceholder')}
          placeholderTextColor={colors.faint}
          style={styles.addInput}
          accessibilityLabel={t('list.newNameLabel')}
        />
        <Pressable onPress={addNewPayee} accessibilityRole="button" accessibilityLabel={t('list.addLabel')}>
          <Text style={styles.addRowBtn}>＋</Text>
        </Pressable>
      </View>
      {busy ? (
        <Text style={styles.empty}>{tCommon('loading')}</Text>
      ) : filtered.length === 0 ? (
        <Text style={styles.empty}>{t('list.noMatch', { query: search.trim() })}</Text>
      ) : (
        filtered.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => select(p)}
            style={({ pressed }) => [
              styles.listRow,
              p.id === selectedId && styles.listRowActive,
              pressed && { backgroundColor: colors.hover },
            ]}>
            <Text style={[styles.listName, p.hidden && styles.listNameHidden]} numberOfLines={1}>
              {displaySystemName(p.name)}
            </Text>
            <Text style={styles.listCount}>{p.transaction_count}</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
