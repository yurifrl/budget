/**
 * Export / import budget page — backup out and back in.
 *
 * Export: builds the transfer zip ({@link buildTransferZip}: two TSV tables,
 * Plan + Register) and hands it to the platform share sheet (native) or a
 * direct download (web). Import: pick the Plan table, the Register table or
 * both (loose TSVs), parse what was picked with {@link parseTransferFiles},
 * show which sections the backup contains and let the user choose which to
 * restore (see importScope.logic.ts for how the two depend on each other), then
 * a destructive confirmation, then POST it to the restore endpoint with the
 * chosen `sections` and show the counts written. The `restoreBudget` mutation
 * invalidates all matching tags.
 */

import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { GhostButton, IndigoButton, OverlaySheet } from '@/ui/bits';
import { colors } from '@/ui/theme';
import { pickImportFile } from '@/platform/import/pickImportFile';
import type { PickedImportFile } from '@/platform/import/pickImportFile';
import { useBudgetModel } from '@/state/useBudgetModel';
import { usePeople } from '@/features/people';
import { useGetBudgetsQuery, useRestoreBudgetMutation } from '@/budget/data/api';
import {
  buildTransferZip,
  parseTransferFiles,
  PLAN_SUFFIX,
  REGISTER_SUFFIX,
} from './transfer/transfer';
import type { TransferPayload } from './transfer/payload';
import {
  countUnmatchedCategories,
  dependencyNote,
  orderSections,
  plural,
  replaceDescription,
  scopedPayload,
  SECTION_LABELS,
  sectionCountsText,
  toggleSection,
  wireSections,
} from './importScope.logic';
import type { BackupSection } from './importScope.logic';
import { useBudgetShell } from '@/shell/context';

/** Payload table names shown in the import summary and restore result. */
const TABLE_LABELS: [keyof TransferPayload, string][] = [
  ['groups', 'group'],
  ['categories', 'category'],
  ['accounts', 'account'],
  ['transactions', 'transaction'],
  ['assignments', 'assignment'],
];

/**
 * Acceptable import content: the two loose TSV tables only — the zip archive is
 * export-only (unzip it first). `text/plain` keeps `.tsv` selectable on iOS,
 * which has no UTI for it; `application/octet-stream` covers Android generic
 * pickers.
 */
const TSV_PICKER_TYPES = [
  'text/tab-separated-values',
  'text/plain',
  'application/octet-stream',
];
const TSV_WEB_ACCEPT = ['.tsv', ...TSV_PICKER_TYPES];

/**
 * Encode zip bytes as base64 for the native cache write. btoa is only
 * available on web/native-webview contexts, so chunk the bytes to keep a
 * single call under the engine's string-length comfort zone.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Hand the export to the platform: share sheet on native, download on web. */
