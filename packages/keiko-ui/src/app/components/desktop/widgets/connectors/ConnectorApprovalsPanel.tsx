// Issue #2245 (Epic #2238, ADR-0128 D4, ADR-0125) — the write-action approval surface.
//
// Renders the pending review-required connector actions from GET /action-approvals with the action
// type, target identifier, and disposition context (risk + review reason). Approve executes and
// shows the typed result (success, or a closed write-failure reason, or — when the envelope is
// revalidated at approve time and fails — a content-free denied reason). Reject records the
// rejection without executing. Every control is a native button; the surface is keyboard-operable
// end to end. Approval-UX vocabulary matches the editor lane (Approve / Reject / disposition).

"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { AtlassianConnectorPendingApproval } from "@oscharko-dev/keiko-contracts";
import { ApiError } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import type {
  ApproveAtlassianConnectorActionResult,
  AtlassianConnectorsClient,
} from "@/lib/atlassian-connectors-api";
import {
  actionTypeLabelKey,
  deniedReasonCopyKey,
  dispositionLabelKey,
  reviewReasonCopyKey,
  riskLabelKey,
  writeFailureReasonKey,
} from "./connector-labels";
import { Notice } from "./Notice";

export type ApprovalsClient = Pick<
  AtlassianConnectorsClient,
  "listApprovals" | "approveAction" | "rejectAction"
>;

type Outcome =
  | { readonly kind: "approved"; readonly result: ApproveAtlassianConnectorActionResult }
  | { readonly kind: "rejected" };

