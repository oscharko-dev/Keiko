// Issue #540 (Epic #532) — Validation-preview creation dialog.
//
// Validation-preview dialog for creating a new relationship. Uses the pure
// `validateRelationship` from @oscharko-dev/keiko-contracts for instant client-side
// hints. On submit POSTs /api/relationships via the BFF client.
//
// Server is authoritative — denial code + message are surfaced verbatim from the server
// (error-and-denial-ux.md "Per-denial-code UI treatment"). The UI never invents copy.
//
// Idempotency-Key: crypto.randomUUID() per call (api-contract.md §5).
// No new third-party dependency.
//
// WCAG: role="dialog" aria-modal aria-labelledby; focus trap; aria-live denial banner.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import type { RelationshipObjectKind, RelationshipType } from "@oscharko-dev/keiko-contracts";
import {
  RELATIONSHIP_SCHEMA_VERSION,
  RELATIONSHIP_TYPES,
  RELATIONSHIP_SUPPORTED_OBJECT_KINDS,
  RELATIONSHIP_TYPE_DEFINITIONS,
  validateRelationship,
} from "@oscharko-dev/keiko-contracts";
import {
  createRelationship,
  validateRelationshipProposal,
  RelationshipApiError,
} from "../../../relationships/api";
import type { ApiRelationship } from "../../../relationships/api";

// ─── Per-denial-code UI messages (verbatim from denial-reasons.md) ─────────────
// These are displayed only when the server returns a denial — never invented by the UI.
// Stored here for display completeness; server message is always canonical.

// ─── Form state ────────────────────────────────────────────────────────────────

interface FormState {
  type: RelationshipType;
  sourceKind: RelationshipObjectKind;
  sourceId: string;
  targetKind: RelationshipObjectKind;
  targetId: string;
  summary: string;
}

function initialForm(): FormState {
  return {
    type: "reads-context",
    sourceKind: "workflow-run",
    sourceId: "",
    targetKind: "memory",
    targetId: "",
    summary: "",
  };
}

const SECURITY_DENIAL_CODES = new Set([
  "denied/path-not-contained",
  "denied/cross-workspace",
  "denied/payload-content-not-permitted",
]);

function isSecurityDenial(
  denial: { codes: readonly string[] } | null,
): boolean {
  return denial?.codes.some((code) => SECURITY_DENIAL_CODES.has(code)) === true;
}

// ─── Props ─────────────────────────────────────────────────────────────────────

export interface RelationshipCreateDialogProps {
  /** Called when dialog closes (with created relationship on success, null on cancel). */
  readonly onClose: (created: ApiRelationship | null) => void;
  /** Workspace id for scoping. */
  readonly workspaceId?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function RelationshipCreateDialog({ onClose }: RelationshipCreateDialogProps): ReactNode {
  const [form, setForm] = useState<FormState>(initialForm);
  const [clientHints, setClientHints] = useState<readonly string[]>([]);
  const [serverDenial, setServerDenial] = useState<{
    source: "preview" | "submit";
    codes: readonly string[];
    messages: readonly string[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const firstFocusableRef = useRef<HTMLSelectElement | null>(null);
  const titleId = "rel-create-dialog-title";
  const descId = "rel-create-dialog-desc";

  // Focus trap: on mount, focus first field
  useEffect(() => {
    firstFocusableRef.current?.focus();
  }, []);

  // Focus trap: keep focus inside dialog
  const trapFocus = useCallback((e: globalThis.KeyboardEvent) => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.key !== "Tab") return;
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }, []);

  const handleEscape = useCallback(
    (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose(null);
    },
    [onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", trapFocus);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("keydown", trapFocus);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [trapFocus, handleEscape]);

  // ─── Client-side instant validation preview ───────────────────────────────
  // Uses pure validateRelationship from @oscharko-dev/keiko-contracts (Issue #538).
  // This is advisory only — server is authoritative.

  useEffect(() => {
    if (form.sourceId.length === 0 || form.targetId.length === 0) {
      setClientHints([]);
      return;
    }
    const candidate = {
      id: "candidate",
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
      workspaceId: "preview",
      source: { kind: form.sourceKind, id: form.sourceId, workspaceId: "preview" },
      target: { kind: form.targetKind, id: form.targetId, workspaceId: "preview" },
      type: form.type,
      lifecycleState: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      etag: 0,
    };
    const result = validateRelationship(candidate);
    if (!result.ok) {
      setClientHints(result.errors.map((e) => e.message));
    } else {
      setClientHints([]);
    }
  }, [form]);

  // ─── Debounced server-side preview (at most one call per 250 ms) ──────────
  const serverPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPreviewRequestId = useRef(0);

  useEffect(() => {
    latestPreviewRequestId.current += 1;
    const previewRequestId = latestPreviewRequestId.current;

    if (serverPreviewTimer.current !== null) clearTimeout(serverPreviewTimer.current);

    if (form.sourceId.length === 0 || form.targetId.length === 0) {
      setPreviewLoading(false);
      return;
    }
    // Only run server preview when client hints are empty
    if (clientHints.length > 0) {
      setPreviewLoading(false);
      return;
    }

    serverPreviewTimer.current = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        await validateRelationshipProposal({
          type: form.type,
          source: { kind: form.sourceKind, id: form.sourceId },
          target: { kind: form.targetKind, id: form.targetId },
          summary: form.summary.length > 0 ? form.summary : undefined,
        });
        if (previewRequestId !== latestPreviewRequestId.current) return;
        setServerDenial((current) => {
          if (current?.source === "submit") return current;
          return isSecurityDenial(current) ? current : null;
        });
      } catch (err) {
        if (previewRequestId !== latestPreviewRequestId.current) return;
        if (err instanceof RelationshipApiError && err.reasons.length > 0) {
          setServerDenial({
            source: "preview",
            codes: err.reasons.map((r) => r.code),
            messages: err.reasons.map((r) => r.message),
          });
        } else {
          setServerDenial(null);
        }
      } finally {
        if (previewRequestId === latestPreviewRequestId.current) {
          setPreviewLoading(false);
        }
      }
    }, 250);

    return () => {
      if (serverPreviewTimer.current !== null) clearTimeout(serverPreviewTimer.current);
    };
  }, [form, clientHints]);

