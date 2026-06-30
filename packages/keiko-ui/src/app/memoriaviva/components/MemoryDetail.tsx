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
import { useI18n, type I18nTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";
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

function typeLabel(type: MemoryRecord["type"], t: I18nTranslate): string {
  switch (type) {
    case "episodic":
      return t("memoria.type.episodic");
    case "semantic-fact":
      return t("memoria.type.semanticFact");
    case "procedural":
      return t("memoria.type.procedural");
    case "preference":
      return t("memoria.type.preference");
    case "correction":
      return t("memoria.type.correction");
    case "decision":
      return t("memoria.type.decision");
    case "negative":
      return t("memoria.type.negative");
    case "pinned":
      return t("memoria.type.pinned");
  }
}

function statusLabel(status: MemoryRecord["status"], t: I18nTranslate): string {
  switch (status) {
    case "proposed":
      return t("memoria.status.proposed");
    case "accepted":
      return t("memoria.status.accepted");
    case "rejected":
      return t("memoria.status.rejected");
    case "superseded":
      return t("memoria.status.superseded");
    case "archived":
      return t("memoria.status.archived");
    case "forgotten":
      return t("memoria.status.forgotten");
    case "conflicted":
      return t("memoria.status.conflicted");
    case "expired":
      return t("memoria.status.expired");
  }
}

function sensitivityLabel(
  sensitivity: MemoryRecord["provenance"]["sensitivity"],
  t: I18nTranslate,
): string {
  switch (sensitivity) {
    case "public":
      return t("memoria.sensitivity.public");
    case "confidential":
      return t("memoria.sensitivity.confidential");
    case "restricted":
      return t("memoria.sensitivity.restricted");
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
  t,
}: {
  readonly provenance: MemoryRecord["provenance"];
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <section aria-label={t("memoria.provenance")} className="mc-section">
      <h2 className="lk-section-head">{t("memoria.provenance")}</h2>
      <dl className="mc-meta">
        <MetaField label={t("memoria.sourceKind")} value={provenance.sourceKind} />
        <MetaField label={t("memoria.capturedAt")} value={formatTs(provenance.capturedAt)} />
        <MetaField
          label={t("memoria.confidence")}
          value={`${(provenance.confidence * 100).toFixed(0)}%`}
        />
        <MetaField
          label={t("memoria.sensitivity")}
          value={sensitivityLabel(provenance.sensitivity, t)}
        />
        {provenance.captureRationale !== undefined ? (
          <MetaField label={t("memoria.rationale")} value={provenance.captureRationale} />
        ) : null}
        {provenance.modelIdentity !== undefined ? (
          <MetaField
            label={t("memoria.model")}
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

function ValiditySection({
  validity,
  t,
}: {
  readonly validity: MemoryRecord["validity"];
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <section aria-label={t("memoria.validity")} className="mc-section">
      <h2 className="lk-section-head">{t("memoria.validity")}</h2>
      <dl className="mc-meta">
        <MetaField label={t("memoria.validFrom")} value={formatTs(validity.validFrom)} />
        <MetaField
          label={t("memoria.validUntil")}
          value={
            validity.validUntil !== undefined ? formatTs(validity.validUntil) : t("memoria.noExpiry")
          }
        />
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// TagsList
// ---------------------------------------------------------------------------

function TagsList({
  tags,
  t,
}: {
  readonly tags: readonly string[];
  readonly t: I18nTranslate;
}): ReactNode {
  if (tags.length === 0) return <span className="mc-meta-empty">{t("memoria.noTags")}</span>;
  return (
    <ul className="mc-tags" aria-label={t("memoria.tags")}>
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

function BackToMemoriaControl({
  onBack,
  controlRef,
  children,
  t,
}: {
  readonly onBack?: (() => void) | undefined;
  readonly controlRef?: ((node: HTMLAnchorElement | HTMLButtonElement | null) => void) | undefined;
  readonly children?: ReactNode;
  readonly t: I18nTranslate;
}): ReactNode {
  const label = children ?? t("memoria.backToMemoria");
  if (onBack !== undefined) {
    return (
      <button
        ref={controlRef}
        type="button"
        className="mc-back-link lk-btn lk-btn-ghost"
        onClick={onBack}
      >
        {label}
      </button>
    );
  }
  return (
    <Link
      ref={controlRef}
      href="/memoriaviva"
      className="mc-back-link lk-btn lk-btn-ghost"
      aria-label={t("memoria.backToMemoria")}
    >
      {label}
    </Link>
  );
}

function RecordHeader({
  record,
  onBack,
  t,
}: {
  readonly record: MemoryRecord;
  readonly onBack?: (() => void) | undefined;
  readonly t: I18nTranslate;
}): ReactNode {
  return (
    <header className="mc-detail-header">
      <div className="mc-detail-title-row">
        <h1 className="lk-title" style={{ flex: 1 }}>
          {t("memoria.headerTitle", { type: typeLabel(record.type, t) })}
        </h1>
        {/* static metadata label — role="status" would announce it as a live
            region (uiux-fix F005) */}
        <span className={`mc-badge mc-badge-${record.status}`}>
          {statusLabel(record.status, t)}
        </span>
        {record.pinned ? (
          <span aria-label={t("memoria.pinned")} className="mc-badge mc-badge-pinned">
            {t("memoria.pinned")}
          </span>
        ) : null}
      </div>
      <BackToMemoriaControl onBack={onBack} t={t}>
        {t("memoria.back")}
      </BackToMemoriaControl>
    </header>
  );
}

// ---------------------------------------------------------------------------
// MemoryDetail
// ---------------------------------------------------------------------------

interface MemoryDetailProps {
  readonly id: string;
  readonly fetchMemoryImpl?: typeof fetchMemory;
  readonly onBack?: (() => void) | undefined;
}

export function MemoryDetail({
  id,
  fetchMemoryImpl = fetchMemory,
  onBack,
}: MemoryDetailProps): ReactNode {
  const { t } = useI18n();
  const [record, setRecord] = useState<MemoryRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True after a destructive action (forget/delete) cleared the record — the
  // empty state then confirms the removal and offers a way back instead of a
  // dead-end "Memory not found" (uiux-fix F005).
  const [removed, setRemoved] = useState(false);
  const removedBackControlRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);
  const setRemovedBackControlRef = useCallback(
    (node: HTMLAnchorElement | HTMLButtonElement | null): void => {
      removedBackControlRef.current = node;
    },
    [],
  );

  const handleRecordChange = useCallback((updated: MemoryRecord | null): void => {
    if (updated === null) setRemoved(true);
    setRecord(updated);
  }, []);

  // The forget/delete dialog tries to restore focus to its (now unmounted)
  // trigger button; move focus to the back link so keyboard users keep an
  // anchor after the destructive action.
  useEffect(() => {
    if (removed && record === null) removedBackControlRef.current?.focus();
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
        {t("memoria.loadingMemory")}
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
            {t("memoria.retry")}
          </button>
        </div>
        <p>
          <BackToMemoriaControl onBack={onBack} t={t} />
        </p>
      </>
    );
  }

  if (record === null) {
    return (
      <div className="lk-empty">
        <div>
          <p className="lk-empty-title">
            {removed ? t("memoria.removedTitle") : t("memoria.notFoundTitle")}
          </p>
          <p role="status" aria-live="polite" className="lk-empty-body">
            {removed ? t("memoria.removedBody") : t("memoria.notFoundBody")}
          </p>
          <p>
            <BackToMemoriaControl
              onBack={onBack}
              controlRef={setRemovedBackControlRef}
              t={t}
            />
          </p>
        </div>
      </div>
    );
  }

  return (
    <article
      aria-label={t("memoria.articleLabel", { preview: record.body.slice(0, 60) })}
      className="mc-detail"
    >
      <RecordHeader record={record} onBack={onBack} t={t} />

      <section aria-label={t("memoria.memoryBody")} className="mc-section">
        <h2 className="lk-section-head">{t("memoria.content")}</h2>
        <p className="mc-body-text">{record.body}</p>
      </section>

      <section aria-label={t("memoria.details")} className="mc-section">
        <h2 className="lk-section-head">{t("memoria.details")}</h2>
        <dl className="mc-meta">
          <MetaField label={t("memoria.id")} value={<code className="mc-code">{record.id}</code>} />
          <MetaField label={t("memoria.scope")} value={formatScope(record.scope)} />
          <MetaField label={t("memoria.type")} value={typeLabel(record.type, t)} />
          <MetaField label={t("memoria.created")} value={formatTs(record.createdAt)} />
          <MetaField label={t("memoria.updated")} value={formatTs(record.updatedAt)} />
          {record.staleReason !== undefined ? (
            <MetaField label={t("memoria.staleReason")} value={<em>{record.staleReason}</em>} />
          ) : null}
        </dl>
      </section>

      <ProvenanceSection provenance={record.provenance} t={t} />
      <ValiditySection validity={record.validity} t={t} />

      <section aria-label={t("memoria.tags")} className="mc-section">
        <h2 className="lk-section-head">{t("memoria.tags")}</h2>
        <TagsList tags={record.tags} t={t} />
      </section>

      <section aria-label={t("memoria.actions")} className="mc-section">
        <h2 className="lk-section-head">{t("memoria.actions")}</h2>
        <MemoryActions record={record} onRecordChange={handleRecordChange} />
      </section>
    </article>
  );
}
