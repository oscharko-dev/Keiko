import type { ReactNode } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Surface card
// ---------------------------------------------------------------------------

interface SurfaceCardProps {
  href: string;
  title: string;
  description: string;
  label: string;
}

function SurfaceCard({ href, title, description, label }: SurfaceCardProps): ReactNode {
  return (
    <li>
      <Link
        href={href}
        className="block rounded-lg border border-ink/10 bg-surface p-6 hover:border-accent/40 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2"
        aria-label={label}
      >
        <h2 className="text-subheading text-ink">{title}</h2>
        <p className="mt-2 text-sm text-ink-muted">{description}</p>
        <span className="mt-4 inline-block text-xs font-medium text-accent" aria-hidden="true">
          Open →
        </span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// HomePage
// ---------------------------------------------------------------------------

const SURFACES: SurfaceCardProps[] = [
  {
    href: "/launch",
    title: "Launch workflow",
    description:
      "Start a unit-test generation, bug-investigation, or explain-plan run. Select a model, " +
      "configure limits, and choose dry-run or apply mode.",
    label: "Open the workflow launch surface",
  },
  {
    href: "/evidence",
    title: "Evidence browser",
    description:
      "Browse past runs and their evidence manifests. Filter by workflow, outcome, or date. " +
      "View usage totals, verification status, and optional reasoning traces.",
    label: "Open the evidence browser",
  },
  {
    href: "/config",
    title: "Config & model inspector",
    description:
      "Inspect the active gateway configuration (provider rows, timeouts, retries — no API keys " +
      "shown) and the full model capability registry.",
    label: "Open the configuration and model inspector",
  },
];

export default function HomePage(): ReactNode {
  return (
    <section aria-labelledby="home-heading">
      {/* Product identity */}
      <div className="border-b border-ink/10 pb-section">
        <h1 id="home-heading" className="text-heading text-ink">
          Keiko developer-assist UI
        </h1>
        <p className="mt-3 max-w-2xl text-ink-muted">
          A local interface for initiating, observing, and reviewing AI-assisted developer
          workflows. Everything runs on your machine — no external service is contacted beyond
          the configured model endpoints.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <span className="rounded bg-surface-subtle px-3 py-1 text-xs text-ink-muted">
            Local only · 127.0.0.1
          </span>
          <span className="rounded bg-surface-subtle px-3 py-1 text-xs text-ink-muted">
            Dry-run first
          </span>
          <span className="rounded bg-surface-subtle px-3 py-1 text-xs text-ink-muted">
            Structured event stream
          </span>
        </div>
      </div>

      {/* Surface navigation cards */}
      <nav aria-label="Surface navigation" className="mt-section">
        <ul className="grid gap-4 sm:grid-cols-3">
          {SURFACES.map((s) => (
            <SurfaceCard key={s.href} {...s} />
          ))}
        </ul>
      </nav>

      {/* Quick-start hint */}
      <section aria-labelledby="quickstart-heading" className="mt-section">
        <h2 id="quickstart-heading" className="text-subheading text-ink">
          Quick start
        </h2>
        <ol className="mt-4 grid gap-2 text-sm text-ink-muted">
          <li className="flex gap-2">
            <span className="font-mono font-bold text-accent">1.</span>
            <span>
              Open{" "}
              <Link href="/launch" className="text-accent hover:underline focus:outline-none focus:ring-1 focus:ring-focus">
                Launch workflow
              </Link>
              , select a workflow, enter a workspace path and model.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono font-bold text-accent">2.</span>
            <span>
              Keep <strong>Dry-run</strong> mode (default) — the model proposes a patch without
              writing any files.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono font-bold text-accent">3.</span>
            <span>
              Watch the live event stream, then review the proposed diff in{" "}
              <strong>Patch review</strong>.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono font-bold text-accent">4.</span>
            <span>
              Click <strong>Apply patch</strong> to write the changes — only after your explicit
              confirmation.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-mono font-bold text-accent">5.</span>
            <span>
              Browse past runs in{" "}
              <Link href="/evidence" className="text-accent hover:underline focus:outline-none focus:ring-1 focus:ring-focus">
                Evidence
              </Link>
              .
            </span>
          </li>
        </ol>
      </section>
    </section>
  );
}
