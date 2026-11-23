/**
 * Native "copy": the app ships no clipboard module, so the text goes to the
 * system share sheet (which offers Copy, and AirDrop / Notes / Files).
 * Resolves false: nothing was copied by us, so no "Copied" mark.
 */
import { Share } from 'react-native';

export async function copyText(text: string): Promise<boolean> {
  try {
    await Share.share({ message: text });
  } catch {
    // Dismissed or unavailable: nothing to report.
  }
  return false;
}
