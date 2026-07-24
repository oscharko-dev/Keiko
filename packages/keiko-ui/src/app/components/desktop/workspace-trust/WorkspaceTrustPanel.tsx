"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { fetchProjects } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";
import { useWorkspaceTrust } from "./useWorkspaceTrust";
import {
  WorkspaceTrustDecisionDialog,
  workspaceTrustReasonKey,
  type WorkspaceTrustDecision,
} from "./WorkspaceTrustSurfaces";
import styles from "./WorkspaceTrust.module.css";

function TrustRootCard({ project }: { readonly project: ProjectWithAvailability }): ReactNode {
  const t = useTranslate();
  const trust = useWorkspaceTrust(project.available ? project.path : undefined);
  const [decision, setDecision] = useState<WorkspaceTrustDecision>();
  const status = trust.status;
  const restricted = status?.trust !== "trusted";
  const reason =
    status === undefined
      ? t("workspaceTrust.reason.stateUnavailable")
      : t(workspaceTrustReasonKey(status.reason));
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
          <output className={styles.cmpState} data-trust={restricted ? "restricted" : "trusted"}>
            {restricted ? t("workspaceTrust.restrictedMode") : t("workspaceTrust.trustedMode")}
          </output>
          <p className={styles.cmpCardReason}>{reason}</p>
          {trust.issue !== undefined ? (
            <p className={styles.cmpCardReason} role="alert">
              {trust.issue === "update"
                ? t("workspaceTrust.updateFailed")
                : t("workspaceTrust.loadFailed")}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className={`${styles.cmpButton} ${restricted ? styles.cmpPrimary : styles.cmpDanger}`}
          disabled={!project.available || trust.loading || trust.mutating}
          onClick={() => setDecision(restricted ? "grant" : "revoke")}
        >
          {restricted ? t("workspaceTrust.action.trust") : t("workspaceTrust.action.revoke")}
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
