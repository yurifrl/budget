export const StatusBadge = ({ status }: { status: string }) => <span className={`badge ${status}`}>{status}</span>;

export const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function duration(a: string | null, b: string | null): string {
  if (!a) return '—';
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
