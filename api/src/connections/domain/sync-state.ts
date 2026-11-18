/** User-facing sync state of one connection. Pure — unit-tested as a table. */
export type SyncState =
  | 'connected'
  | 'syncing'
  | 'queued'
  | 'queued_offline'
  | 'reconnect'
  | 'quota'
  | 'error'
  | 'disconnected';

export function deriveSyncState(input: {
  /** connections.status */
  status: string;
  /** Status of the active (queued/running) run, if any. */
  activeRun: 'queued' | 'running' | null;
  schedulerDegraded: boolean;
}): SyncState {
  if (input.status === 'disconnected') return 'disconnected';
  if (input.activeRun === 'running') return 'syncing';
  if (input.activeRun === 'queued') return input.schedulerDegraded ? 'queued_offline' : 'queued';
  switch (input.status) {
    case 'unauthorized':
      return 'reconnect';
    case 'quota_exhausted':
      return 'quota';
    case 'error':
      return 'error';
    default:
      return 'connected';
  }
}
