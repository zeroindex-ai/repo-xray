'use client';

// Re-run a sample ("Try") repo at its current HEAD (client island — admin pages
// are server components). Samples are served sticky-by-repo and never auto-refresh;
// this re-seeds them. The run is long (30–60s), so we tick an elapsed clock and
// refresh the page on success to show the new latest. Posts to /admin/resample,
// which is behind the same Basic-auth gate as this page.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type State = 'idle' | 'running' | 'done' | 'error';

export function ResampleButton({ repo }: { repo: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>('idle');
  const [msg, setMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (state !== 'running') return;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 500);
    return () => clearInterval(id);
  }, [state]);

  async function run() {
    if (state === 'running') return;
    setState('running');
    setMsg('');
    setElapsed(0);
    startRef.current = Date.now();
    try {
      const res = await fetch('/admin/resample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo }),
      });
      const data = (await res.json()) as { error?: string; cached?: boolean; costMicroUsd?: number };
      if (!res.ok) throw new Error(data.error ?? `Failed (${res.status})`);
      setState('done');
      setMsg(
        data.cached
          ? 'Already current (HEAD unchanged)'
          : `Refreshed · $${((data.costMicroUsd ?? 0) / 1_000_000).toFixed(4)}`
      );
      router.refresh(); // re-render the server component with the new latest row
    } catch (e) {
      setState('error');
      setMsg((e as Error).message);
    }
  }

  return (
    <span className="resample">
      <button type="button" className="copy-btn" onClick={run} disabled={state === 'running'}>
        {state === 'running' ? `Re-running… ${elapsed}s` : 'Re-run'}
      </button>
      {msg && (
        <span className={`resample-msg ${state === 'error' ? 'is-error' : ''}`} aria-live="polite">
          {msg}
        </span>
      )}
    </span>
  );
}
