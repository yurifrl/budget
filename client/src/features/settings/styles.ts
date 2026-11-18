import { StyleSheet } from 'react-native';

import { colors } from '@/ui/theme';

/** Surface color of the menu panes (separator ring for overlapping avatars). */
export const MENU_BG = '#161a24';

// Same palette as the switcher menu itself (shell/SettingsMenu) — the
// panes must read as part of that menu, not a different surface.
export const s = StyleSheet.create({
  sectionLabel: {
    color: '#5f6878',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    marginTop: 14,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 4, borderRadius: 8 },
  rowStatic: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 10,
  },
  rowPressed: { backgroundColor: '#232a3a' },
  rowActive: { backgroundColor: '#211d3b' },
  rowEmphasized: {
    marginTop: 8,
    backgroundColor: '#211d3b',
    borderWidth: 1,
    borderColor: '#3a3470',
  },
  dangerNote: {
    color: '#98a2b5',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 6,
    paddingHorizontal: 4,
  },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { color: '#eef1f7', fontSize: 14 },
  rowLabelStrong: { color: '#eef1f7', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  rowSub: { color: '#5f6878', fontSize: 12, flexShrink: 1 },
  rowChevron: { color: '#5f6878', fontSize: 16, marginLeft: 'auto' },
  hint: { color: '#5f6878', fontSize: 12, marginTop: 10, paddingHorizontal: 4 },
  input: {
    marginTop: 8,
    backgroundColor: '#0f1219',
    borderColor: '#333c50',
    borderWidth: 1,
    borderRadius: 8,
    color: '#eef1f7',
    paddingHorizontal: 10,
    height: 36,
    fontSize: 14,
  },
  errorText: { color: colors.red, fontSize: 12, marginTop: 6 },
  savedText: { color: colors.green, fontSize: 12, marginTop: 6 },
  seg: {
    flexDirection: 'row',
    marginTop: 6,
    backgroundColor: '#0f1219',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333c50',
    overflow: 'hidden',
  },
  segBtn: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  segBtnActive: { backgroundColor: '#211d3b' },
  segText: { color: '#5f6878', fontSize: 12, fontWeight: '600' },
  segTextActive: { color: '#eef1f7' },
  preview: { color: '#5f6878', fontSize: 12, marginTop: 12 },
  flagRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  flagDot: { width: 14, height: 14, borderRadius: 7 },
  flagInput: {
    flex: 1,
    backgroundColor: '#0f1219',
    borderColor: '#333c50',
    borderWidth: 1,
    borderRadius: 8,
    color: '#eef1f7',
    paddingHorizontal: 10,
    height: 34,
    fontSize: 13,
  },
  accountEmail: { color: '#eef1f7', fontSize: 14, marginTop: 4 },
  shortcutKeys: { color: '#eef1f7', fontSize: 13, fontWeight: '700', minWidth: 64 },
});
