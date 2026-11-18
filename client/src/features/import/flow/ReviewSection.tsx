import { Text, View } from 'react-native';

import type { DraftImportRow } from '../parsers';
import { AmountCell, GhostButton, IndigoButton } from '@/ui/bits';
import { CheckRow, DateCell, MemoCell, PayeeCell } from './cells';
import { importButtonLabel, importedSummary, payeeDisplay, rulesHeading, selectionSummary } from './importFlow.logic';
import { styles } from './styles';
import type { ImportFlow } from './useImportFlow';

/**
 * Review step: the paginated, editable table of parsed rows, the pending
 * payee associations, and the import button (or the result once imported).
 */
export function ReviewSection({ flow, drafts }: { flow: ImportFlow; drafts: DraftImportRow[] }) {
  const {
    included,
    setAllIncluded,
    pageRows,
    pageOffset,
    pageCount,
    safePage,
    setPage,
    patchDraft,
    payeeById,
    payeeOptions,
    rules,
    imported,
    resetReview,
    runImport,
  } = flow;
  return (
    <View style={styles.section}>
      <View style={styles.summaryRow}>
        <Text style={styles.parseSummary}>{selectionSummary(included.length, drafts.length)}</Text>
        <GhostButton label="Deselect all" onPress={() => setAllIncluded(false)} />
        <GhostButton label="Select all" onPress={() => setAllIncluded(true)} />
      </View>

      {/* Register parity (AccountsScreen reghd): uppercase faint labels
          between border rules; column flex weights match the register. */}
      <View style={styles.tableHead}>
        <View style={styles.checkCell} />
        <Text style={[styles.thCell, styles.colDate]}>DATE</Text>
        <Text style={[styles.thCell, styles.colPayee]}>PAYEE</Text>
        <Text style={[styles.thCell, styles.colMemo]}>MEMO</Text>
        <Text style={[styles.thCell, styles.colAmount]}>AMOUNT</Text>
      </View>

      {pageRows.map((row, i) => {
        const index = pageOffset + i;
        return (
          <View key={index} style={[styles.row, !row.included && styles.rowExcluded]}>
            <View style={styles.checkCell}>
              <CheckRow checked={row.included} onToggle={() => patchDraft(index, { included: !row.included })} />
            </View>
            <View style={styles.colDate}>
              <DateCell value={row.date} onCommit={(iso) => patchDraft(index, { date: iso })} />
            </View>
            <View style={styles.colPayee}>
              <PayeeCell
                display={payeeDisplay(row, payeeById)}
                original={row.originalPayee}
                bound={row.payeeId != null}
                options={payeeOptions}
                onChange={(patch) => patchDraft(index, patch)}
              />
            </View>
            <View style={styles.colMemo}>
              <MemoCell value={row.memo} onCommit={(memo) => patchDraft(index, { memo })} />
            </View>
            <View style={styles.colAmount}>
              <AmountCell
                outflowCents={row.outflowCents}
                inflowCents={row.inflowCents}
                onChange={(patch) => patchDraft(index, patch)}
              />
            </View>
          </View>
        );
      })}

      {pageCount > 1 ? (
        <View style={styles.pager}>
          <GhostButton
            label="‹ Prev"
            onPress={() => setPage(safePage - 1)}
            style={safePage === 0 ? { opacity: 0.4 } : undefined}
          />
          <Text style={styles.pageLabel}>
            Page {safePage + 1} of {pageCount}
          </Text>
          <GhostButton
            label="Next ›"
            onPress={() => setPage(safePage + 1)}
            style={safePage >= pageCount - 1 ? { opacity: 0.4 } : undefined}
          />
        </View>
      ) : null}

      {rules.length > 0 ? (
        <View style={styles.rulesNote}>
          <Text style={styles.rulesTitle}>{rulesHeading(rules.length)}</Text>
          {rules.slice(0, 4).map((rule) => (
            <Text key={rule.condition} style={styles.rulesLine} numberOfLines={1}>
              “{rule.condition}” → {rule.replacement}
            </Text>
          ))}
          {rules.length > 4 ? <Text style={styles.rulesLine}>… and {rules.length - 4} more</Text> : null}
        </View>
      ) : null}

      {imported != null ? (
        <>
          <Text style={styles.doneText}>{importedSummary(imported, rules.length)}</Text>
          <GhostButton label="Import another file" onPress={resetReview} />
        </>
      ) : (
        <IndigoButton
          label={importButtonLabel(included.length)}
          onPress={() => void runImport()}
        />
      )}
    </View>
  );
}
