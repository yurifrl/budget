import { Pressable, Text, View } from 'react-native';

import { isKeypadOpKey, KEYPAD_KEYS, type KeypadKey } from '@/domain/txnKeypad';
import { colors } from '@/ui/theme';
import { styles } from './styles';

/** Calculator keypad: digits, ÷ × − ＋, backspace and the save key. */
export function Keypad({
  bottomInset,
  onKey,
  onDone,
}: {
  /** Home-indicator inset the pad must clear. */
  bottomInset: number;
  onKey: (key: Exclude<KeypadKey, 'done'>) => void;
  onDone: () => void;
}) {
  return (
    <View style={[styles.keypad, { paddingBottom: 26 + bottomInset }]}>
      {KEYPAD_KEYS.map((k) => (
        <Pressable
          key={k}
          style={[styles.key, k === 'done' && styles.keyDone, isKeypadOpKey(k) && styles.keyOp]}
          onPress={() => {
            if (k === 'done') onDone();
            else onKey(k);
          }}
          accessibilityLabel={k === 'done' ? 'Save transaction' : `Key ${k}`}>
          <Text
            style={[
              styles.keyText,
              isKeypadOpKey(k) && { color: colors.indigo2 },
              k === 'done' && { color: colors.white, fontSize: 15, fontWeight: '700' },
            ]}>
            {k}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
