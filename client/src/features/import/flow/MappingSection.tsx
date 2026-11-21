import { Pressable, Text, View } from 'react-native';

import { Combobox } from '@/ui/combobox';

import type { ColumnKey } from '../parsers';
import { IndigoButton } from '@/ui/bits';
import { CheckRow } from './cells';
import { columnLabel, columnOptions, mappedSummary, pickedColumn } from './importFlow.logic';
import { t } from '../i18n';
import { parserMessage } from './parserMessages';
import { styles } from './styles';
import type { ImportFlow } from './useImportFlow';

/** Roles the mapper exposes; `amount` is the alternative to outflow+inflow. Labels resolve at read time. */
const COLUMN_ROLES: { key: ColumnKey; readonly label: string }[] = [
  { key: 'date', get label() { return t('mapping.roleDate'); } },
  { key: 'payee', get label() { return t('mapping.rolePayee'); } },
  { key: 'memo', get label() { return t('mapping.roleMemo'); } },
  { key: 'outflow', get label() { return t('mapping.roleOutflow'); } },
  { key: 'inflow', get label() { return t('mapping.roleInflow'); } },
  { key: 'amount', get label() { return t('mapping.roleAmount'); } },
];

const DELIMITERS: { value: string; readonly label: string }[] = [
  { value: ',', get label() { return t('mapping.delimiterComma'); } },
  { value: ';', get label() { return t('mapping.delimiterSemicolon'); } },
  { value: '\t', get label() { return t('mapping.delimiterTab'); } },
];

/** Column mapper for an unrecognized CSV layout, with a live parse summary. */
export function MappingSection({ flow }: { flow: ImportFlow }) {
  const { mapping, setMapping, columnCount, mappingNote, mapped, confirmMapping } = flow;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('mapping.title')}</Text>
      <View style={styles.mapRow}>
        <Text style={styles.mapLabel}>{t('mapping.delimiter')}</Text>
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
        label={t('mapping.firstRowHeader')}
        onToggle={() => setMapping({ ...mapping, headerRow: mapping.headerRow === 0 ? -1 : 0 })}
      />
      <CheckRow
        checked={mapping.chargePositive}
        label={t('mapping.chargesPositive')}
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
              placeholder={t('mapping.columnPlaceholder')}
              chevron
              accessibilityLabel={t('mapping.columnA11y', { role: label })}
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
              <Text style={styles.sectionTitle}>{t('mapping.issues')}</Text>
              {mapped.errors.slice(0, 5).map((line, i) => (
                <Text key={i} style={styles.errorText} numberOfLines={2}>
                  {parserMessage(line)}
                </Text>
              ))}
            </>
          ) : null}
        </>
      ) : null}
      <IndigoButton label={t('mapping.confirm')} onPress={confirmMapping} />
    </View>
  );
}