  // ─── Submit ───────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerDenial(null);
    try {
      const idempotencyKey = crypto.randomUUID();
      const { relationship } = await createRelationship(
        {
          type: form.type,
          source: { kind: form.sourceKind, id: form.sourceId },
          target: { kind: form.targetKind, id: form.targetId },
          summary: form.summary.length > 0 ? form.summary : undefined,
        },
        idempotencyKey,
      );
      onClose(relationship);
    } catch (err) {
      if (err instanceof RelationshipApiError) {
        if (err.reasons.length > 0) {
          setServerDenial({
            source: "submit",
            codes: err.reasons.map((r) => r.code),
            // Verbatim server messages per error-and-denial-ux.md
            messages: err.reasons.map((r) => r.message),
          });
        } else {
          setServerDenial({
            source: "submit",
            codes: [err.code],
            messages: [err.message],
          });
        }
      } else {
        setServerDenial({
          source: "submit",
          codes: ["relationship/network-error"],
          messages: ["Unable to reach the local backend. Check that `keiko serve` is running."],
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, onClose, submitting]);

  const onDialogKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  // ─── Derived state ────────────────────────────────────────────────────────

  const def = RELATIONSHIP_TYPE_DEFINITIONS[form.type];
  const canSubmit =
    form.sourceId.trim().length > 0 &&
    form.targetId.trim().length > 0 &&
    clientHints.length === 0 &&
    serverDenial === null &&
    !submitting;

  // Security-class denials must not be auto-dismissed (error-and-denial-ux.md §"Forbidden patterns")
  const hasSecurityDenial = isSecurityDenial(serverDenial);

  return (
    <div
      className="cmdk-overlay"
      onPointerDown={() => onClose(null)}
      data-testid="rel-create-overlay"
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- dialog needs keydown handling */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="cmdk"
        style={{ maxWidth: 480, width: "100%" }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
        data-testid="rel-create-dialog"
      >
        {/* Title */}
        <div className="cmdk-input" style={{ borderBottom: "1px solid var(--border)" }}>
          <span id={titleId} style={{ fontWeight: 600, fontSize: 14, color: "var(--fg)" }}>
            Create relationship
          </span>
          <span id={descId} className="visually-hidden">
            Create a new relationship between two workspace endpoints.
          </span>
          <button
            type="button"
            className="arun-btn"
            onClick={() => onClose(null)}
            aria-label="Close dialog"
            style={{ marginLeft: "auto", minWidth: 24, minHeight: 24 }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Relationship type */}
          <div>
            <label
              htmlFor="rel-type"
              style={{ fontSize: 12, color: "var(--fg-muted)", display: "block", marginBottom: 3 }}
            >
              Type
            </label>
            <select
              id="rel-type"
              ref={firstFocusableRef}
              value={form.type}
              onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as RelationshipType }))}
              style={{
                width: "100%",
                background: "var(--inset)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "4px 8px",
                color: "var(--fg)",
                fontSize: 13,
              }}
              aria-label="Relationship type"
            >
              {RELATIONSHIP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RELATIONSHIP_TYPE_DEFINITIONS[t].displayName}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", marginTop: 3 }}>
              {def.semantics}
            </div>
          </div>

