"use client";

// Issue #2129 — MemoriaViva health scan: orphaned memories, missing cross-references,
// stale-but-not-archived records, and dangling consolidation review items surfaced by
// GET /api/memory/health-scan.
//
// Read-only diagnostic view: MemoryHealthScanFindingWire never carries a proposedAction
// (unlike MemoryConsolidationReviewItemWire) and deliberately omits full memory bodies, so
// there are no accept/reject/archive/merge actions here — only a link to open a referenced
// memory in the existing detail view. Structurally distinct from ReviewQueue (hard-typed on
// MemoryRecord with approve/reject actions) and MemoryConsolidation (job-based ReviewItems
// with proposedAction), so this gets its own component rather than being folded into either.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type {
  MemoryHealthScanFindingKindWire,
  MemoryHealthScanFindingWire,
  MemoryHealthScanMemoryRefWire,
  MemoryHealthScanResultWire,
  MemoryStatus,
  MemoryType,
} from "@oscharko-dev/keiko-contracts";
import { fetchMemoryHealthScan } from "@/lib/memory-api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";

function findingKindLabel(kind: MemoryHealthScanFindingKindWire, t: I18nTranslate): string {
  switch (kind) {
    case "orphan-memory":
      return t("memoria.healthScan.kind.orphanMemory");
    case "missing-cross-reference":
      return t("memoria.healthScan.kind.missingCrossReference");
    case "stale-not-archived":
      return t("memoria.healthScan.kind.staleNotArchived");
    case "dangling-review-item":
      return t("memoria.healthScan.kind.danglingReviewItem");
  }
}

