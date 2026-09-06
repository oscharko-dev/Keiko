"use client";

// #3390 wave: a governed run's `keiko_verification` tool call is refused WORKSPACE_TRUST_REQUIRED
// when the bound repository has no ADR-0147 package-script trust grant (the runner's own closed
// vocabulary, forwarded body-free to the model — productionManagedWorktreeTools.ts). Before this the
// Workbench offered no way to grant it: the operator had to know about the Editor's own "trust
// workspace scripts" command or the raw POST /api/editor/verification/trust route (2026-09-05 real
// run). This reuses the SAME server-owned status the Editor reads (`useWorkspaceTrust`, which already
// owns the fetch/mutate/event-refresh cycle against `/api/editor/verification/trust`) rather than
// growing a second trust surface (AGENTS.md §5).
//
// The human-control invariant stays intact: this renders one explicit action the operator clicks.
// Nothing here runs the grant automatically or widens authority on the run's behalf — a "restricted"
// status just makes the one exit visible instead of requiring the operator to already know it exists.

import { useEffect, type ReactNode } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { useWorkspaceTrust } from "../../workspace-trust/useWorkspaceTrust";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

export interface CodingWorkbenchTrustAffordanceProps {
  /** The settled active instance's repository root, or null while its binding is unavailable.
   * The verification runner checks this repository's grant and the worktree's matching basis. */
  readonly root: string | null;
}

/**
 * Renders nothing until the bound workspace's trust status resolves as "restricted" — a trusted
 * workspace, an unresolved read, and no bound workspace all render nothing, so the header never
 * claims an action is available when it is not.
 */
export function CodingWorkbenchTrustAffordance({
  root,
}: CodingWorkbenchTrustAffordanceProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const trust = useWorkspaceTrust(root ?? undefined);
  useEffect(() => {
    if (root !== null) {
      reportClientDiagnostic("[keiko] coding workbench repository trust bound");
    }
  }, [root]);
  if (trust.status?.trust !== "restricted") return null;
  return (
    <TrustRestrictedNotice
      granting={trust.mutating}
      onAllow={() => {
        void trust.grant();
      }}
      t={t}
    />
  );
}

function TrustRestrictedNotice({
  granting,
  onAllow,
  t,
}: {
  readonly granting: boolean;
  readonly onAllow: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles.controls} data-testid="coding-workbench-trust-affordance">
      <span className={styles.contextValue}>{t("codingWorkbench.trust.restrictedNotice")}</span>
      <button type="button" className={styles.button} disabled={granting} onClick={onAllow}>
        {granting ? t("codingWorkbench.trust.allowing") : t("codingWorkbench.trust.allow")}
      </button>
    </div>
  );
}
