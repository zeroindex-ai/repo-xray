// Server-safe formatting helpers for the admin views. (page.tsx has its own
// client-side usd() — these are for the server components under app/admin.)

/** ms-epoch → "YYYY-MM-DD HH:MM" UTC. Canonical admin timestamp across ZeroIndex. */
export function fmtTs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** micro-USD → "$0.4579". */
export function fmtUsd(microUsd: number | null | undefined): string {
  if (microUsd == null) return '—';
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

/** A duration in ms → "4.73s" / "830ms" / "—". */
export function fmtDuration(fromMs: number | null | undefined, toMs: number | null | undefined): string {
  if (fromMs == null || toMs == null) return '—';
  const d = toMs - fromMs;
  if (d < 0) return '—';
  return d >= 1000 ? `${(d / 1000).toFixed(2)}s` : `${d}ms`;
}
