"use client";

/**
 * Agent-action conflict banner (Issue #1394, ADR-0058 D4).
 *
 * Surfaces a structured conflict code and human-readable message above the editor surface after an
 * agent action fails with a conflict status. Renders non-destructively — the editor buffer is never
 * replaced or cleared. Three affordance groups are offered based on the conflict code:
 *
 * - DIRTY: Save + Dismiss (the user saves the dirty buffer so the agent can re-try)
 * - VERSION_MISMATCH / CONTENT_HASH_MISMATCH: Reload + Dismiss (stale token — reload refreshes it)
 * - INVALID_EDITS / OUT_OF_SCOPE / PRECONDITION_REQUIRED: Dismiss only (agent errors, user cannot
 *   self-resolve — the agent must re-issue the action correctly)
 *
 * Uses the existing `.ai-danger` / `.ai-danger-h` / `.ai-danger-act` classes; no new CSS classes.
 */
import type { ReactNode } from "react";
import type { EditorAgentActionResult } from "../../../../../lib/types";

export type AgentConflictCode = NonNullable<EditorAgentActionResult["conflict"]>["code"];

export interface AgentConflictBannerProps {
  readonly code: AgentConflictCode;
  readonly message: string;
  readonly onSave?: (() => void) | undefined;
  readonly onReload?: (() => void) | undefined;
  readonly onDismiss: () => void;
}

function conflictTitle(code: AgentConflictCode): string {
  switch (code) {
    case "DIRTY":
      return "Unsaved changes conflict";
    case "VERSION_MISMATCH":
      return "File version mismatch";
    case "CONTENT_HASH_MISMATCH":
      return "File content mismatch";
    case "INVALID_EDITS":
      return "Invalid agent edits";
    case "OUT_OF_SCOPE":
      return "Action out of scope";
    case "NO_ACTIVE_SESSION":
      return "No active editor session";
    case "PRECONDITION_REQUIRED":
      return "Missing write precondition";
  }
}

function ConflictActions({
  code,
  onSave,
  onReload,
  onDismiss,
}: {
  readonly code: AgentConflictCode;
  readonly onSave: (() => void) | undefined;
  readonly onReload: (() => void) | undefined;
  readonly onDismiss: () => void;
}): ReactNode {
  if (code === "DIRTY") {
    return (
      <div className="ai-danger-act">
        <button type="button" className="ed-save" onClick={onSave}>
          Save
        </button>
        {/* A11Y-4: use ed-save (neutral) not ed-reload (reload semantic is misleading for Dismiss) */}
        <button type="button" className="ed-save" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  if (code === "VERSION_MISMATCH" || code === "CONTENT_HASH_MISMATCH") {
    return (
      <div className="ai-danger-act">
        <button type="button" className="ed-reload" onClick={onReload}>
          Reload
        </button>
        <button type="button" className="ed-reload" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div className="ai-danger-act">
      <button type="button" className="ed-reload" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function AgentConflictBanner({
  code,
  message,
  onSave,
  onReload,
  onDismiss,
}: AgentConflictBannerProps): ReactNode {
  return (
    <div className="ai-danger" role="alert" data-testid="agent-conflict-banner">
      <div className="ai-danger-h">
        <span className="tt">{conflictTitle(code)}</span>
      </div>
      <p>
        <code>{code}</code>
        {message.length > 0 ? ` — ${message}` : null}
      </p>
      <ConflictActions code={code} onSave={onSave} onReload={onReload} onDismiss={onDismiss} />
    </div>
  );
}
