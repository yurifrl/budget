/** Editable cells of the import review table (and the mapper's check rows). */

import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Combobox } from '@/ui/combobox';

import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { styles } from './styles';

/** Small square toggle used for the mapper options and row inclusion. */
export function CheckRow({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label?: string;
  onToggle: () => void;
}) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={styles.checkRow}>
      <View style={[styles.checkBox, checked && styles.checkBoxOn]}>
        {checked ? <Text style={styles.checkMark}>✓</Text> : null}
      </View>
      {label ? <Text style={styles.checkLabel}>{label}</Text> : null}
    </Pressable>
  );
}

/**
 * Editable date cell — ISO display while idle, partial date entry
 * (DD, DD/MM, DD/MM/YYYY) committed on blur/Enter; invalid input reverts.
 */
export function DateCell({ value, onCommit }: { value: string; onCommit: (iso: string) => void }) {
  const { formatDate, parseDateInput } = useMoneyFormat();
  const [text, setText] = useState<string | null>(null);
  return (
    <TextInput
      value={text ?? formatDate(value)}
      onChangeText={setText}
      onEndEditing={() => {
        const raw = text;
        setText(null);
        if (raw == null) return;
        const parsed = parseDateInput(raw.trim());
        if (parsed && parsed !== value) onCommit(parsed);
      }}
      style={styles.cellInput}
      accessibilityLabel="Transaction date"
    />
  );
}

/** Editable memo cell — commits on blur/Enter, trims whitespace. */
export function MemoCell({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <TextInput
      value={text ?? value}
      onChangeText={setText}
      onEndEditing={() => {
        const raw = text;
        setText(null);
        if (raw == null) return;
        const next = raw.trim();
        if (next !== value) onCommit(next);
      }}
      style={styles.cellInput}
      accessibilityLabel="Transaction memo"
    />
  );
}

/**
 * Payee editor with a permanent ✕. A row associated with a budget payee shows
 * the payee's name as pure text; an unassociated row is a searchable payee
 * list whose create fallback keeps the typed statement text (the import
 * upserts it). In both states the ✕ returns the field to the original
 * statement text and drops the association.
 */
export function PayeeCell({
  display,
  original,
  bound,
  options,
  onChange,
}: {
  /** Payee's name when bound, else the raw statement text. */
  display: string;
  /** Statement text at parse time — the ✕ reset target. */
  original: string;
  /** true = associated with a budget payee: pure text, not inline-editable. */
  bound: boolean;
  options: { key: string; label: string }[];
  onChange: (patch: { payee?: string; payeeId?: string | null }) => void;
}) {
  const reset = () => onChange({ payee: original, payeeId: null });
  const unbind = (
    <Pressable
      accessibilityLabel="Return payee to original statement text"
      onPress={reset}
      style={styles.payeeUnbind}
    >
      <Text style={styles.payeeUnbindGlyph}>✕</Text>
    </Pressable>
  );
  if (bound) {
    return (
      <View style={styles.payeeBound}>
        <Text style={styles.payeeBoundName} numberOfLines={1}>
          {display}
        </Text>
        {unbind}
      </View>
    );
  }
  return (
    <View style={styles.payeeBound}>
      <Combobox
        value={display}
        onChangeText={(text) => onChange({ payee: text, payeeId: null })}
        onPick={(key) => onChange({ payeeId: key })}
        onCreate={(query) => onChange({ payee: query, payeeId: null })}
        options={options}
        placeholder="Payee…"
        style={styles.payeeInput}
        containerStyle={styles.payeeEditorField}
        accessibilityLabel="Transaction payee"
      />
      {unbind}
    </View>
  );
}
