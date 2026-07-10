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
 * - INVALID_EDITS / OUT_OF_SCOPE / PRECONDITION_REQUIRED / POLICY_DENIED / APPROVAL_REQUIRED /
 *   NO_ACTIVE_SESSION / NO_ACTIVE_BRIDGE: Dismiss only (the producer must re-issue the action after
 *   satisfying the reported structural, policy, approval, or bridge condition)
 *
 * Uses the existing `.ai-danger` / `.ai-danger-h` / `.ai-danger-act` classes; no new CSS classes.
 */
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useId, useRef } from "react";
import type { EditorAgentActionResult } from "../../../../../lib/types";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";

export type AgentConflictCode = NonNullable<EditorAgentActionResult["conflict"]>["code"];

export interface AgentConflictBannerProps {
  readonly code: AgentConflictCode;
  readonly message: string;
  readonly onSave?: (() => void) | undefined;
  readonly onReload?: (() => void) | undefined;
  readonly onDismiss: () => void;
}

function conflictTitle(code: AgentConflictCode, t: I18nTranslate): string {
  switch (code) {
    case "DIRTY":
      return t("editor.agentConflict.title.dirty");
    case "VERSION_MISMATCH":
      return t("editor.agentConflict.title.versionMismatch");
    case "CONTENT_HASH_MISMATCH":
      return t("editor.agentConflict.title.contentHashMismatch");
    case "INVALID_EDITS":
      return t("editor.agentConflict.title.invalidEdits");
    case "OUT_OF_SCOPE":
      return t("editor.agentConflict.title.outOfScope");
    case "NO_ACTIVE_SESSION":
      return t("editor.agentConflict.title.noActiveSession");
    case "NO_ACTIVE_BRIDGE":
      return t("editor.agentConflict.title.noActiveBridge");
    case "PRECONDITION_REQUIRED":
      return t("editor.agentConflict.title.preconditionRequired");
    case "POLICY_DENIED":
      return t("editor.agentConflict.title.policyDenied");
    case "APPROVAL_REQUIRED":
      return t("editor.agentConflict.title.approvalRequired");
  }
}

function ConflictActions({
  code,
  onSave,
  onReload,
  onDismiss,
  primaryRef,
  t,
}: {
  readonly code: AgentConflictCode;
  readonly onSave: (() => void) | undefined;
  readonly onReload: (() => void) | undefined;
  readonly onDismiss: () => void;
  // GEN-UI-A11Y-005: focus lands on the primary recovery action on mount (Save for DIRTY, Reload for a
  // version/content mismatch, else the sole Dismiss).
  readonly primaryRef: RefObject<HTMLButtonElement>;
  readonly t: I18nTranslate;
}): ReactNode {
  if (code === "DIRTY") {
    return (
      <div className="ai-danger-act">
        <button type="button" className="ed-save" onClick={onSave} ref={primaryRef}>
          {t("common.save")}
        </button>
        {/* A11Y-4: use ed-save (neutral) not ed-reload (reload semantic is misleading for Dismiss) */}
        <button type="button" className="ed-save" onClick={onDismiss}>
          {t("common.dismiss")}
        </button>
      </div>
    );
  }
  if (code === "VERSION_MISMATCH" || code === "CONTENT_HASH_MISMATCH") {
    return (
      <div className="ai-danger-act">
        <button type="button" className="ed-reload" onClick={onReload} ref={primaryRef}>
          {t("editor.agentConflict.reload")}
        </button>
        <button type="button" className="ed-reload" onClick={onDismiss}>
          {t("common.dismiss")}
        </button>
      </div>
    );
  }
  return (
    <div className="ai-danger-act">
      <button type="button" className="ed-reload" onClick={onDismiss} ref={primaryRef}>
        {t("common.dismiss")}
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
  const t = useTranslate();
  const titleId = useId();
  const bodyId = useId();
  // GEN-UI-A11Y-005: this is a recoverable conflict prompt that demands a choice, so it is an
  // alertdialog (announced like role=alert, but a dialog the keyboard user is expected to act on).
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onDismiss();
    }
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape-to-dismiss on the alertdialog container gives keyboard users a cancel affordance mirroring the Dismiss button
    <div
      className="ai-danger"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="agent-conflict-banner"
      onKeyDown={handleKeyDown}
    >
      <div className="ai-danger-h">
        <span className="tt" id={titleId}>
          {conflictTitle(code, t)}
        </span>
      </div>
      <p id={bodyId}>
        <code>{code}</code>
        {message.length > 0 ? ` — ${message}` : null}
      </p>
      <ConflictActions
        code={code}
        onSave={onSave}
        onReload={onReload}
        onDismiss={onDismiss}
        primaryRef={primaryRef}
        t={t}
      />
    </div>
  );
}