          {/* Source endpoint */}
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: "0 0 140px" }}>
              <label
                htmlFor="rel-src-kind"
                style={{
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  display: "block",
                  marginBottom: 3,
                }}
              >
                Source kind
              </label>
              <select
                id="rel-src-kind"
                value={form.sourceKind}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sourceKind: e.target.value as RelationshipObjectKind }))
                }
                style={{
                  width: "100%",
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  color: "var(--fg)",
                  fontSize: 12,
                }}
                aria-label="Source endpoint kind"
              >
                {RELATIONSHIP_SUPPORTED_OBJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label
                htmlFor="rel-src-id"
                style={{
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  display: "block",
                  marginBottom: 3,
                }}
              >
                Source ID
              </label>
              <input
                id="rel-src-id"
                type="text"
                value={form.sourceId}
                onChange={(e) => setForm((f) => ({ ...f, sourceId: e.target.value }))}
                placeholder="endpoint id"
                style={{
                  width: "100%",
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  color: "var(--fg)",
                  fontSize: 12,
                }}
                aria-label="Source endpoint ID"
                aria-describedby="rel-src-kind"
              />
            </div>
          </div>

          {/* Target endpoint */}
          <div style={{ display: "flex", gap: 6 }}>
            <div style={{ flex: "0 0 140px" }}>
              <label
                htmlFor="rel-tgt-kind"
                style={{
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  display: "block",
                  marginBottom: 3,
                }}
              >
                Target kind
              </label>
              <select
                id="rel-tgt-kind"
                value={form.targetKind}
                onChange={(e) =>
                  setForm((f) => ({ ...f, targetKind: e.target.value as RelationshipObjectKind }))
                }
                style={{
                  width: "100%",
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  color: "var(--fg)",
                  fontSize: 12,
                }}
                aria-label="Target endpoint kind"
              >
                {RELATIONSHIP_SUPPORTED_OBJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label
                htmlFor="rel-tgt-id"
                style={{
                  fontSize: 12,
                  color: "var(--fg-muted)",
                  display: "block",
                  marginBottom: 3,
                }}
              >
                Target ID
              </label>
              <input
                id="rel-tgt-id"
                type="text"
                value={form.targetId}
                onChange={(e) => setForm((f) => ({ ...f, targetId: e.target.value }))}
                placeholder="endpoint id"
                style={{
                  width: "100%",
                  background: "var(--inset)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "4px 8px",
                  color: "var(--fg)",
                  fontSize: 12,
                }}
                aria-label="Target endpoint ID"
                aria-describedby="rel-tgt-kind"
              />
            </div>
          </div>

          {/* Summary (optional) */}
          <div>
            <label
              htmlFor="rel-summary"
              style={{ fontSize: 12, color: "var(--fg-muted)", display: "block", marginBottom: 3 }}
            >
              Summary (optional, ≤240 chars)
            </label>
            <textarea
              id="rel-summary"
              value={form.summary}
              maxLength={240}
              rows={2}
              onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
              style={{
                width: "100%",
                background: "var(--inset)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "4px 8px",
                color: "var(--fg)",
                fontSize: 12,
                resize: "vertical",
              }}
              aria-label="Relationship summary"
            />
          </div>

          {/* Client-side instant validation hints */}
          {clientHints.length > 0 && (
            <div
              className="lk-alert"
              role="status"
              aria-live="polite"
              data-testid="client-validation-hints"
            >
              {clientHints.map((hint, i) => (
                <div key={i} style={{ fontSize: 12 }}>
                  {hint}
                </div>
              ))}
            </div>
          )}

          {/* Server-side preview loading */}
          {previewLoading && (
            <div style={{ fontSize: 12, color: "var(--fg-muted)" }} aria-live="polite">
              Validating…
            </div>
          )}

          {/* Server denial banner — verbatim codes + messages (error-and-denial-ux.md) */}
          {serverDenial !== null && (
            <div
              className="lk-alert"
              // assertive during creation (error-and-denial-ux.md §"Three-layer error model")
              role="alert"
              aria-live="assertive"
              data-testid="server-denial-banner"
            >
              {serverDenial.codes.map((code, i) => (
                <div key={code} style={{ marginBottom: i < serverDenial.codes.length - 1 ? 6 : 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      color: "var(--fg-muted)",
                      marginBottom: 2,
                    }}
                  >
                    {code}
                  </div>
                  {/* User-facing message verbatim from server */}
                  <div style={{ fontSize: 13, color: "var(--fg)" }}>
                    {serverDenial.messages[i] ?? code}
                  </div>
                </div>
              ))}
              {/* Security-class denials require explicit dismissal (error-and-denial-ux.md §"Forbidden patterns") */}
              {hasSecurityDenial && (
                <button
                  type="button"
                  className="lk-alert-retry"
                  onClick={() => setServerDenial(null)}
                  style={{ marginTop: 6 }}
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {/* Action row */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button
              type="button"
              className="arun-btn"
              onClick={() => onClose(null)}
              style={{ minWidth: 24, minHeight: 24 }}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`arun-btn${canSubmit ? " primary" : ""}`}
              aria-disabled={!canSubmit}
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              aria-busy={submitting}
              style={{ minWidth: 24, minHeight: 24 }}
            >
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
