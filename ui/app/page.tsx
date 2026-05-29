import type { ReactNode } from "react";

const SURFACES = [
  "Workflow launch",
  "Live run view",
  "Patch review",
  "Evidence browser",
  "Config and model inspector",
] as const;

export default function HomePage(): ReactNode {
  return (
    <div className="min-h-screen">
      <header className="border-b border-ink/10 bg-surface-subtle">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-gutter py-6">
          <span className="font-mono text-subheading text-accent-strong">Keiko</span>
          <nav aria-label="Primary">
            <ul className="flex gap-6 text-ink-muted">
              <li>Local UI</li>
            </ul>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-gutter py-section">
        <h1 className="text-heading text-ink">Keiko developer-assist UI</h1>
        <p className="mt-4 max-w-2xl text-ink-muted">
          This is the Wave 1 placeholder shell. The local interface runs entirely on your machine
          and talks only to the local Keiko process. The workflow surfaces below arrive in a
          subsequent wave.
        </p>

        <section aria-labelledby="surfaces-heading" className="mt-section">
          <h2 id="surfaces-heading" className="text-subheading text-ink">
            Planned surfaces
          </h2>
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {SURFACES.map((surface) => (
              <li
                key={surface}
                className="rounded-md border border-ink/10 bg-surface px-4 py-3 text-ink"
              >
                {surface}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
