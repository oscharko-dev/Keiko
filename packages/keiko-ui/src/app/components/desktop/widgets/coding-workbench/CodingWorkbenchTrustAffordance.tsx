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
// 2026-09-10 (Coding Workbench run 8): the repository's grant covers the run's worktree only while
// the worktree's `package.json` is byte-identical to the repository's (ADR-0147 D3). A run that
// rewrites that manifest is refused the same code while the repository stays TRUSTED, so the notice
// above never appeared and re-granting the repository could not have helped. The second branch below
// reads the verification runner's own decision for the worktree (the server-owned catalog) and, when
// it is approval-required although the repository is trusted, offers the one exit the runner
// accepts: an explicit grant recorded for the worktree root itself, bound to the rewritten bytes.
//
// The human-control invariant stays intact: this renders one explicit action the operator clicks.
// Nothing here runs a grant automatically or widens authority on the run's behalf — a "restricted"
// status just makes the one exit visible instead of requiring the operator to already know it exists.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorVerificationCatalog } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import {
  fetchVerificationCatalog,
  mutateWorkspaceTrust,
  WORKSPACE_TRUST_CHANGED_EVENT,
  workspaceTrustFailure,
} from "@/lib/workspace-trust-api";
import {
  useWorkspaceTrust,
  type WorkspaceTrustView,
} from "../../workspace-trust/useWorkspaceTrust";
import {
  useCodingWorkbenchTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchRepositoryTrustBinding } from "./useCodingWorkbenchRunWorkspace";
import styles from "./CodingWorkbenchWindow.module.css";

export interface CodingWorkbenchTrustAffordanceProps {
  /** The settled run-bound repository identity, or null while its binding is unavailable. */
  readonly binding: CodingWorkbenchRepositoryTrustBinding | null;
  /**
   * The run snapshot's revision. A change re-reads the worktree's script-trust decision once the
   * run's activity has settled — a verification refused mid-run is exactly the moment the operator
   * needs the exit to appear.
   */
  readonly runRevision?: number | undefined;
}

type WorktreeScriptTrust = "trusted" | "approval-required";

interface WorktreeTrustGrant {
  readonly granting: boolean;
  readonly grant: () => void;
}

interface PendingTrustDecision {
  readonly notice: "codingWorkbench.trust.restrictedNotice" | "codingWorkbench.trust.driftNotice";
  readonly granting: boolean;
  readonly onAllow: () => void;
}

// A run's tool events arrive in bursts; the worktree decision is re-read once they settle.
export const WORKTREE_TRUST_SETTLE_MS = 1500;

/**
 * Renders nothing until an action is actually available — a trusted workspace, an unresolved read,
 * and no bound workspace all render nothing, so the header never claims an action it cannot offer.
 */
export function CodingWorkbenchTrustAffordance({
  binding,
  runRevision,
}: CodingWorkbenchTrustAffordanceProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const repository = useWorkspaceTrust(binding?.repositoryRoot);
  const worktreeRoot = binding?.worktreeRoot ?? null;
  const worktreeScripts = useWorktreeScriptTrust(worktreeRoot, runRevision);
  const worktreeGrant = useWorktreeTrustGrant(worktreeRoot, binding?.correlationId);
  useTrustBindingDiagnostic(binding);
  if (binding === null) return null;
  const pending = pendingTrustDecision(repository, worktreeScripts, worktreeGrant);
  if (pending === undefined) return null;
  return (
    <TrustRestrictedNotice
      notice={t(pending.notice)}
      granting={pending.granting}
      onAllow={pending.onAllow}
      t={t}
    />
  );
}

// The repository's own restriction comes first: while the repository is restricted, its grant is the
// decision that covers this worktree and every later one. Only a TRUSTED repository whose grant no
// longer reaches the worktree (a rewritten manifest) is answered with the worktree's own grant.
function pendingTrustDecision(
  repository: WorkspaceTrustView,
  worktreeScripts: WorktreeScriptTrust | undefined,
  worktreeGrant: WorktreeTrustGrant,
): PendingTrustDecision | undefined {
  if (repository.status?.trust === "restricted") {
    return {
      notice: "codingWorkbench.trust.restrictedNotice",
      granting: repository.mutating,
      onAllow: (): void => {
        void repository.grant();
      },
    };
  }
  if (worktreeScripts === "approval-required") {
    return {
      notice: "codingWorkbench.trust.driftNotice",
      granting: worktreeGrant.granting,
      onAllow: worktreeGrant.grant,
    };
  }
  return undefined;
}

