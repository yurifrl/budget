/**
 * pickImportFile — platform adapter for choosing an import file (CSV, TXT,
 * XLS/XLSX) shared by the budget and health importers.
 *
 * Web: a transient hidden `<input type="file">`; native: expo-document-picker.
 * Returns the file's raw bytes plus UTF-8 text plus display metadata, or null
 * when the user cancels. Reading is centralized here so screens only deal
 * with parsed data.
 */

import { Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

/** A picked statement file, fully read. */
export interface PickedImportFile {
  /** Base name for display ("extrato.xls"); the domain layer dispatches on it. */
  name: string;
  /** Raw file bytes — XLS is binary and cannot be decoded as text. */
  bytes: Uint8Array;
  /** UTF-8 file text (text formats; empty for XLS picked on native). */
  text: string;
}

/** Extensions whose content is binary XLS and must be read as bytes. */
const XLS_EXTENSIONS = ['.xls', '.xlsx'];

/**
 * Acceptable content: the statement extensions plus their usual MIME/UTI
 * spellings. Binary `.xls` has no standard UTI, so the catch-all `public.data`
 * keeps it selectable on iOS.
 */
const PICKER_TYPES = [
  'text/csv',
  'text/comma-separated-values',
  'text/tab-separated-values',
  'text/plain',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'public.plain-text',
  'public.data',
];

const WEB_ACCEPT = ['.csv', '.txt', ...XLS_EXTENSIONS, ...PICKER_TYPES].join(',');

/** Optional restriction of the file chooser (see `pickImportFile`). */
export interface PickImportFileTypes {
  /** Native (expo-document-picker) MIME/UTI strings. */
  pickerTypes?: string[];
  /** Web `accept` items (extensions and/or MIME types, comma-joined). */
  webAccept?: string[];
}

async function pickWeb(webAccept?: string[]): Promise<PickedImportFile | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = webAccept?.join(',') ?? WEB_ACCEPT;
  input.style.display = 'none';
  document.body.appendChild(input);
  try {
    const { promise, resolve } = Promise.withResolvers<FileList | null>();
    input.onchange = () => resolve(input.files);
    input.oncancel = () => resolve(null);
    input.click();
    const files = await promise;
    const file = files?.[0];
    if (!file) return null;
    const [bytes, text] = await Promise.all([file.arrayBuffer(), file.text()]);
    return { name: file.name, bytes: new Uint8Array(bytes), text };
  } finally {
    input.remove();
  }
}

async function pickNative(pickerTypes?: string[]): Promise<PickedImportFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: pickerTypes ?? PICKER_TYPES,
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  if (XLS_EXTENSIONS.some((ext) => asset.name.toLowerCase().endsWith(ext))) {
    // XLS workbooks are binary BIFF8; reading them as UTF-8 would corrupt
    // them. The picker copies the file to the cache, so fetching the file://
    // URI yields the bytes on both platforms.
    const response = await fetch(asset.uri);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { name: asset.name, bytes, text: '' };
  }
  // Statement import consumes `text`; backup import consumes `bytes`. Both
  // come from the cache copy, so read them together.
  const [bytes, text] = await Promise.all([
    fetch(asset.uri).then((r) => r.arrayBuffer()),
    FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.UTF8,
    }),
  ]);
  return { name: asset.name, bytes: new Uint8Array(bytes), text };
}

/** Open the platform file chooser; null = user cancelled. */
export async function pickImportFile(types: PickImportFileTypes = {}): Promise<PickedImportFile | null> {
  return Platform.OS === 'web' ? pickWeb(types.webAccept) : pickNative(types.pickerTypes);
}
