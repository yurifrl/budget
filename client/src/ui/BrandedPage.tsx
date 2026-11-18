/**
 * The page frame the app's front pages share (the landing/sign-in page and
 * the home page), so signing in reads as one product: the same brand, the
 * same type and the same two layouts. Wide windows split into a darker brand
 * pane and a content pane; narrower ones stack the brand row over the
 * content. Safe areas are respected in both. What goes in the content, and
 * when the window counts as wide, is the caller's business.
 */
import type { ReactNode } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import logo from '../../assets/images/logo.png';
import { colors, spacing } from './theme';

interface Props {
  productName: string;
  /** Two panes (wide windows) or one column. */
  split: boolean;
  /**
   * Where the content sits. `anchored` (the landing page): centred beside the
   * brand when split, pushed to the bottom of the screen, within thumb
   * reach, when stacked. `top` (pages that list things): from the top.
   */
  align?: 'anchored' | 'top';
  /** Controls at the top right: of the content pane when split, of the brand row when stacked. */
  trailing?: ReactNode;
  children: ReactNode;
}

export function BrandedPage({ productName, split, align = 'anchored', trailing, children }: Props) {
  const insets = useSafeAreaInsets();
  const top = align === 'top';

  if (split) {
    return (
      <View style={[styles.screen, styles.row]}>
        <View style={[styles.brandPane, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }]}>
          <Brand productName={productName} />
          <Text style={styles.wordmark}>{productName}</Text>
        </View>
        <View style={styles.contentPane}>
          <ScrollView
            contentContainerStyle={[
              styles.contentPaneInner,
              top && styles.contentPaneInnerTop,
              top && { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl },
            ]}>
            {trailing ? <View style={styles.trailingSplit}>{trailing}</View> : null}
            {children}
          </ScrollView>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.stack,
        { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
      ]}>
      <View style={[styles.stackColumn, top && styles.stackColumnTop]}>
        <View style={styles.brandRow}>
          <Brand productName={productName} named />
          {trailing}
        </View>
        {children}
      </View>
    </ScrollView>
  );
}

function Brand({ productName, named = false }: { productName: string; named?: boolean }) {
  return (
    <View style={styles.brand}>
      <Image source={logo} accessibilityLabel={named ? undefined : productName} style={styles.logo} />
      {named ? <Text style={styles.brandName}>{productName}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  row: { flexDirection: 'row' },

  // Wide: a darker brand field on the left, the words and the action on the right.
  brandPane: {
    flex: 5,
    minWidth: 0,
    backgroundColor: colors.appRailBg,
    paddingHorizontal: 56,
    justifyContent: 'space-between',
  },
  wordmark: { color: colors.text, fontSize: 112, lineHeight: 112, fontWeight: '800', letterSpacing: -4 },
  contentPane: { flex: 6, minWidth: 0 },
  contentPaneInner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 72, paddingVertical: spacing.xl },
  contentPaneInnerTop: { justifyContent: 'flex-start', gap: spacing.lg },
  trailingSplit: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },

  // Narrow: one column, brand on top, content pushed to the bottom (or following it).
  stack: { flexGrow: 1, paddingHorizontal: spacing.lg },
  stackColumn: { flex: 1, width: '100%', maxWidth: 520, alignSelf: 'center', justifyContent: 'space-between', gap: 40 },
  stackColumnTop: { justifyContent: 'flex-start', gap: spacing.xl },
  brandRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },

  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 44, height: 44, borderRadius: 12 },
  brandName: { color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
});