async function deliverExport(zipName: string, bytes: Uint8Array): Promise<void> {
  if (Platform.OS === 'web') {
    const blob = new Blob([bytes.slice().buffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = zipName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return;
  }
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) throw new Error('no cache directory available');
  const fileUri = `${cacheDir}${encodeURIComponent(zipName)}`;
  await FileSystem.writeAsStringAsync(fileUri, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  await Sharing.shareAsync(fileUri, { mimeType: 'application/zip', UTI: 'public.zip-archive' });
}

/**
 * Export / import page. Renders nothing useful before a budget exists; the
 * shell only routes here once a budget is active.
 */
export function ExportImportScreen() {
  const shell = useBudgetShell();
  const model = useBudgetModel();
  // Persons travel by email (ids aren't portable) and resolve against these members on import.
  const { people } = usePeople(model.budgetId);
  const [restore] = useRestoreBudgetMutation();
  // Restoring replaces the whole budget: the owner's call (the API refuses anyone else).
  const isOwner = useGetBudgetsQuery().data?.find((b) => b.id === model.budgetId)?.is_owner === true;

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importing, setImporting] = useState<'plan' | 'register' | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /** The two picked TSV tables; parsed only once both are present. */
  const [pickedPlan, setPickedPlan] = useState<PickedImportFile | null>(null);
  const [pickedRegister, setPickedRegister] = useState<PickedImportFile | null>(null);
  /** Parsed payload waiting for the destructive confirmation. */
  const [parsed, setParsed] = useState<{ payload: TransferPayload; available: BackupSection[] } | null>(null);
  /** Sections the user ticked (subset of parsed.available). */
  const [selected, setSelected] = useState<BackupSection[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [pendingWarnings, setPendingWarnings] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<Record<string, number | undefined> | null>(null);

  // A picker selection is one async unit; a cancel while a confirm sheet is
  // open must not clobber the pending payload, so guard by id.
  const pickSeq = useRef(0);

  /** The budget's own categories (group + name): what a Register-only import matches against. */
  const existingCategories = useMemo(() => {
    const groupName = new Map((model.budget?.groups ?? []).map((g) => [g.id, g.name]));
    return (model.budget?.categories ?? []).map((c) => ({ group: groupName.get(c.groupId) ?? '', name: c.name }));
  }, [model.budget]);

  const doExport = async () => {
    if (!model.budget || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { zipName, bytes } = buildTransferZip(model.budget, { people });
      await deliverExport(zipName, bytes);
    } catch (err) {
      setExportError(apiErrorMessage(err, 'export failed'));
    } finally {
      setExporting(false);
    }
  };

  const doPick = async (kind: 'plan' | 'register') => {
    if (importing) return;
    const seq = ++pickSeq.current;
    setImporting(kind);
    setImportError(null);
    setRestored(null);
    setParsed(null);
    setConfirming(false);
    setPendingWarnings([]);
    try {
      const picked = await pickImportFile({ webAccept: TSV_WEB_ACCEPT, pickerTypes: TSV_PICKER_TYPES });
      if (seq !== pickSeq.current) return;
      if (!picked) return;
      const suffix = kind === 'plan' ? PLAN_SUFFIX : REGISTER_SUFFIX;
      const noun = kind === 'plan' ? 'Plan' : 'Register';
      if (!picked.name.endsWith(suffix)) {
        setImportError(
          `${picked.name}: not the ${noun} table — expected a file whose name ends in “${suffix}”`,
        );
        return;
      }
      const plan = kind === 'plan' ? picked : pickedPlan;
      const register = kind === 'register' ? picked : pickedRegister;
      if (kind === 'plan') setPickedPlan(picked);
      else setPickedRegister(picked);
      const files = [plan, register]
        .filter((f): f is PickedImportFile => f !== null)
        .map((f) => ({ name: f.name, bytes: f.bytes }));
      const result = parseTransferFiles(files, { people, existingCategories });
      if (result.errors.length > 0 || !result.payload) {
        setImportError(result.errors.join('\n') || 'not a readable backup');
        return;
      }
      setPendingWarnings(result.warnings);
      const available = orderSections(result.sections ?? []);
      setParsed({ payload: result.payload, available });
      setSelected(available);
    } catch (err) {
      setImportError(apiErrorMessage(err, 'failed to read the file'));
    } finally {
      if (seq === pickSeq.current) setImporting(null);
    }
  };

  const confirmRestore = async () => {
    if (!model.budgetId || !parsed || selected.length === 0) return;
    setRestoring(true);
    try {
      const counts = await restore({
        budgetId: model.budgetId,
        payload: scopedPayload(parsed.payload, selected),
        sections: wireSections(selected),
      }).unwrap();
      setRestored(counts);
      setParsed(null);
      setConfirming(false);
      setPendingWarnings([]);
      setPickedPlan(null);
      setPickedRegister(null);
    } catch (err) {
      setImportError(apiErrorMessage(err, 'restore failed'));
    } finally {
      setRestoring(false);
    }
  };

  const unmatchedCategories = parsed ? countUnmatchedCategories(parsed.payload, existingCategories) : 0;

  if (!model.budgetId || !model.budget) {
    return (
      <View style={styles.screen}>
        <Text style={styles.hint}>Activate a budget to export or restore it.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}
    >
      <Text style={styles.sectionTitle}>Export</Text>
      <Text style={styles.hint}>
        Saves the whole budget — category plan and transaction register — as a zip archive with two
        TSV tables, shareable from this device.
      </Text>
      <View style={styles.actionRow}>
        <IndigoButton label={exporting ? 'Preparing…' : 'Export backup'} onPress={doExport} />
      </View>
      {exportError ? <Text style={styles.errorText}>{exportError}</Text> : null}

      <Text style={styles.sectionTitle}>Import</Text>
      {!isOwner ? (
        <Text style={styles.hint}>Only the owner of this budget can restore a backup into it.</Text>
      ) : null}
      {isOwner ? (
      <>
      <Text style={styles.hint}>
        Restores backup tables into this budget. Choose the Plan file, the Register file or both,
        then pick which parts to restore: the plan (categories, assignments) and/or the register
        (accounts, transactions). Whatever you restore replaces what is currently in the budget.
      </Text>
      <View style={styles.pickRow}>
        <GhostButton
          label={
            importing === 'plan' ? 'Reading…' : pickedPlan ? 'Choose again…' : 'Choose Plan file…'
          }
          onPress={() => {
            void doPick('plan');
          }}
        />
        <Text style={styles.pickName} numberOfLines={1}>
          {pickedPlan ? pickedPlan.name : 'no file chosen'}
        </Text>
      </View>
      <View style={styles.pickRow}>
        <GhostButton
          label={
            importing === 'register'
              ? 'Reading…'
              : pickedRegister
                ? 'Choose again…'
                : 'Choose Register file…'
          }
          onPress={() => {
            void doPick('register');
          }}
        />
        <Text style={styles.pickName} numberOfLines={1}>
          {pickedRegister ? pickedRegister.name : 'no file chosen'}
        </Text>
      </View>
      </>
      ) : null}
      {importError ? <Text style={styles.errorText}>{importError}</Text> : null}
      {restored ? (
        <Text style={styles.doneText}>
          Restored {TABLE_LABELS.filter(([key]) => (restored[key] ?? 0) > 0).map(([key, noun]) => plural(restored[key] ?? 0, noun)).join(', ') || 'nothing'}.
          {(restored.uncategorized ?? 0) > 0
            ? ` ${plural(restored.uncategorized ?? 0, 'transaction')} had no matching category and stayed uncategorized.`
            : ''}
        </Text>
      ) : null}

      {parsed ? (
        <View style={styles.scopeCard}>
          <Text style={styles.sectionTitle}>This backup contains</Text>
          {(['plan', 'register'] as const).map((section) => {
            const present = parsed.available.includes(section);
            const checked = selected.includes(section);
            return (
              <Pressable
                key={section}
                disabled={!present}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: !present }}
                onPress={() => setSelected(toggleSection(selected, section, parsed.available))}
                style={[styles.scopeRow, !present && styles.scopeRowOff]}
              >
                <View style={[styles.box, checked && styles.boxOn]}>
                  {checked ? <Text style={styles.tick}>✓</Text> : null}
                </View>
                <View style={styles.scopeText}>
                  <Text style={styles.scopeTitle}>{SECTION_LABELS[section]}</Text>
                  <Text style={styles.hint}>
                    {present ? sectionCountsText(parsed.payload, section) : 'not in the chosen file(s)'}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          <View style={styles.actionRow}>
            <IndigoButton
              label={selected.length === 0 ? 'Choose what to restore' : 'Restore selected…'}
              onPress={() => {
                if (selected.length > 0) setConfirming(true);
              }}
            />
          </View>
        </View>
      ) : null}

      <OverlaySheet visible={confirming && parsed != null} onClose={() => (restoring ? null : setConfirming(false))} title="Restore this backup?">
        {parsed ? (
          <>
            <Text style={styles.confirmText}>
              This replaces {replaceDescription(selected)} in “{model.budget.name}” with:
            </Text>
            {selected.map((section) => (
              <Text key={section} style={styles.confirmRow}>
                {SECTION_LABELS[section]}: {sectionCountsText(parsed.payload, section)}
              </Text>
            ))}
            {dependencyNote(selected) ? <Text style={styles.hint}>{dependencyNote(selected)}</Text> : null}
            {selected.length === 1 && selected[0] === 'register' && unmatchedCategories > 0 ? (
              <Text style={styles.warnText}>
                {plural(unmatchedCategories, 'transaction')} name a category this budget does not have and will be uncategorized.
              </Text>
            ) : null}
            {pendingWarnings.length > 0 ? (
              pendingWarnings.map((w) => (
                <Text key={w} style={styles.warnText}>
                  {w}
                </Text>
              ))
            ) : null}
            <View style={styles.confirmRow2}>
              <IndigoButton
                label={restoring ? 'Restoring…' : 'Replace'}
                onPress={() => {
                  void confirmRestore();
                }}
              />
              <GhostButton label="Cancel" onPress={() => setConfirming(false)} />
            </View>
          </>
        ) : null}
      </OverlaySheet>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 16, gap: 10, maxWidth: 720, width: '100%', alignSelf: 'center' },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 8 },
  hint: { color: colors.faint, fontSize: 12, lineHeight: 17 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2, flexWrap: 'wrap' },
  pickName: { color: colors.faint, fontSize: 12, flexShrink: 1, maxWidth: 320 },
  errorText: { color: colors.redFg, fontSize: 12 },
  warnText: { color: colors.redFg, fontSize: 12 },
  doneText: { color: colors.greenPillFg, fontSize: 12 },
  scopeCard: { gap: 8, backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12 },
  scopeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  scopeRowOff: { opacity: 0.45 },
  scopeText: { flexShrink: 1 },
  scopeTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  box: { width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.border2, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  tick: { color: colors.text, fontSize: 12, lineHeight: 14, fontWeight: '700' },
  confirmText: { color: colors.text, fontSize: 13, lineHeight: 18, marginBottom: 4 },
  confirmRow: { color: colors.text, fontSize: 13, marginLeft: 8 },
  confirmRow2: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
});
