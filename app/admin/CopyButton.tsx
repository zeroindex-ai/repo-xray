'use client';

// Copy-to-clipboard button (client island — admin pages are server components).
// Lives in the section header, not over the scroll frame, so it never overlaps
// the report's scrollbar.

import { useState } from 'react';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (e.g. non-secure context) — no-op */
    }
  }

  return (
    <button type="button" className="copy-btn" onClick={copy} aria-live="polite">
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
