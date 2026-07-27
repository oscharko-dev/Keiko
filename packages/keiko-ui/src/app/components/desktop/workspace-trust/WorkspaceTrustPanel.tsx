"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { WorkspaceTrustStatus } from "@oscharko-dev/keiko-contracts";
import type { ProjectWithAvailability } from "@/lib/types";
import { fetchProjects } from "@/lib/api";
import { useTranslate, type I18nTranslate } from "@/lib/i18n";
import { useWorkspaceTrust } from "./useWorkspaceTrust";
import {
  WorkspaceTrustDecisionDialog,
  WorkspaceTrustFailureDetails,
  workspaceTrustReasonKey,
  type WorkspaceTrustDecision,
} from "./WorkspaceTrustSurfaces";
import styles from "./WorkspaceTrust.module.css";

type TrustRootState = "trusted" | "restricted" | "unavailable";

function rootState(
  status: WorkspaceTrustStatus | undefined,
  issue: "load" | "update" | undefined,
): TrustRootState {
  if (issue === "load") return "unavailable";
  return status?.trust === "trusted" ? "trusted" : "restricted";
}

function stateLabel(state: TrustRootState, t: I18nTranslate): string {
  switch (state) {
    case "unavailable":
      return t("workspaceTrust.unavailable");
    case "restricted":
      return t("workspaceTrust.restrictedMode");
    case "trusted":
      return t("workspaceTrust.trustedMode");
  }
}

function reasonLabel(
  state: TrustRootState,
  status: WorkspaceTrustStatus | undefined,
  t: I18nTranslate,
): string | null {
  if (state === "unavailable") return null;
  if (status === undefined) return t("workspaceTrust.reason.stateUnavailable");
  return t(workspaceTrustReasonKey(status.reason));
}

function issueLabel(issue: "load" | "update", t: I18nTranslate): string {
  return t(issue === "update" ? "workspaceTrust.updateFailed" : "workspaceTrust.loadFailed");
}

function actionLabel(state: TrustRootState, t: I18nTranslate): string {
  switch (state) {
    case "unavailable":
      return t("workspaceTrust.retry");
    case "restricted":
      return t("workspaceTrust.action.trust");
    case "trusted":
      return t("workspaceTrust.action.revoke");
  }
}

function actionClassName(state: TrustRootState): string {
  if (state === "restricted") return `${styles.cmpButton} ${styles.cmpPrimary}`;
  if (state === "trusted") return `${styles.cmpButton} ${styles.cmpDanger}`;
  return `${styles.cmpButton}`;
}

function TrustRootCard({ project }: { readonly project: ProjectWithAvailability }): ReactNode {
  const t = useTranslate();
  const trust = useWorkspaceTrust(project.available ? project.path : undefined);
  const [decision, setDecision] = useState<WorkspaceTrustDecision>();
  const status = trust.status;
  const state = rootState(status, trust.issue);
  const reason = reasonLabel(state, status, t);
  const confirm = async (): Promise<boolean> => {
    if (decision === undefined) return false;
    const confirmed = await (decision === "grant" ? trust.grant() : trust.revoke());
    if (confirmed) setDecision(undefined);
    return confirmed;
  };
  return (
    <li>
      <article className={styles.cmpCard} data-testid="workspace-trust-root">
        <div className={styles.cmpCardCopy}>
          <div className={styles.cmpCardTitle}>{project.name}</div>
          <p className={styles.cmpPath}>{project.path}</p>
          <output className={styles.cmpState} data-trust={state}>
            {stateLabel(state, t)}
          </output>
          {reason === null ? null : <p className={styles.cmpCardReason}>{reason}</p>}
          {trust.issue !== undefined ? (
            <p className={styles.cmpCardReason} role="alert">
              {issueLabel(trust.issue, t)}
            </p>
          ) : null}
          <WorkspaceTrustFailureDetails failure={trust.failure} />
        </div>
        <button
          type="button"
          className={actionClassName(state)}
          disabled={!project.available || trust.loading || trust.mutating}
          onClick={() => {
            if (state === "unavailable") {
              void trust.refresh();
            } else {
              setDecision(state === "restricted" ? "grant" : "revoke");
            }
          }}
        >
          {actionLabel(state, t)}
        </button>
      </article>
      {decision === undefined ? null : (
        <WorkspaceTrustDecisionDialog
          action={decision}
          initialPrompt={false}
          mutating={trust.mutating}
          onCancel={() => setDecision(undefined)}
          onConfirm={confirm}
        />
      )}
    </li>
  );
}

export function WorkspaceTrustPanel(): ReactNode {
  const t = useTranslate();
  const [projects, setProjects] = useState<readonly ProjectWithAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = (): void => {
    setLoading(true);
    setFailed(false);
    void fetchProjects()
      .then((result) => setProjects(result.projects))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  return (
    <section
      className={styles.cmpPanel}
      aria-labelledby="workspace-trust-panel-title"
      data-testid="workspace-trust-panel"
    >
      <header className={styles.cmpPanelHeader}>
        <h2 className={styles.cmpPanelTitle} id="workspace-trust-panel-title">
          {t("workspaceTrust.title")}
        </h2>
        <p className={styles.cmpIntro}>{t("workspaceTrust.management.description")}</p>
        <p className={styles.cmpHelp}>{t("workspaceTrust.management.digestHelp")}</p>
      </header>
      {loading ? <output className={styles.cmpEmpty}>{t("workspaceTrust.loading")}</output> : null}
      {failed ? (
        <div className={styles.cmpAlert} role="alert">
          {t("workspaceTrust.loadFailed")}
          <button type="button" className={styles.cmpButton} onClick={load}>
            {t("workspaceTrust.retry")}
          </button>
        </div>
      ) : null}
      {!loading && !failed && projects.length === 0 ? (
        <p className={styles.cmpEmpty}>{t("workspaceTrust.management.empty")}</p>
      ) : null}
      <ul className={styles.cmpList}>
        {projects.map((project) => (
          <TrustRootCard project={project} key={project.path} />
        ))}
      </ul>
    </section>
  );
}
