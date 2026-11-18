/**
 * An editable text draft over a server value (Plan month note). The draft
 * follows the server value whenever THAT changes (budget switch, notes
 * loading after mount, another device's edit), and is otherwise the user's.
 * budget-xd6: the month note kept the previous budget's text after a switch.
 */
export interface NoteDraft {
  /** What the text field shows. */
  draft: string;
  /** The server value the draft was last synced to. */
  saved: string;
}

export function noteDraft(saved: string): NoteDraft {
  return { draft: saved, saved };
}

/** Re-sync to `saved` if it changed since the last sync; same object otherwise. */
export function syncNoteDraft(state: NoteDraft, saved: string): NoteDraft {
  return state.saved === saved ? state : { draft: saved, saved };
}
