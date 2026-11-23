/**
 * "Bank data": every field of the provider's raw transaction object as an
 * indented key/value tree (nested objects and arrays expanded; null, empty
 * strings and empty containers shown), plus Copy JSON. Keys and values are
 * data, shown as received.
 */
import { Text, View } from 'react-native';

import { CopyButton, Section } from './DetailSections';
import { t } from './i18n';
import { styles } from './styles';
import { containerSummary, rawJson, rawLines, type RawLine } from './transactionDetail.logic';

const INDENT = 14;

function valueStyle(kind: RawLine['kind']) {
  if (kind === 'null') return styles.rawNull;
  if (kind === 'number') return styles.rawNumber;
  if (kind === 'boolean') return styles.rawBool;
  return null;
}

export function RawDataTree({ value }: { value: Record<string, unknown> }) {
  const lines = rawLines(value);
  if (lines.length === 0) return <Text style={styles.rawSummary}>{'{}'}</Text>;
  return (
    <View>
      {lines.map((line, i) => (
        <View key={`${i}:${line.path}`} style={[styles.rawLine, { paddingLeft: line.depth * INDENT }]}>
          {line.key !== null ? (
            <Text selectable style={styles.rawKey}>
              {line.key}
            </Text>
          ) : null}
          {line.kind === 'object' || line.kind === 'array' ? (
            <Text style={styles.rawSummary}>{containerSummary(line)}</Text>
          ) : (
            <Text selectable style={[styles.rawValue, valueStyle(line.kind)]}>
              {line.value}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

/** A titled card holding one JSON object, with Copy JSON. */
export function JsonSection({ title, value }: { title: string; value: Record<string, unknown> }) {
  return (
    <Section title={title} action={<CopyButton label={t('copy.json')} text={rawJson(value)} />}>
      <RawDataTree value={value} />
    </Section>
  );
}
