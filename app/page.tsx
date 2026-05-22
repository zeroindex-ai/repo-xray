export const dynamic = 'force-dynamic';

export default function HomePage() {
  return (
    <>
      <section className="pt-10 pb-8">
        <div className="label mb-3">Repo X-Ray</div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Repo X-Ray.</h1>
        <p className="mt-4 muted text-base leading-relaxed max-w-5xl">
          A ZeroIndex service running at <code className="chip">xray.zeroindex.ai</code>. Replace
          this placeholder home page with the real surface.
        </p>
      </section>

      <section className="pt-2 pb-24">
        <div className="card">
          <h3>Getting started</h3>
          <p className="subtitle">
            Wire up your routes under <code className="chip">app/api</code> and your data access under{' '}
            <code className="chip">src/</code>. The <code className="chip">/admin</code> path is gated by
            Basic Auth via <code className="chip">proxy.ts</code>.
          </p>
        </div>
      </section>
    </>
  );
}
