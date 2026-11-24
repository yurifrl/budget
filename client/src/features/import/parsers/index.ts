/**
 * Statement-import module — public surface.
 *
 * `parseStatementFile` routes a picked file by extension/content (Nubank
 * CSV, Itaú extrato TXT/XLS, generic CSV); the page (screens/
 * ImportScreen) handles file picking, unknown-layout mapping, review, and
 * persistence. Pure domain: no React, no expo, no fetch.
 */

export { parseCsv, sniffDelimiter } from './util/csv';
export { parseImportDate } from './util/date';
export { parseImportAmount } from './util/money';
export { parseImportCsv, parseMappedCsv } from './sources/generic-csv';
export {
  parseItauExtratoTxt,
  parseItauExtratoXls,
  parseItauFaturaXls,
} from './sources/itau';
export {
  detectNubankLayout,
  parseNubankCsv,
  type NubankLayout,
  type NubankRow,
} from './sources/nubank';
export {
  detectContabilizeiCsv,
  parseContabilizeiCsv,
  type ContabilizeiRow,
} from './sources/contabilizei';
export {
  STATEMENT_EXTENSIONS,
  parseStatementFile,
  type StatementData,
} from './sources/statement';
export type {
  ColumnKey,
  CsvMapping,
  ImportParseResult,
  ImportRow,
} from '@/domain/importTypes';
export {
  createImportMappingStore,
  emptyMapping,
  ImportMappingStoreToken,
  type ImportMappingStore,
} from './mapping-store';
export {
  assocRules,
  makeDraftRows,
  type DraftImportRow,
} from './assoc';
