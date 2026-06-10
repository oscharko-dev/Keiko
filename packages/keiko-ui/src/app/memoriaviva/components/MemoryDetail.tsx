"use client";

// Issue #211 — MemoriaViva detail panel.
// Shows provenance, validity interval, tags, scope, sensitivity, stale reason.
// Fetches by id on mount; id comes from the URL segment passed by the page.
//
// WCAG: semantic dl/dt/dd for metadata, role="status" aria-live="polite" for
// loading/error regions. focus-visible rings on action links.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { MemoryRecord, MemoryId } from "@oscharko-dev/keiko-contracts";
import { fetchMemory, type MemoryDetailResponse } from "@/lib/memory-api";
import { formatError } from "./format-error";
import { TYPE_LABELS } from "./MemoryFilters";
import { MemoryActions } from "./MemoryActions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTs(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function formatScope(scope: MemoryRecord["scope"]): string {
  switch (scope.kind) {
    case "user":
      return `user:${scope.userId}`;
    case "workspace":
      return `workspace:${scope.workspaceId}`;
    case "project":
      return `project:${scope.projectId}`;
    case "workflow":
      return `workflow:${scope.workflowDefinitionId}`;
    case "global":
      return "global";
    default: {
      const _: never = scope;
      void _;
      return "unknown";
    }
  }
}

// ---------------------------------------------------------------------------
// MetaField
// ---------------------------------------------------------------------------

