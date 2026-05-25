'use client';

// Context-aware header nav (client island — needs the current path).
// On /admin → a back-to-app button. Elsewhere → an Admin shortcut + the apex
// back-link. The canonical cross-app pattern; appName labels the back-to-app
// button per service.

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
    <div className="flex items-center gap-3">
      <Link href="/admin" className="btn-ghost">
        Admin
      </Link>
      <a href="https://zeroindex.ai" className="btn-primary">
        <span aria-hidden="true">&larr;</span>
        zeroindex.ai
      </a>
    </div>
  );
}
