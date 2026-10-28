"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  BrowserApprovalDescriptor,
  BrowserApprovalRequestDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/coding-app-session";
import { approveBrowserRequest, revokeBrowserApproval } from "@/lib/browser-approval-api";
import { useOptionalWidgetTranslate as useTranslate } from "@/lib/optional-widget-i18n";
import { notifyCodingAppSessionChanged } from "@/lib/coding-app-session-client";
import { createBrowserApprovalKeyStore } from "@/lib/browser-approval-key-store";
import { useBrowserApprovalInventory } from "./useBrowserApprovalInventory";
import styles from "./BrowserApproval.module.css";

interface BrowserDecision {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly run: (
    action: (signal: AbortSignal) => Promise<{ readonly state: string }>,
  ) => Promise<void>;
}

function useBrowserDecision(refresh: () => void): BrowserDecision {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => (): void => active.current?.abort(), []);
  const run: BrowserDecision["run"] = async (action) => {
    if (active.current !== undefined) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setFailed(false);
    try {
      const result = await action(controller.signal);
      controller.signal.throwIfAborted();
      setFailed(result.state !== "accepted");
      if (result.state === "accepted") notifyCodingAppSessionChanged();
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) {
        active.current = undefined;
        setBusy(false);
        refresh();
      }
    }
  };
  return { busy, failed, run };
}

export function BrowserApprovalSettings(): ReactNode {
  const t = useTranslate();
  const inventory = useBrowserApprovalInventory(true);
  const decision = useBrowserDecision(inventory.refresh);
  const result = inventory.result;
  return (
    <section className={styles.cmpPanel} aria-label={t("browserApproval.manage")}>
      <header className={styles.cmpHeading}>
        <h3>{t("browserApproval.manage")}</h3>
        <button type="button" onClick={inventory.refresh}>
          {t("browserApproval.refresh")}
        </button>
      </header>
      <p>{t("browserApproval.manageDescription")}</p>
      <LocalRememberedConnection decision={decision} />
      {inventory.failed || decision.failed ? (
        <p role="alert">{t("browserApproval.failed")}</p>
      ) : null}
      {result?.state === "active" ? (
        <>
          <h4>{t("browserApproval.pendingRequests")}</h4>
          {result.requests.length === 0 ? <p>{t("browserApproval.noRequests")}</p> : null}
          <ul>
            {result.requests.map((request) => (
              <PendingRequest key={request.requestId} request={request} decision={decision} />
            ))}
          </ul>
          <h4>{t("browserApproval.approvals")}</h4>
          {result.approvals.length === 0 ? <p>{t("browserApproval.noApprovals")}</p> : null}
          <ul>
            {result.approvals.map((approval) => (
              <ApprovedBrowser key={approval.approvalId} approval={approval} decision={decision} />
            ))}
          </ul>
        </>
      ) : (
        <p>
          {t(
            result === undefined
              ? "browserApproval.working"
              : "browserApproval.managementUnavailable",
          )}
        </p>
      )}
    </section>
  );
}

function LocalRememberedConnection({
  decision,
}: {
  readonly decision: BrowserDecision;
}): ReactNode {
  const t = useTranslate();
  const [forgotten, setForgotten] = useState(false);
  const forget = (): void => {
    void decision.run(async (signal) => {
      await createBrowserApprovalKeyStore(window.location.origin).forget();
      signal.throwIfAborted();
      setForgotten(true);
      return { state: "accepted" };
    });
  };
  return (
    <section>
      <p>{t("browserApproval.forgetDescription")}</p>
      <button type="button" disabled={decision.busy} onClick={forget}>
        {t("browserApproval.forget")}
      </button>
      {forgotten ? (
        <p>
          <output>{t("browserApproval.forgotten")}</output>
        </p>
      ) : null}
    </section>
  );
}

function approveRequest(
  request: BrowserApprovalRequestDescriptor,
  decision: BrowserDecision,
  remember: boolean,
): void {
  void decision.run((signal) =>
    approveBrowserRequest(
      { requestId: request.requestId, comparisonCode: request.comparisonCode, remember },
      signal,
    ),
  );
}

function PendingRequest({
  request,
  decision,
}: {
  readonly request: BrowserApprovalRequestDescriptor;
  readonly decision: BrowserDecision;
}): ReactNode {
  const t = useTranslate();
  const [compared, setCompared] = useState(false);
  return (
    <li>
      <output className={styles.cmpCode} aria-label={t("browserApproval.code")}>
        {request.comparisonCode}
      </output>
      <p className={styles.cmpMetadata}>
        {t("browserApproval.fingerprint", { fingerprint: request.publicKeyFingerprint })}
      </p>
      <p>
        {t("browserApproval.expires", { time: new Date(request.expiresAtMs).toLocaleString() })}
      </p>
      <label className={styles.cmpRemember}>
        <input
          type="checkbox"
          checked={compared}
          disabled={decision.busy}
          onChange={(event) => setCompared(event.target.checked)}
        />
        {t("browserApproval.compared")}
      </label>
      <div className={styles.cmpActions}>
        <button
          type="button"
          disabled={!compared || decision.busy}
          onClick={() => approveRequest(request, decision, false)}
        >
          {t("browserApproval.allowOnce")}
        </button>
        {request.rememberRequested ? (
          <button
            type="button"
            disabled={!compared || decision.busy}
            onClick={() => approveRequest(request, decision, true)}
          >
            {t("browserApproval.allowRemembered")}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ApprovedBrowser({
  approval,
  decision,
}: {
  readonly approval: BrowserApprovalDescriptor;
  readonly decision: BrowserDecision;
}): ReactNode {
  const t = useTranslate();
  return (
    <li>
      <strong>
        {t(approval.remembered ? "browserApproval.remembered" : "browserApproval.sessionOnly")}
      </strong>
      <p className={styles.cmpMetadata}>
        {t("browserApproval.fingerprint", { fingerprint: approval.publicKeyFingerprint })}
      </p>
      <p>
        {t("browserApproval.expires", { time: new Date(approval.expiresAtMs).toLocaleString() })}
      </p>
      <p>
        {t("browserApproval.lastUsed", { time: new Date(approval.lastUsedAtMs).toLocaleString() })}
      </p>
      <button
        type="button"
        disabled={decision.busy}
        onClick={() => {
          void decision.run((signal) => revokeBrowserApproval(approval.approvalId, signal));
        }}
      >
        {t("browserApproval.revoke")}
      </button>
    </li>
  );
}
