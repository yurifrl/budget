import { StyleSheet } from 'react-native';

import { colors, radius } from '@/ui/theme';

/** Shared profile-page styles (the module's own visual vocabulary). */
export const ui = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 20,
    gap: 16,
  },
  sectionTitle: { color: colors.faint, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: radius.card10,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPrimary: { backgroundColor: colors.indigo, borderColor: colors.indigo2 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 13 },
  error: { color: colors.redFg, fontSize: 13 },
});
