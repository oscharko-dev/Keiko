"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EvidenceConnectedContextAudit } from "@oscharko-dev/keiko-contracts/evidence";
import type { ClientDiagnosticEvidenceInspection } from "@oscharko-dev/keiko-contracts/runtime/diagnostics";
import { isRootRelativeFileIdentifier } from "@oscharko-dev/keiko-contracts/runtime/editor-workspace-path";
import { fetchEvidenceManifest } from "@/lib/api";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { clientErrorEvidence } from "@/lib/client-error-evidence";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import { copyTextToClipboard } from "@/lib/clipboard";
import { formatBytes } from "@/lib/format";
import { useOptionalWidgetTranslate } from "@/lib/optional-widget-i18n";
import type { GroundedAnswerContextPackSummary } from "@/lib/types";
import { connectedOmissionLabel, connectedRetrievalNotices } from "./connectedEvidencePresentation";
import styles from "./ConnectedEvidenceInspection.module.css";

export interface ConnectedEvidenceInspectionProps {
  readonly contextPack: GroundedAnswerContextPackSummary;
  readonly runIds: readonly string[];
  readonly citationBehaviour?: "cites" | "cites-after-repair" | "never" | undefined;
  readonly attachedCitationCount?: number | undefined;
  readonly onReadPaths?:
    | ((
        runId: string,
        paths: readonly string[],
        selectedPaths: readonly string[],
        sourceScopeFingerprint?: string,
      ) => void)
    | undefined;
}

export function reportEvidenceInspection(
  inspection: ClientDiagnosticEvidenceInspection,
  failure?: unknown,
): void {
  reportClientDiagnostic("client.evidence.inspected", {
    correlationId: newClientCorrelationId(),
    evidenceInspection: inspection,
    ...(failure === undefined
      ? {}
      : { errorKind: bffRequestErrorKind(failure), errorEvidence: clientErrorEvidence(failure) }),
  });
}

type InspectionState =
  | { readonly kind: "pending" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly audit: EvidenceConnectedContextAudit };

function recordLoadedInspection(
  runId: string,
  audit: EvidenceConnectedContextAudit,
  onRead: ConnectedEvidenceInspectionProps["onReadPaths"],
): void {
  onRead?.(
    runId,
    audit.files.map((file) => file.scopePath).filter(isRootRelativeFileIdentifier),
    audit.scope.selectedPaths,
    audit.scope.sourceScopeFingerprint,
  );
  reportEvidenceInspection({
    reason: "file-table-opened",
    readFileCount: audit.files.length,
    omittedFileCount: audit.omitted.length,
  });
}

function useManifestInspection(
  runId: string,
  open: boolean,
  onReadPaths: ConnectedEvidenceInspectionProps["onReadPaths"],
): InspectionState {
  const [state, setState] = useState<InspectionState>({ kind: "pending" });
  const completed = useRef<
    | {
        readonly runId: string;
        readonly audit: EvidenceConnectedContextAudit;
      }
    | undefined
  >(undefined);
  const onRead = useRef(onReadPaths);
  useEffect(() => {
    onRead.current = onReadPaths;
  }, [onReadPaths]);
  useEffect(() => {
    if (!open) return;
    if (completed.current?.runId === runId) {
      setState({ kind: "loaded", audit: completed.current.audit });
      recordLoadedInspection(runId, completed.current.audit, onRead.current);
      return;
    }
    let current = true;
    const notifyRead = onRead.current;
    setState({ kind: "pending" });
    void fetchEvidenceManifest(runId)
      .then((response) => {
        if (!current) return;
        const audit = response.manifest.connectedContext;
        if (response.manifest.run.runId !== runId || audit === undefined)
          throw new TypeError("INVALID_CONNECTED_EVIDENCE_MANIFEST");
        completed.current = { runId, audit };
        setState({ kind: "loaded", audit });
        recordLoadedInspection(runId, audit, notifyRead);
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setState({ kind: "failed" });
        reportEvidenceInspection({ reason: "manifest-fetch-failed" }, failure);
      });
    return (): void => {
      current = false;
    };
  }, [runId, open]);
  return state;
}