interface ApprovalsController {
  readonly approvals: readonly AtlassianConnectorPendingApproval[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly outcomes: ReadonlyMap<string, Outcome>;
  readonly busyId: string | undefined;
  readonly approve: (id: string) => void;
  readonly reject: (id: string) => void;
}

function useApprovals(client: ApprovalsClient): ApprovalsController {
  const t = useTranslate();
  const [approvals, setApprovals] = useState<readonly AtlassianConnectorPendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, Outcome>>(new Map());
  const [busyId, setBusyId] = useState<string | undefined>();
  const fail = (error_: unknown): void => {
    setError(error_ instanceof ApiError ? error_.message : t("atlassianConnectors.retry"));
  };
  const record = (id: string, outcome: Outcome): void => {
    setOutcomes((current) => new Map(current).set(id, outcome));
  };
  useEffect(() => {
    let active = true;
    client
      .listApprovals()
      .then((list) => {
        if (active) setApprovals(list);
      })
      .catch((error_: unknown) => {
        if (active) fail(error_);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot load on mount by design.
  }, [client]);
  const act = (id: string, run: () => Promise<Outcome>): void => {
    setBusyId(id);
    setError(undefined);
    run()
      .then((outcome) => record(id, outcome))
      .catch(fail)
      .finally(() => setBusyId(undefined));
  };
  const approve = (id: string): void => {
    act(id, async () => ({ kind: "approved", result: await client.approveAction(id) }));
  };
  const reject = (id: string): void => {
    act(id, async () => {
      await client.rejectAction(id);
      return { kind: "rejected" };
    });
  };
  return { approvals, loading, error, outcomes, busyId, approve, reject };
}

function ApprovalResultNotice({
  result,
}: {
  readonly result: ApproveAtlassianConnectorActionResult;
}): ReactNode {
  const t = useTranslate();
  if (result.disposition === "denied") {
    return (
      <Notice
        tone="danger"
        testId="acx-approval-denied"
        labelKey="atlassianConnectors.denied.title"
        body={t(deniedReasonCopyKey(result.reasonCode))}
      />
    );
  }
  if (result.result?.status === "failed") {
    return (
      <Notice
        tone="danger"
        testId="acx-approval-result"
        labelKey="atlassianConnectors.result.failedTitle"
        body={t(writeFailureReasonKey(result.result.reason))}
      />
    );
  }
  const target = result.result?.status === "succeeded" ? result.result.targetRef : undefined;
  return (
    <Notice
      tone="ok"
      testId="acx-approval-result"
      labelKey="atlassianConnectors.result.succeededTitle"
      body={
        target === undefined
          ? t("atlassianConnectors.result.succeeded")
          : t("atlassianConnectors.result.succeededTarget", { target })
      }
    />
  );
}

function OutcomeView({ outcome }: { readonly outcome: Outcome }): ReactNode {
  const t = useTranslate();
  if (outcome.kind === "rejected") {
    return (
      <Notice
        tone="muted"
        testId="acx-approval-rejected"
        labelKey="atlassianConnectors.disposition.denied"
        body={t("atlassianConnectors.approvals.rejected")}
      />
    );
  }
  return <ApprovalResultNotice result={outcome.result} />;
}

function ApprovalMeta({
  approval,
}: {
  readonly approval: AtlassianConnectorPendingApproval;
}): ReactNode {
  const t = useTranslate();
  const target = approval.targetRef ?? "—";
  return (
    <p className="acx-meta">
      {`${t("atlassianConnectors.approvals.target")}: ${target} · ${t("atlassianConnectors.approvals.risk")}: ${t(riskLabelKey(approval.risk))} · ${t("atlassianConnectors.approvals.disposition")}: ${t(dispositionLabelKey("review-required"))}`}
      <br />
      {`${t("atlassianConnectors.approvals.reason")}: ${t(reviewReasonCopyKey(approval.reviewReason))}`}
    </p>
  );
}

function ApprovalActions({
  id,
  busy,
  onApprove,
  onReject,
}: {
  readonly id: string;
  readonly busy: boolean;
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className="acx-actions">
      <button
        type="button"
        className="lk-btn lk-btn-primary"
        disabled={busy}
        onClick={() => onApprove(id)}
      >
        {busy
          ? t("atlassianConnectors.approvals.approving")
          : t("atlassianConnectors.approvals.approve")}
      </button>
      <button type="button" className="lk-btn" disabled={busy} onClick={() => onReject(id)}>
        {busy
          ? t("atlassianConnectors.approvals.rejecting")
          : t("atlassianConnectors.approvals.reject")}
      </button>
    </div>
  );
}

function ApprovalRow({
  approval,
  ctrl,
}: {
  readonly approval: AtlassianConnectorPendingApproval;
  readonly ctrl: ApprovalsController;
}): ReactNode {
  const t = useTranslate();
  const outcome = ctrl.outcomes.get(approval.approvalId);
  return (
    <li className="acx-card" data-testid="acx-approval" data-approval-id={approval.approvalId}>
      <p className="acx-card-title">{t(actionTypeLabelKey(approval.actionType))}</p>
      <ApprovalMeta approval={approval} />
      {outcome === undefined ? (
        <ApprovalActions
          id={approval.approvalId}
          busy={ctrl.busyId === approval.approvalId}
          onApprove={ctrl.approve}
          onReject={ctrl.reject}
        />
      ) : (
        <OutcomeView outcome={outcome} />
      )}
    </li>
  );
}

export function ConnectorApprovalsPanel({
  client,
}: {
  readonly client: ApprovalsClient;
}): ReactNode {
  const t = useTranslate();
  const ctrl = useApprovals(client);
  return (
    <section
      className="acx-section"
      data-testid="acx-approvals"
      aria-labelledby="acx-approvals-title"
    >
      <h3 className="acx-section-title" id="acx-approvals-title">
        {t("atlassianConnectors.approvals.title")}
      </h3>
      {ctrl.error !== undefined ? (
        <p className="acx-error" role="alert">
          {ctrl.error}
        </p>
      ) : null}
      {ctrl.loading ? <p className="acx-muted">{t("atlassianConnectors.loading")}</p> : null}
      {!ctrl.loading && ctrl.approvals.length === 0 ? (
        <p className="acx-empty">{t("atlassianConnectors.approvals.empty")}</p>
      ) : null}
      <ul className="acx-list">
        {ctrl.approvals.map((approval) => (
          <ApprovalRow key={approval.approvalId} approval={approval} ctrl={ctrl} />
        ))}
      </ul>
    </section>
  );
}
