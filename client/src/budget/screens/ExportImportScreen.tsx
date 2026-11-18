/**
 * Export / import budget page — backup out and back in.
 *
 * Export: builds the transfer zip ({@link buildTransferZip}: two TSV tables,
 * Plan + Register) and hands it to the platform share sheet (native) or a
 * direct download (web). Import: pick the two TSV tables separately — the Plan
 * file, then the Register file — parse them with {@link parseTransferFiles},
 * show a per-table summary and a destructive confirmation, then POST it to the
 * restore endpoint and show the counts written. The restore replaces every
 * budget-scoped table server-side and the `restoreBudget` mutation invalidates
 * all matching tags.
 */

import { useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { GhostButton, IndigoButton, OverlaySheet } from '../ui/bits';
import { colors } from '../ui/theme';
import { pickImportFile } from '@/platform/import/pickImportFile';
import type { PickedImportFile } from '@/platform/import/pickImportFile';
import { useBudgetModel } from '../model/useBudgetModel';
import { usePeople } from '../model/usePeople';
import { useRestoreBudgetMutation } from '../data/api';
import {
  buildTransferZip,
  parseTransferFiles,
  PLAN_SUFFIX,
  REGISTER_SUFFIX,
} from '../transfer/transfer';
import type { TransferPayload } from '../transfer/payload';
import { useBudgetShell } from './shell';

/** Payload table names shown in the import summary and restore result. */
const TABLE_LABELS: [keyof TransferPayload, string][] = [
  ['groups', 'group'],
  ['categories', 'category'],
  ['accounts', 'account'],
  ['transactions', 'transaction'],
  ['assignments', 'assignment'],
];

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

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

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importing, setImporting] = useState<'plan' | 'register' | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /** The two picked TSV tables; parsed only once both are present. */
  const [pickedPlan, setPickedPlan] = useState<PickedImportFile | null>(null);
  const [pickedRegister, setPickedRegister] = useState<PickedImportFile | null>(null);
  /** Parsed payload waiting for the destructive confirmation. */
  const [pending, setPending] = useState<TransferPayload | null>(null);
  const [pendingWarnings, setPendingWarnings] = useState<string[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restored, setRestored] = useState<Record<string, number> | null>(null);

  // A picker selection is one async unit; a cancel while a confirm sheet is
  // open must not clobber the pending payload, so guard by id.
  const pickSeq = useRef(0);

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
    setPending(null);
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
      if (!plan || !register) return; // waiting for the other table
      const result = parseTransferFiles([
        { name: plan.name, bytes: plan.bytes },
        { name: register.name, bytes: register.bytes },
      ], { people });
      if (result.errors.length > 0 || !result.payload) {
        setImportError(result.errors.join('\n') || 'not a readable backup pair');
        return;
      }
      setPendingWarnings(result.warnings);
      setPending(result.payload);
    } catch (err) {
      setImportError(apiErrorMessage(err, 'failed to read the file'));
    } finally {
      if (seq === pickSeq.current) setImporting(null);
    }
  };

  const confirmRestore = async () => {
    if (!model.budgetId || !pending) return;
    setRestoring(true);
    try {
      const counts = await restore({ budgetId: model.budgetId, payload: pending }).unwrap();
      setRestored(counts);
      setPending(null);
      setPendingWarnings([]);
      setPickedPlan(null);
      setPickedRegister(null);
    } catch (err) {
      setImportError(apiErrorMessage(err, 'restore failed'));
    } finally {
      setRestoring(false);
    }
  };

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
      <Text style={styles.hint}>
        Restores the two backup tables into this budget. Everything currently in it — categories,
        accounts, payees, transactions and assignments — is replaced.
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
      {importError ? <Text style={styles.errorText}>{importError}</Text> : null}
      {restored ? (
        <Text style={styles.doneText}>
          Restored {TABLE_LABELS.map(([key, noun]) => plural(restored[key] ?? 0, noun)).join(', ')}.
        </Text>
      ) : null}

      <OverlaySheet visible={pending != null} onClose={() => (restoring ? null : setPending(null))} title="Restore this backup?">
        {pending ? (
          <>
            <Text style={styles.confirmText}>
              This replaces everything currently in “{model.budget.name}” with the contents of the
              backup:
            </Text>
            {TABLE_LABELS.map(([key, noun]) => (
              <Text key={key} style={styles.confirmRow}>
                {plural(pending[key].length, noun)}
              </Text>
            ))}
            {pendingWarnings.length > 0 ? (
              pendingWarnings.map((w) => (
                <Text key={w} style={styles.warnText}>
                  {w}
                </Text>
              ))
            ) : null}
            <View style={styles.confirmRow2}>
              <IndigoButton
                label={restoring ? 'Restoring…' : 'Replace everything'}
                onPress={() => {
                  void confirmRestore();
                }}
              />
              <GhostButton label="Cancel" onPress={() => setPending(null)} />
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
  confirmText: { color: colors.text, fontSize: 13, lineHeight: 18, marginBottom: 4 },
  confirmRow: { color: colors.text, fontSize: 13, marginLeft: 8 },
  confirmRow2: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
});
