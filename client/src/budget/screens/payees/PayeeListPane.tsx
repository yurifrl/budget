import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { colors } from '../../ui/theme';
import { styles } from './styles';
import type { PayeeAdmin } from './usePayeeAdmin';

/** Left pane: the inline add row and the searchable payee list with usage counts. */
export function PayeeListPane({ admin }: { admin: PayeeAdmin }) {
  const { newName, setNewName, addNewPayee, busy, filtered, search, select, selectedId } = admin;
  return (
    <ScrollView style={styles.listPane} contentContainerStyle={styles.listContent}>
      <View style={styles.addRow}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={addNewPayee}
          placeholder="Add a payee…"
          placeholderTextColor={colors.faint}
          style={styles.addInput}
          accessibilityLabel="New payee name"
        />
        <Pressable onPress={addNewPayee} accessibilityRole="button" accessibilityLabel="Add payee">
          <Text style={styles.addRowBtn}>＋</Text>
        </Pressable>
      </View>
      {busy ? (
        <Text style={styles.empty}>Loading…</Text>
      ) : filtered.length === 0 ? (
        <Text style={styles.empty}>No payees match “{search.trim()}”.</Text>
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
              {p.name}
            </Text>
            <Text style={styles.listCount}>{p.transaction_count}</Text>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
}