function EvidencePath({ path }: { readonly path: string }): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [status, setStatus] = useState("");
  return (
    <>
      <code>{path}</code>{" "}
      <button
        type="button"
        aria-label={t("grounded.files.copyPath", { path })}
        onClick={() => {
          void copyTextToClipboard(path).then(
            () => setStatus(t("grounded.files.copied")),
            (failure: unknown) => {
              setStatus(t("grounded.files.copyFailed"));
              reportClientDiagnostic("evidence-path-copy-failed", {
                correlationId: newClientCorrelationId(),
                kind: "other",
                errorKind: bffRequestErrorKind(failure),
                errorEvidence: clientErrorEvidence(failure),
              });
            },
          );
        }}
      >
        {t("grounded.files.copy")}
      </button>
      <span role="status">{status}</span>
    </>
  );
}

function ReadFilesTable({ audit }: { readonly audit: EvidenceConnectedContextAudit }): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <table>
      <caption>{t("grounded.files.assembled")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("grounded.files.path")}</th>
          <th scope="col">{t("grounded.files.lines")}</th>
          <th scope="col">{t("grounded.files.bytes")}</th>
        </tr>
      </thead>
      <tbody>
        {audit.files.map((file, index) => (
          <tr key={`${file.scopePath}-${String(index)}`}>
            <td>
              <EvidencePath path={file.scopePath} />
            </td>
            <td>
              {file.excerpts
                .map((excerpt) =>
                  excerpt.lineRange === undefined
                    ? "—"
                    : `${String(excerpt.lineRange.startLine)}–${String(excerpt.lineRange.endLine)}`,
                )
                .join(", ")}
            </td>
            <td>{formatBytes(file.excerptBytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OmittedFilesTable({
  audit,
}: {
  readonly audit: EvidenceConnectedContextAudit;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <table>
      <caption>{t("grounded.files.omitted")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("grounded.files.path")}</th>
          <th scope="col">{t("grounded.files.reason")}</th>
        </tr>
      </thead>
      <tbody>
        {audit.omitted.map((file, index) => (
          <tr key={`${file.scopePath}-${String(index)}`}>
            <td>
              <EvidencePath path={file.scopePath} />
            </td>
            <td>{connectedOmissionLabel(file.reason, t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ManifestInspection({
  runId,
  onReadPaths,
}: {
  readonly runId: string;
  readonly onReadPaths: ConnectedEvidenceInspectionProps["onReadPaths"];
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [open, setOpen] = useState(false);
  const state = useManifestInspection(runId, open, onReadPaths);
  return (
    <details className={styles.files} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("grounded.files.inspect")}</summary>
      {open && state.kind === "pending" ? <p role="status">{t("grounded.files.loading")}</p> : null}
      {open && state.kind === "failed" ? <p role="alert">{t("grounded.files.failed")}</p> : null}
      {open && state.kind === "loaded" ? (
        <>
          <p>
            {t("grounded.files.scope", {
              scope: state.audit.scope.selectedPaths.join(", ") || t("grounded.files.root"),
            })}
          </p>
          <p>{t("grounded.files.manifestBoundary")}</p>
          <ReadFilesTable audit={state.audit} />
          <OmittedFilesTable audit={state.audit} />
          {state.audit.summary.omittedCount > state.audit.omitted.length ? (
            <p>{t("grounded.files.boundedDetail")}</p>
          ) : null}
        </>
      ) : null}
    </details>
  );
}

function retrievalNoticeTooltip(pack: GroundedAnswerContextPackSummary): string {
  return [
    pack.semanticProviderDisposition,
    pack.reranker?.status,
    pack.reranker?.failureKind,
    pack.scopeContextState,
    pack.selectionConfidence,
  ]
    .filter((value) => value !== undefined)
    .join(" · ");
}

export function ConnectedRetrievalNotice({
  contextPack,
}: {
  readonly contextPack: GroundedAnswerContextPackSummary;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  const notices = connectedRetrievalNotices(contextPack, t);
  return notices.length === 0 ? null : (
    <p role="note" title={retrievalNoticeTooltip(contextPack)}>
      {notices.join(" · ")}
    </p>
  );
}

export function ConnectedEvidenceInspection(props: ConnectedEvidenceInspectionProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  return (
    <section className={styles.inspection} aria-label={t("grounded.files.inspection")}>
      {props.citationBehaviour === "never" || props.citationBehaviour === "cites-after-repair" ? (
        <p>
          {t(
            (props.attachedCitationCount ?? 0) > 0
              ? "grounded.files.capability"
              : "grounded.files.capabilityUnattached",
          )}
        </p>
      ) : null}
      {Array.from(new Set(props.runIds)).map((runId) => (
        <ManifestInspection key={runId} runId={runId} onReadPaths={props.onReadPaths} />
      ))}
    </section>
  );
}
