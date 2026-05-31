"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannedToolPanelProps {
  tool: "browser" | "review" | "terminal";
  project: { path: string; name: string };
  onClose: () => void;
  followUpIssueUrl: string;
}

// ---------------------------------------------------------------------------
// Per-tool copy
// ---------------------------------------------------------------------------

type ToolLabel = "Browser" | "Review" | "Terminal";

interface ToolCopy {
  label: ToolLabel;
  description: string;
  willDo: string[];
  willNotDo: string[];
}

const TOOL_COPY: Record<"browser" | "review" | "terminal", ToolCopy> = {
  browser: {
    label: "Browser",
    description:
      "The Browser tool will allow you to run automated web interactions scoped " +
      "to local development servers within your project.",
    willDo: [
      "Navigate and interact with locally running web applications.",
      "Capture screenshots and page content for review.",
      "Assist with UI-level testing and debugging workflows.",
    ],
    willNotDo: [
      "Browse external websites or the public internet.",
      "Execute arbitrary JavaScript with elevated permissions.",
      "Retain browser sessions or cookies beyond a single task.",
    ],
  },
  review: {
    label: "Review",
    description:
      "The Review tool will surface a structured diff and patch review interface " +
      "scoped to your project's evidence and proposed changes.",
    willDo: [
      "Display proposed patches with syntax highlighting.",
      "Link directly to the evidence manifest for each run.",
      "Support line-level annotation and approval workflows.",
    ],
    willNotDo: [
      "Apply patches without explicit developer confirmation.",
      "Access repositories outside the selected project path.",
      "Expose raw file content beyond the bounded context pack.",
    ],
  },
  terminal: {
    label: "Terminal",
    description:
      "The Terminal tool will provide a sandboxed command execution surface " +
      "scoped to your project's working directory and permitted commands.",
    willDo: [
      "Execute permitted build, test, and lint commands within the project.",
      "Stream command output in real time with structured event logging.",
      "Enforce the same execution limits as the CLI verification layer.",
    ],
    willNotDo: [
      "Open an unrestricted interactive shell.",
      "Execute commands outside the project's permitted command list.",
      "Grant network or filesystem access beyond the project boundary.",
    ],
  },
};

// ---------------------------------------------------------------------------
// PlannedToolPanel
// ---------------------------------------------------------------------------

const PANEL_HEADING_ID = "planned-tool-panel-heading";

/**
 * Placeholder panel for Browser, Review, and Terminal tools.
 * Describes the planned capability without providing any execution surface.
 */
export function PlannedToolPanel({
  tool,
  project,
  onClose,
  followUpIssueUrl,
}: PlannedToolPanelProps): ReactNode {
  const copy = TOOL_COPY[tool];
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus on mount for screen-reader announcement.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={PANEL_HEADING_ID}
      className="flex w-full flex-col overflow-hidden border-b border-border bg-panel
        focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent
        sm:w-72 sm:border-b-0 sm:border-l"
    >
      {/* Panel header */}
      <header
        className="flex items-center justify-between border-b border-border px-4 py-3"
      >
        <h2 id={PANEL_HEADING_ID} className="text-sm font-semibold text-ink">
          {copy.label}
        </h2>
        <button
          type="button"
          aria-label={`Close ${copy.label} panel`}
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded text-ink-muted
            hover:bg-elevated hover:text-ink
            focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>
      </header>

      {/* Panel body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs">
        <p className="text-ink-muted leading-relaxed">{copy.description}</p>
        <p className="rounded bg-elevated px-2 py-1 text-[11px] text-ink-muted">
          Project context: <span className="text-ink">{project.name}</span>
        </p>

        <section>
          <p className="mb-1.5 font-medium text-ink">Planned capabilities</p>
          <ul className="space-y-1 text-ink-muted">
            {copy.willDo.map((item) => (
              <li key={item} className="flex gap-2 leading-relaxed">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-accent">+</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <p className="mb-1.5 font-medium text-ink">Out of scope</p>
          <ul className="space-y-1 text-ink-muted">
            {copy.willNotDo.map((item) => (
              <li key={item} className="flex gap-2 leading-relaxed">
                <span aria-hidden="true" className="mt-0.5 shrink-0 text-ink-muted">−</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        {followUpIssueUrl ? (
          <p className="text-ink-muted">
            Track progress in the{" "}
            <a
              href={followUpIssueUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open the follow-up issue for the ${copy.label} tool on GitHub (opens in new tab)`}
              className="text-accent underline underline-offset-2 hover:opacity-80"
            >
              follow-up issue
            </a>
            .
          </p>
        ) : (
          <p className="text-ink-muted">
            A follow-up issue will be linked here once it is created.
          </p>
        )}
      </div>
    </div>
  );
}

export default PlannedToolPanel;
