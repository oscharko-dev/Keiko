"use client";

import type { ReactNode } from "react";
import { KeikoLogo } from "@/app/components/KeikoLogo";

// ---------------------------------------------------------------------------
// Trust-posture chips
// ---------------------------------------------------------------------------

const CHIPS = [
  "Local only · 127.0.0.1",
  "Dry-run first",
  "Structured event stream",
] as const;

/**
 * "No chat selected" entry experience shared by `/` and `/launch`.
 * Static content only — no network calls (ADR-0014 D9).
 */
export function WorkspaceShellEntry(): ReactNode {
  return (
    <section
      aria-labelledby="workspace-welcome-heading"
      className="flex h-full flex-col items-center justify-center text-center"
    >
      <KeikoLogo className="h-16 w-16 text-accent" aria-hidden="true" />

      <h1
        id="workspace-welcome-heading"
        className="mt-6 text-heading text-ink"
      >
        Welcome to Keiko
      </h1>

      <p className="mt-3 max-w-sm text-sm text-ink-muted">
        Pick a project on the left to start a new chat, or launch a workflow directly.
      </p>

      {/* Trust-posture chips */}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {CHIPS.map((chip) => (
          <span
            key={chip}
            className="rounded bg-panel px-3 py-1 text-xs text-ink-muted"
          >
            {chip}
          </span>
        ))}
      </div>

      <p className="mt-8 text-xs text-ink-dim">
        Everything runs on your machine — no external service beyond the configured model
        endpoints.
      </p>
    </section>
  );
}

export default WorkspaceShellEntry;
