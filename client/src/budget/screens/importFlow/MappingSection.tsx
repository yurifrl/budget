import { Pressable, Text, View } from 'react-native';

import { Combobox } from '@/ui/combobox';

import type { ColumnKey } from '../../import';
import { IndigoButton } from '../../ui/bits';
import { CheckRow } from './cells';
import { columnLabel, columnOptions, mappedSummary, pickedColumn } from './importFlow.logic';
import { styles } from './styles';
import type { ImportFlow } from './useImportFlow';

/** Roles the mapper exposes; `amount` is the alternative to outflow+inflow. */
const COLUMN_ROLES: { key: ColumnKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'payee', label: 'Payee' },
  { key: 'memo', label: 'Memo' },
  { key: 'outflow', label: 'Outflow' },
  { key: 'inflow', label: 'Inflow' },
  { key: 'amount', label: 'Amount (signed)' },
];

const DELIMITERS = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
];

/** Column mapper for an unrecognized CSV layout, with a live parse summary. */
export function MappingSection({ flow }: { flow: ImportFlow }) {
  const { mapping, setMapping, columnCount, mappingNote, mapped, confirmMapping } = flow;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Column mapping</Text>
      <View style={styles.mapRow}>
        <Text style={styles.mapLabel}>Delimiter</Text>
        <View style={styles.delimRow}>
          {DELIMITERS.map(({ value, label }) => (
            <Pressable
              key={value}
              onPress={() => setMapping({ ...mapping, delimiter: value })}
              style={[styles.delimBtn, mapping.delimiter === value && styles.delimBtnOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: mapping.delimiter === value }}>
              <Text style={[styles.delimLabel, mapping.delimiter === value && styles.delimLabelOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <CheckRow
        checked={mapping.headerRow === 0}
        label="First row is a header"
        onToggle={() => setMapping({ ...mapping, headerRow: mapping.headerRow === 0 ? -1 : 0 })}
      />
      <CheckRow
        checked={mapping.chargePositive}
        label="Charges are positive (invert amounts)"
        onToggle={() => setMapping({ ...mapping, chargePositive: !mapping.chargePositive })}
      />
      {COLUMN_ROLES.map(({ key, label }) => (
        <View key={key} style={styles.mapRow}>
          <Text style={styles.mapLabel}>{label}</Text>
          <View style={styles.mapPicker}>
            <Combobox
              value={columnLabel(mapping.columns[key])}
              onChangeText={() => {}}
              onPick={(col) => setMapping({ ...mapping, columns: { ...mapping.columns, [key]: pickedColumn(col) } })}
              options={columnOptions(columnCount)}
              placeholder="Column…"
              chevron
              accessibilityLabel={`${label} column`}
            />
          </View>
        </View>
      ))}
      {mappingNote ? <Text style={styles.mappingNote}>{mappingNote}</Text> : null}
      {mapped ? (
        <>
          <Text style={styles.parseSummary}>{mappedSummary(mapped)}</Text>
          {mapped.errors.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>Issues</Text>
              {mapped.errors.slice(0, 5).map((line, i) => (
                <Text key={i} style={styles.errorText} numberOfLines={2}>
                  {line}
                </Text>
              ))}
            </>
          ) : null}
        </>
      ) : null}
      <IndigoButton label="Looks good — review rows" onPress={confirmMapping} />
    </View>
  );
}