// Mirrors ReviewQueue.tsx's typeLabel/statusLabel switches (same i18n keys) — the health
// scan wire reuses MemoryType/MemoryStatus for its memory refs, so no new i18n keys needed.
function memoryTypeLabel(type: MemoryType, t: I18nTranslate): string {
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

function memoryStatusLabel(status: MemoryStatus, t: I18nTranslate): string {
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

interface MemoryRefItemProps {
  readonly memory: MemoryHealthScanMemoryRefWire;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly t: I18nTranslate;
}

// Pattern mirrors MemoryConsolidation.tsx's MemoryIdLink (uiux-fix F034, C240): a raw id was
// plain text there too, so linking each ref to the detail route keeps findings actionable.
function MemoryRefItem({ memory, onOpenDetail, t }: MemoryRefItemProps): ReactNode {
  const label = t("memoria.healthScan.viewMemory", { id: memory.memoryId });
  return (
    <li className="mc-row-meta">
      {onOpenDetail !== undefined ? (
        <button
          type="button"
          className="mc-id-link mc-link-button"
          aria-label={label}
          onClick={() => onOpenDetail(memory.memoryId)}
        >
          {memory.memoryId}
        </button>
      ) : (
        <Link
          href={`/memoriaviva/detail?id=${encodeURIComponent(memory.memoryId)}`}
          className="mc-id-link"
          aria-label={label}
        >
          {memory.memoryId}
        </Link>
      )}
      <span className="mc-row-type">
        {memoryTypeLabel(memory.type, t)} · {memoryStatusLabel(memory.status, t)}
      </span>
    </li>
  );
}

interface FindingCardProps {
  readonly finding: MemoryHealthScanFindingWire;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly t: I18nTranslate;
}

function FindingCard({ finding, onOpenDetail, t }: FindingCardProps): ReactNode {
  return (
    <li data-finding-id={finding.id}>
      <article className="mc-review-row">
        <div className="mc-review-body">
          <p className="mc-row-body">{findingKindLabel(finding.kind, t)}</p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
            {t("memoria.healthScan.reason")}: {finding.reason}
          </p>
          <span className="mc-row-type">{t("memoria.healthScan.memories")}</span>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {finding.memories.map((memory) => (
              <MemoryRefItem
                key={memory.memoryId}
                memory={memory}
                onOpenDetail={onOpenDetail}
                t={t}
              />
            ))}
          </ul>
        </div>
      </article>
    </li>
  );
}

interface RecordsInspectedNoteProps {
  readonly result: MemoryHealthScanResultWire;
  readonly t: I18nTranslate;
}

// Extracted from HealthScanFindings (SonarCloud S3776) — the "N records inspected" note,
// including its own truncated-suffix ternary, isolated so it doesn't add nesting to the
// section-body branch it's rendered from.
function RecordsInspectedNote({ result, t }: RecordsInspectedNoteProps): ReactNode {
  return (
    <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--text-secondary)" }}>
      {t("memoria.healthScan.recordsInspected", { count: result.recordsInspected })}
      {result.truncated ? ` · ${t("memoria.healthScan.truncated")}` : ""}
    </p>
  );
}

interface HealthScanSectionBodyProps {
  readonly loading: boolean;
  readonly error: string | null;
  readonly findings: readonly MemoryHealthScanFindingWire[];
  readonly result: MemoryHealthScanResultWire | null;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
  readonly onRetry: () => void;
  readonly t: I18nTranslate;
}

// Extracted from HealthScanFindings (SonarCloud S3776) — the loading/error/empty/populated
// decision tree, previously a 4-way nested ternary. Early returns keep each branch at the same
// nesting level instead of nesting inside the previous branch's "else".
function HealthScanSectionBody({
  loading,
  error,
  findings,
  result,
  onOpenDetail,
  onRetry,
  t,
}: HealthScanSectionBodyProps): ReactNode {
  if (loading) {
    return (
      <p role="status" aria-live="polite" className="lk-loading">
        {t("memoria.healthScan.loading")}
      </p>
    );
  }

  if (error !== null) {
    return (
      <div role="alert" aria-live="assertive" className="lk-alert">
        {error}
        <button type="button" className="lk-alert-retry" onClick={onRetry}>
          {t("memoria.retry")}
        </button>
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <div data-testid="health-scan-empty" className="lk-empty">
        <div>
          <p className="lk-empty-title">{t("memoria.healthScan.emptyTitle")}</p>
          <p className="lk-empty-body">{t("memoria.healthScan.emptyBody")}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {result !== null ? <RecordsInspectedNote result={result} t={t} /> : null}
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {findings.map((finding) => (
          <FindingCard key={finding.id} finding={finding} onOpenDetail={onOpenDetail} t={t} />
        ))}
      </ul>
    </>
  );
}

export interface HealthScanFindingsProps {
  readonly fetchImpl?: typeof fetchMemoryHealthScan;
  readonly onBack?: (() => void) | undefined;
  readonly onOpenDetail?: ((id: string) => void) | undefined;
}

export function HealthScanFindings({
  fetchImpl = fetchMemoryHealthScan,
  onBack,
  onOpenDetail,
}: HealthScanFindingsProps): ReactNode {
  const t = useTranslate();
  const [result, setResult] = useState<MemoryHealthScanResultWire | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchImpl();
      setResult(res);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  }, [fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  const findings = result?.findings ?? [];

  return (
    <>
      <header className="lk-header mc-review-header">
        <h1 className="lk-title">{t("memoria.healthScan")}</h1>
        <span role="status" aria-live="polite" className="mc-badge-count">
          {t("memoria.healthScan.findingsCount", { count: findings.length })}
        </span>
        {onBack !== undefined ? (
          <button
            type="button"
            className="lk-btn lk-btn-ghost lk-btn-lg"
            aria-label={t("memoria.backToMemoria")}
            onClick={onBack}
          >
            {t("memoria.back")}
          </button>
        ) : (
          <Link
            href="/memoriaviva"
            className="lk-btn lk-btn-ghost lk-btn-lg"
            aria-label={t("memoria.backToMemoria")}
          >
            {t("memoria.back")}
          </Link>
        )}
      </header>

      <section
        aria-label={t("memoria.healthScan.region")}
        aria-busy={loading}
        style={{ flex: 1, minHeight: 0, overflowY: "auto" }}
      >
        <HealthScanSectionBody
          loading={loading}
          error={error}
          findings={findings}
          result={result}
          onOpenDetail={onOpenDetail}
          onRetry={() => {
            void load();
          }}
          t={t}
        />
      </section>
    </>
  );
}
