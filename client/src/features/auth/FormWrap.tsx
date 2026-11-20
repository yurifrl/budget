import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

/** Native: a plain column. The web variant (FormWrap.web.tsx) renders a real <form>. */
export function FormWrap({ children }: { children: ReactNode; onSubmit?: () => void }) {
  return <View style={styles.form}>{children}</View>;
}

const styles = StyleSheet.create({ form: { gap: 12 } });
