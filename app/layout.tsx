import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { HeaderNav } from './HeaderNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Repo X-Ray · ZeroIndex',
  description:
    'Point an agent at a public GitHub repo and get a cited onboarding report — every claim linked to the exact lines.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        {/* /favicon.ico is auto-served + auto-linked by Next.js from app/favicon.ico */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48x48.png" />
        <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />
        <link rel="apple-touch-icon" href="/favicon-180x180.png" />
      </head>
      <body className="min-h-screen flex flex-col">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>

        <header className="site-header sticky top-0 z-30">
          <div className="max-w-6xl mx-auto px-6 md:px-10">
            <div className="py-5 flex items-center justify-between border-b line">
              <a href="https://zeroindex.ai" className="brand-link" aria-label="ZeroIndex home">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="4 0 24 32"
                  width="27"
                  height="36"
                  aria-hidden="true"
                >
                  <path
                    d="M185 -110V830H465V715H310V5H465V-110Z"
                    fill="#3f3f46"
                    transform="translate(1 23.2) scale(0.02 -0.02)"
                  />
                  <path
                    d="M300 -10Q229 -10 177.0 17.0Q125 44 96.5 93.0Q68 142 68 208V522Q68 588 96.5 637.0Q125 686 177.0 713.0Q229 740 300 740Q371 740 423.0 713.0Q475 686 503.5 637.0Q532 588 532 522V208Q532 142 503.5 93.0Q475 44 423.0 17.0Q371 -10 300 -10ZM186 522V288L410 554Q401 590 372.0 611.0Q343 632 300 632Q247 632 216.5 602.0Q186 572 186 522ZM300 98Q352 98 383.0 128.0Q414 158 414 208V442L190 176Q199 140 228.0 119.0Q257 98 300 98Z"
                    fill="#7c3aed"
                    transform="translate(10 23.2) scale(0.02 -0.02)"
                  />
                  <path
                    d="M135 -110V5H290V715H135V830H415V-110Z"
                    fill="#3f3f46"
                    transform="translate(19 23.2) scale(0.02 -0.02)"
                  />
                </svg>
                <span className="brand-name">ZeroIndex</span>
              </a>
              <HeaderNav appName="Repo X-Ray" />
            </div>
          </div>
        </header>

        <div className="max-w-6xl w-full mx-auto px-6 md:px-10 flex-1 flex flex-col">
          <main id="main-content" className="flex-1">
            {children}
          </main>

          <footer className="border-t line py-10 text-sm">
            <div className="muted flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
              <div className="mono">&copy; 2026 ZeroIndex LLC &middot; Pennsylvania</div>
              <div className="flex items-center gap-6">
                <a className="subtle" href="https://github.com/zeroindex-ai/repo-xray">
                  Source
                </a>
                <a className="subtle" href="https://zeroindex.ai">
                  zeroindex.ai
                </a>
              </div>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
