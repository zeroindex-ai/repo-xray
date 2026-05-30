'use client';

// Context-aware header nav (client island — needs the current path).
// On /admin → a back-to-app button. Elsewhere → a "Work with ZeroIndex" CTA → intake.
// This app is a standalone product surface, so the header converts (→ intake)
// rather than pointing "back" — the brand logo (left) is the path home. Intake
// opens in a NEW TAB so the product stays open behind it (otherwise the visitor
// lands on intake, whose own back-link only goes to the apex — stranding them
// away from the product they were trying). Satellite apps (traces/evals/intake)
// keep the apex back-link instead; see the zeroindex-app-layout skill. The Admin
// entry point lives in the footer.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function HeaderNav({ appName }: { appName: string }) {
  const pathname = usePathname();
  const onAdmin = pathname === '/admin' || pathname.startsWith('/admin/');

  if (onAdmin) {
    return (
      <Link href="/" className="btn-primary">
        <span aria-hidden="true">&larr;</span>
        {appName}
      </Link>
    );
  }

  return (
    <a href="https://intake.zeroindex.ai" target="_blank" rel="noopener" className="btn-primary">
      Work with ZeroIndex
    </a>
  );
}
