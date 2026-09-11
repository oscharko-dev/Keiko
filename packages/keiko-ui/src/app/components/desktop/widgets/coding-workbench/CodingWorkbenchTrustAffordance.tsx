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
import type {
  CodingWorkbenchOperatorDecision,
  EditorVerificationCatalog,
} from "@oscharko-dev/keiko-contracts";
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
  /**
   * The run's own reason for being paused. `workspace-script-trust` means a governed tool is
   * waiting in place for exactly the decision this affordance offers, so the notice says the run is
   * held rather than merely that scripts could be allowed.
   */
  readonly pauseReason?: CodingWorkbenchOperatorDecision | undefined;
}

type WorktreeScriptTrust = "trusted" | "approval-required";

/**
 * A worktree script-trust decision paired with the root it was read for, so a decision belonging to
 * a since-replaced root can never be mistaken for the current root's decision (see
 * `useWorktreeScriptTrust`).
 */
interface WorktreeScriptTrustState {
  readonly root: string;
  readonly decision: WorktreeScriptTrust | undefined;
}

interface WorktreeTrustGrant {
  readonly granting: boolean;
  readonly grant: () => void;
}

interface PendingTrustDecision {
  readonly notice:
    | "codingWorkbench.trust.restrictedNotice"
    | "codingWorkbench.trust.driftNotice"
    | "codingWorkbench.trust.runWaitingNotice";
  readonly granting: boolean;
  /**
   * False when the action has no root to act on: a run paused for its worktree's decision while the
   * binding carries no worktree root. The notice still explains the pause; the action is disabled
   * rather than rendered as an "Allow" that would grant nothing (CodeRabbit review, 2026-09-10).
   */
  readonly available: boolean;
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
  pauseReason,
}: CodingWorkbenchTrustAffordanceProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const repository = useWorkspaceTrust(binding?.repositoryRoot);
  const worktreeRoot = binding?.worktreeRoot ?? null;
  const worktreeScripts = useWorktreeScriptTrust(worktreeRoot, runRevision);
  const worktreeGrant = useWorktreeTrustGrant(worktreeRoot, binding?.correlationId);
  useTrustBindingDiagnostic(binding);
  if (binding === null) return null;
  const pending = pendingTrustDecision(
    repository,
    worktreeScripts,
    { ...worktreeGrant, available: worktreeRoot !== null },
    pauseReason,
  );
  if (pending === undefined) return null;
  return (
    <TrustRestrictedNotice
      notice={t(pending.notice)}
      granting={pending.granting}
      available={pending.available}
      onAllow={pending.onAllow}
      t={t}
    />
  );
}

// The repository's own restriction comes first: while the repository is restricted, its grant is the
// decision that covers this worktree and every later one. The worktree's own grant is offered ONLY
// once the repository is read as TRUSTED and its grant still does not reach the worktree — a
// rewritten manifest, or a revocation recorded for the worktree itself.
//
// A repository whose status does not resolve at all (unregistered, unreadable) renders nothing: the
// worktree's scripts are approval-required then too, but the operator's next step is to open and
// trust the REPOSITORY, and offering the worktree grant would both name a wrong cause and record a
// decision about a worktree under a repository nobody has approved (2026-09-10, run 9 setup).
function pendingTrustDecision(
  repository: WorkspaceTrustView,
  worktreeScripts: WorktreeScriptTrust | undefined,
  worktreeGrant: WorktreeTrustGrant & { readonly available: boolean },
  pauseReason: CodingWorkbenchOperatorDecision | undefined,
): PendingTrustDecision | undefined {
  // A run held for this exact decision comes first and is stated as such. It is the only branch
  // that does not read the catalog: the server already refused the run's verification for want of
  // the grant, which is a stronger statement of the same fact than a re-read could make, and a
  // catalog read that failed would otherwise hide the notice at the one moment it is load-bearing.
  if (pauseReason === "workspace-script-trust") {
    return {
      notice: "codingWorkbench.trust.runWaitingNotice",
      granting: repository.mutating || worktreeGrant.granting,
      available: worktreeGrant.available,
      onAllow: worktreeGrant.grant,
    };
  }
  if (repository.status?.trust === "restricted") {
    return {
      notice: "codingWorkbench.trust.restrictedNotice",
      granting: repository.mutating,
      available: true,
      onAllow: (): void => {
        void repository.grant();
      },
    };
  }
  if (repository.status?.trust === "trusted" && worktreeScripts === "approval-required") {
    return {
      notice: "codingWorkbench.trust.driftNotice",
      granting: worktreeGrant.granting,
      available: worktreeGrant.available,
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
 *
 * The decision is stored together with the root it was read for (`WorktreeScriptTrustState`). When
 * `root` changes — one run's worktree replaced by another's — the read for the new root has not
 * answered yet, so a decision recorded for the OLD root must never be handed back as if it were the
 * new root's: `pendingTrustDecision` would combine the old root's "approval-required" state with a
 * grant callback already bound to the new root, granting trust to the new worktree on the strength
 * of the old one's decision (CWE-863, CodeRabbit review, PR #3452). The hook therefore returns
 * undefined for every render whose `root` does not match the stored decision's root — the stale
 * decision stays cached underneath so it answers again at once if `root` comes back.
 */
function useWorktreeScriptTrust(
  root: string | null,
  runRevision: number | undefined,
): WorktreeScriptTrust | undefined {
  const [state, setState] = useState<WorktreeScriptTrustState>();
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
      setState(undefined);
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
            if (!controller.signal.aborted) setState({ root, decision: scriptTrustOf(catalog) });
          })
          .catch(() => {
            if (!controller.signal.aborted) setState({ root, decision: undefined });
          });
      },
      immediate || runRevision === undefined ? 0 : WORKTREE_TRUST_SETTLE_MS,
    );
    return (): void => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [root, trustTick, runRevision]);
  // A decision read for a since-replaced root is treated as no decision at all: never shown or
  // acted on while the current root's own catalog read is still in flight.
  return state?.root === root ? state.decision : undefined;
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
  available,
  onAllow,
  t,
}: {
  readonly notice: string;
  readonly granting: boolean;
  readonly available: boolean;
  readonly onAllow: () => void;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles["cmp-trust-notice"]} data-testid="coding-workbench-trust-affordance">
      <span className={styles["cmp-trust-notice-text"]}>{notice}</span>
      <button
        type="button"
        className={styles.button}
        disabled={granting || !available}
        onClick={onAllow}
      >
        {granting ? t("codingWorkbench.trust.allowing") : t("codingWorkbench.trust.allow")}
      </button>
    </div>
  );
}