function useTrustBindingDiagnostic(binding: CodingWorkbenchRepositoryTrustBinding | null): void {
  const correlationId = binding?.correlationId;
  const repositoryId = binding?.repositoryId;
  const workspaceId = binding?.workspaceId;
  useEffect(() => {
    if (correlationId !== undefined && repositoryId !== undefined && workspaceId !== undefined) {
      reportClientDiagnostic("[keiko] coding workbench repository trust bound", {
        correlationId,
        workspaceTrustBinding: {
          repositoryId,
          workspaceId,
        },
      });
    }
  }, [correlationId, repositoryId, workspaceId]);
}

function scriptTrustOf(catalog: EditorVerificationCatalog): WorktreeScriptTrust {
  return catalog.kinds.some((entry) => entry.available && entry.trustState === "approval-required")
    ? "approval-required"
    : "trusted";
}

/**
 * The verification runner's OWN package-script decision for the run's worktree, read through the
 * server-owned catalog (`GET /api/editor/verification/catalog`) and never re-derived in the browser
 * from the two trust records — so this surface can neither claim an action the runner would refuse
 * nor hide the one it needs. Re-read immediately on mount and after every trust mutation, and after
 * the settle delay when the run's revision moves. An unreadable decision resolves to undefined: no
 * action is offered on a decision that could not be read.
 */
function useWorktreeScriptTrust(
  root: string | null,
  runRevision: number | undefined,
): WorktreeScriptTrust | undefined {
  const [decision, setDecision] = useState<WorktreeScriptTrust>();
  const [trustTick, setTrustTick] = useState(0);
  const immediateKey = useRef<string>(undefined);
  useEffect(() => {
    const onChanged = (): void => {
      setTrustTick((tick) => tick + 1);
    };
    window.addEventListener(WORKSPACE_TRUST_CHANGED_EVENT, onChanged);
    return (): void => {
      window.removeEventListener(WORKSPACE_TRUST_CHANGED_EVENT, onChanged);
    };
  }, []);
  useEffect(() => {
    if (root === null) {
      immediateKey.current = undefined;
      setDecision(undefined);
      return;
    }
    // A new root or a trust mutation is read at once; a run-revision move alone waits to settle.
    const key = `${root} ${String(trustTick)}`;
    const immediate = immediateKey.current !== key;
    immediateKey.current = key;
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        fetchVerificationCatalog(root, controller.signal)
          .then((catalog) => {
            if (!controller.signal.aborted) setDecision(scriptTrustOf(catalog));
          })
          .catch(() => {
            if (!controller.signal.aborted) setDecision(undefined);
          });
      },
      immediate || runRevision === undefined ? 0 : WORKTREE_TRUST_SETTLE_MS,
    );
    return (): void => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [root, trustTick, runRevision]);
  return decision;
}

/**
 * The explicit grant for the worktree root, through the same client the Editor's trust surface
 * uses; `mutateWorkspaceTrust` broadcasts the change, which re-reads the runner's decision above.
 * A refused grant leaves the action in place and reports the refusal under the correlation id the
 * server answered with (falling back to the run's), never its message.
 */
function useWorktreeTrustGrant(
  root: string | null,
  correlationId: string | undefined,
): WorktreeTrustGrant {
  const [granting, setGranting] = useState(false);
  const grant = useCallback((): void => {
    if (root === null || granting) return;
    setGranting(true);
    mutateWorkspaceTrust(root, "grant")
      .catch((error: unknown) => {
        const refusalCorrelationId = workspaceTrustFailure(error)?.correlationId ?? correlationId;
        reportClientDiagnostic(
          "[keiko] coding workbench worktree trust grant refused",
          refusalCorrelationId === undefined ? undefined : { correlationId: refusalCorrelationId },
        );
      })
      .finally(() => {
        setGranting(false);
      });
  }, [root, granting, correlationId]);
  return { granting, grant };
}

function TrustRestrictedNotice({
  notice,
  granting,
  onAllow,
  t,
}: {
  readonly notice: string;
  readonly granting: boolean;
  readonly onAllow: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles["cmp-trust-notice"]} data-testid="coding-workbench-trust-affordance">
      <span className={styles["cmp-trust-notice-text"]}>{notice}</span>
      <button type="button" className={styles.button} disabled={granting} onClick={onAllow}>
        {granting ? t("codingWorkbench.trust.allowing") : t("codingWorkbench.trust.allow")}
      </button>
    </div>
  );
}
