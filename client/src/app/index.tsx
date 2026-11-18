import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { API_URL, fetchHello, helloContractName } from '@/data/hello';

type State = { status: 'loading' } | { status: 'ok'; message: string } | { status: 'error'; error: string };

export default function HelloScreen() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchHello({ name: 'Budget' })
      .then((r) => !cancelled && setState({ status: 'ok', message: r.message }))
      .catch((e: unknown) => !cancelled && setState({ status: 'error', error: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>
        {helloContractName} @ {API_URL}
      </Text>
      {state.status === 'loading' && <ActivityIndicator />}
      {state.status === 'ok' && <Text style={styles.message}>{state.message}</Text>}
      {state.status === 'error' && <Text style={styles.error}>{state.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  label: { fontSize: 13, opacity: 0.6 },
  message: { fontSize: 24, fontWeight: '600' },
  error: { fontSize: 16, color: '#b00020' },
});
