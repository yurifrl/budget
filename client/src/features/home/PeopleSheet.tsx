/**
 * The people on a budget, opened from its card: the same People pane the
 * budget's settings menu shows (features/people), so inviting works one way
 * everywhere and its owner-only rule (remove) comes with it.
 */
import { useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';

import { PeoplePane } from '@/features/people';
import { OverlaySheet } from '@/ui/bits';

export function PeopleSheet({ budget, onClose }: { budget: { id: string; name: string } | null; onClose: () => void }) {
  const router = useRouter();
  return (
    <OverlaySheet visible={budget !== null} onClose={onClose} title={budget ? `People on ${budget.name}` : undefined}>
      {budget ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <PeoplePane
            budgetId={budget.id}
            onOpenProfile={() => {
              onClose();
              router.push('/profile');
            }}
          />
        </ScrollView>
      ) : null}
    </OverlaySheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  content: { paddingHorizontal: 8, paddingBottom: 10 },
});