function MetaField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactNode;
}): ReactNode {
  return (
    <>
      <dt className="mc-meta-label">{label}</dt>
      <dd className="mc-meta-value">{value}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// ProvenanceSection
// ---------------------------------------------------------------------------

function ProvenanceSection({
  provenance,
}: {
  readonly provenance: MemoryRecord["provenance"];
}): ReactNode {
  return (
    <section aria-label="Provenance" className="mc-section">
      <h2 className="lk-section-head">Provenance</h2>
      <dl className="mc-meta">
        <MetaField label="Source kind" value={provenance.sourceKind} />
        <MetaField label="Captured at" value={formatTs(provenance.capturedAt)} />
        <MetaField label="Confidence" value={`${(provenance.confidence * 100).toFixed(0)}%`} />
        <MetaField label="Sensitivity" value={provenance.sensitivity} />
        {provenance.captureRationale !== undefined ? (
          <MetaField label="Rationale" value={provenance.captureRationale} />
        ) : null}
        {provenance.modelIdentity !== undefined ? (
          <MetaField
            label="Model"
            value={`${provenance.modelIdentity.provider} / ${provenance.modelIdentity.modelId}`}
          />
        ) : null}
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ValiditySection
// ---------------------------------------------------------------------------

function ValiditySection({ validity }: { readonly validity: MemoryRecord["validity"] }): ReactNode {
  return (
    <section aria-label="Validity" className="mc-section">
      <h2 className="lk-section-head">Validity</h2>
      <dl className="mc-meta">
        <MetaField label="Valid from" value={formatTs(validity.validFrom)} />
        <MetaField
          label="Valid until"
          value={validity.validUntil !== undefined ? formatTs(validity.validUntil) : "No expiry"}
        />
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// TagsList
// ---------------------------------------------------------------------------

function TagsList({ tags }: { readonly tags: readonly string[] }): ReactNode {
  if (tags.length === 0) return <span className="mc-meta-empty">No tags</span>;
  return (
    <ul className="mc-tags" aria-label="Tags">
      {tags.map((tag) => (
        <li key={tag} className="mc-tag">
          {tag}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// RecordHeader
// ---------------------------------------------------------------------------

function RecordHeader({ record }: { readonly record: MemoryRecord }): ReactNode {
  return (
    <header className="mc-detail-header">
      <Link
        href="/memoriaviva"
        className="mc-back-link lk-btn lk-btn-ghost"
        aria-label="Back to MemoriaViva"
      >
        ← Back
      </Link>
      <div className="mc-detail-title-row">
        <h1 className="lk-title" style={{ flex: 1 }}>
          {TYPE_LABELS[record.type]} memory
        </h1>
        {/* static metadata label — role="status" would announce it as a live
            region (uiux-fix F005) */}
        <span className={`mc-badge mc-badge-${record.status}`}>{record.status}</span>
        {record.pinned ? (
          <span aria-label="Pinned" className="mc-badge mc-badge-pinned">
            Pinned
          </span>
        ) : null}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// MemoryDetail
// ---------------------------------------------------------------------------

interface MemoryDetailProps {
  readonly id: string;
  readonly fetchMemoryImpl?: typeof fetchMemory;
}

export function MemoryDetail({ id, fetchMemoryImpl = fetchMemory }: MemoryDetailProps): ReactNode {
  const [record, setRecord] = useState<MemoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True after a destructive action (forget/delete) cleared the record — the
  // empty state then confirms the removal and offers a way back instead of a
  // dead-end "Memory not found" (uiux-fix F005).
  const [removed, setRemoved] = useState(false);
  const removedBackLinkRef = useRef<HTMLAnchorElement>(null);

  const handleRecordChange = useCallback((updated: MemoryRecord | null): void => {
    if (updated === null) setRemoved(true);
    setRecord(updated);
  }, []);

  // The forget/delete dialog tries to restore focus to its (now unmounted)
  // trigger button; move focus to the back link so keyboard users keep an
  // anchor after the destructive action.
  useEffect(() => {
    if (removed && record === null) removedBackLinkRef.current?.focus();
  }, [removed, record]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res: MemoryDetailResponse = await fetchMemoryImpl(id as MemoryId);
      setRecord(res.memory);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [id, fetchMemoryImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        Loading memory…
      </p>
    );
  }

  if (error !== null) {
    return (
      <>
        <div role="alert" aria-live="assertive" className="lk-alert">
          {error}
          <button
            type="button"
            className="lk-alert-retry"
            onClick={() => {
              void load();
            }}
          >
            Retry
          </button>
        </div>
        <p>
          <Link href="/memoriaviva" className="lk-btn lk-btn-ghost">
            Back to MemoriaViva
          </Link>
        </p>
      </>
    );
  }

  if (record === null) {
    return (
      <div className="lk-empty">
        <div>
          <p className="lk-empty-title">{removed ? "Memory removed" : "Memory not found"}</p>
          <p role="status" aria-live="polite" className="lk-empty-body">
            {removed
              ? "The memory was forgotten or deleted and is no longer available."
              : "This memory may have been deleted. Open a memory from the list instead."}
          </p>
          <p>
            <Link ref={removedBackLinkRef} href="/memoriaviva" className="lk-btn lk-btn-ghost">
              Back to MemoriaViva
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <article aria-label={`Memory record: ${record.body.slice(0, 60)}`} className="mc-detail">
      <RecordHeader record={record} />

      <section aria-label="Memory body" className="mc-section">
        <h2 className="lk-section-head">Content</h2>
        <p className="mc-body-text">{record.body}</p>
      </section>

      <section aria-label="Details" className="mc-section">
        <h2 className="lk-section-head">Details</h2>
        <dl className="mc-meta">
          <MetaField label="ID" value={<code className="mc-code">{record.id}</code>} />
          <MetaField label="Scope" value={formatScope(record.scope)} />
          <MetaField label="Type" value={TYPE_LABELS[record.type]} />
          <MetaField label="Created" value={formatTs(record.createdAt)} />
          <MetaField label="Updated" value={formatTs(record.updatedAt)} />
          {record.staleReason !== undefined ? (
            <MetaField label="Stale reason" value={<em>{record.staleReason}</em>} />
          ) : null}
        </dl>
      </section>

      <ProvenanceSection provenance={record.provenance} />
      <ValiditySection validity={record.validity} />

      <section aria-label="Tags" className="mc-section">
        <h2 className="lk-section-head">Tags</h2>
        <TagsList tags={record.tags} />
      </section>

      <section aria-label="Actions" className="mc-section">
        <h2 className="lk-section-head">Actions</h2>
        <MemoryActions record={record} onRecordChange={handleRecordChange} />
      </section>
    </article>
  );
}
