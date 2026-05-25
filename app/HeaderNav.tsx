'use client';

// Context-aware header nav (client island — needs the current path).
// On /admin → a back-to-app button. Elsewhere → the apex back-link.
// The canonical cross-app pattern; appName labels the back-to-app button
// per service. The Admin entry point now lives in the footer, not the header.

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
    <a href="https://zeroindex.ai" className="btn-primary">
      <span aria-hidden="true">&larr;</span>
      zeroindex.ai
    </a>
  );
}
