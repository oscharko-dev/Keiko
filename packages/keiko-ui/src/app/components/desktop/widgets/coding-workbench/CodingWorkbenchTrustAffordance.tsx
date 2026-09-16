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
// rewrites that manifest is refused the same code while the repository stays TRUSTED, so re-granting
// the repository cannot help. Once the server pauses the run for `workspace-script-trust`, the second
// branch below offers the one exit the runner accepts: an explicit grant recorded for the worktree
// root itself, bound to the rewritten bytes.
//
// The human-control invariant stays intact: this renders one explicit action the operator clicks.
// Nothing here runs a grant automatically or widens authority on the run's behalf — a "restricted"
// status just makes the one exit visible instead of requiring the operator to already know it exists.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { CodingWorkbenchOperatorDecision } from "@oscharko-dev/keiko-contracts";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { mutateWorkspaceTrust, workspaceTrustFailure } from "@/lib/workspace-trust-api";
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
  /** The run snapshot revision that distinguishes one paused decision from the next. */
  readonly runRevision?: number | undefined;
  /**
   * The run's own reason for being paused. `workspace-script-trust` means a governed tool is
   * waiting in place for exactly the decision this affordance offers, so the notice says the run is
   * held rather than merely that scripts could be allowed.
   */
  readonly pauseReason?: CodingWorkbenchOperatorDecision | undefined;
}

interface WorktreeTrustGrant {
  readonly granting: boolean;
  readonly grant: () => Promise<boolean>;
}

interface PendingTrustDecision {
  readonly pauseKey: string;
  readonly notice: "codingWorkbench.trust.runWaitingNotice";
  readonly granting: boolean;
  /**
   * False when the action has no root to act on: a run paused for its worktree's decision while the
   * binding carries no worktree root. The notice still explains the pause; the action is disabled
   * rather than rendered as an "Allow" that would grant nothing (CodeRabbit review, 2026-09-10).
   */
  readonly available: boolean;
  readonly onAllow: () => Promise<boolean>;
}

interface TrustTarget {
  readonly repositoryRoot: string | undefined;
  readonly worktreeRoot: string | null;
  readonly correlationId: string | undefined;
  readonly pauseKey: string | undefined;
}

const noopGrant = (): Promise<boolean> => Promise.resolve(false);

/**
 * Renders nothing until a run is actually waiting on the package-script trust decision. Package
 * scripts are executable code, so the runtime stays fail-closed, but a latent trust mismatch is not a
 * header-level problem while the operator is asking an ordinary question. The blocking notice is
 * therefore load-bearing: it appears only when the server paused the run for this exact decision.
 */
export function CodingWorkbenchTrustAffordance({
  binding,
  runRevision,
  pauseReason,
}: CodingWorkbenchTrustAffordanceProps): ReactNode {
  const t = useCodingWorkbenchTranslate();
  const [acceptedPauseKey, setAcceptedPauseKey] = useState<string>();
  const target = trustTargetOf(binding, runRevision, pauseReason);
  const repository = useWorkspaceTrust(target.repositoryRoot);
  const worktreeGrant = useWorktreeTrustGrant(target.worktreeRoot, target.correlationId);
  useTrustBindingDiagnostic(binding);
  const pending = visiblePendingTrustDecision(repository, worktreeGrant, target, acceptedPauseKey);
  if (pending === undefined) return null;
  const onAllow = (): void => {
    acceptDecision(pending.onAllow, pending.pauseKey, setAcceptedPauseKey);
  };
  return (
    <TrustRestrictedNotice
      notice={t(pending.notice)}
      granting={pending.granting}
      available={pending.available}
      onAllow={onAllow}
      t={t}
    />
  );
}

function trustTargetOf(
  binding: CodingWorkbenchRepositoryTrustBinding | null,
  runRevision: number | undefined,
  pauseReason: CodingWorkbenchOperatorDecision | undefined,
): TrustTarget {
  if (binding === null || pauseReason !== "workspace-script-trust") {
    return {
      repositoryRoot: undefined,
      worktreeRoot: null,
      correlationId: undefined,
      pauseKey: undefined,
    };
  }
  return {
    repositoryRoot: binding.repositoryRoot,
    worktreeRoot: binding.worktreeRoot ?? null,
    correlationId: binding.correlationId,
    pauseKey: pauseDecisionKey(binding, runRevision),
  };
}

function pauseDecisionKey(
  binding: CodingWorkbenchRepositoryTrustBinding,
  runRevision: number | undefined,
): string {
  // #3506 review - the affordance is mounted once for the whole workbench window, so
  // acceptedPauseKey survives run boundaries. Without the active run's identity in the key,
  // a later, different run in the same task workspace that pauses on the same
  // (workspaceId, repositoryId, worktreeRoot, runRevision) triple gets suppressed by the
  // earlier acceptance. binding.correlationId already carries the active run's id
  // (sessionRepositoryTrustBinding.correlationId = runId ?? bound.correlationId), so bind
  // the pause key to it.
  return [
    binding.workspaceId,
    binding.repositoryId,
    binding.worktreeRoot ?? "no-worktree",
    binding.correlationId,
    String(runRevision ?? "unversioned"),
  ].join("\u001F");
}

function visiblePendingTrustDecision(
  repository: WorkspaceTrustView,
  worktreeGrant: WorktreeTrustGrant,
  target: TrustTarget,
  acceptedPauseKey: string | undefined,
): PendingTrustDecision | undefined {
  if (target.pauseKey === undefined) return undefined;
  const pending = pendingTrustDecision(repository, {
    ...worktreeGrant,
    available: target.worktreeRoot !== null,
  });
  // The pause reason moves from repository to worktree once the repository grant lands (the
  // worktree becomes a separate decision after that). Bind the pause key to the grant target so
  // accepting the repository grant does not suppress a still-required worktree grant on the same
  // paused run revision.
  const pauseKey = `${target.pauseKey}${pending.grantTarget}`;
  if (acceptedPauseKey === pauseKey) return undefined;
  const { grantTarget: _grantTarget, ...decision } = pending;
  return { ...decision, pauseKey };
}

function acceptDecision(
  onAllow: () => Promise<boolean>,
  pauseKey: string,
  setAcceptedPauseKey: (pauseKey: string) => void,
): void {
  void onAllow().then((accepted) => {
    if (accepted) setAcceptedPauseKey(pauseKey);
  });
}

// The repository's own restriction comes first while a run is paused: granting the repository is the
// only decision that can cover a matching managed worktree. The worktree's own grant is offered once
// the repository is already trusted, which is the drift case where the task workspace's manifest no
// longer has the repository's trusted basis. A repository whose status does not resolve keeps the
// pause visible but disables the button — no blind grant against an unknown trust subject.
type TrustGrantTarget = "repository" | "worktree" | "unknown-repository";

function pendingTrustDecision(
  repository: WorkspaceTrustView,
  worktreeGrant: WorktreeTrustGrant & { readonly available: boolean },
): Omit<PendingTrustDecision, "pauseKey"> & { readonly grantTarget: TrustGrantTarget } {
  if (repository.status?.trust === "restricted") {
    return {
      notice: "codingWorkbench.trust.runWaitingNotice",
      granting: repository.mutating,
      available: true,
      onAllow: repository.grant,
      grantTarget: "repository",
    };
  }
  if (repository.status?.trust === "trusted") {
    return {
      notice: "codingWorkbench.trust.runWaitingNotice",
      granting: worktreeGrant.granting,
      available: worktreeGrant.available,
      onAllow: worktreeGrant.grant,
      grantTarget: "worktree",
    };
  }
  return {
    notice: "codingWorkbench.trust.runWaitingNotice",
    granting: false,
    available: false,
    onAllow: noopGrant,
    grantTarget: "unknown-repository",
  };
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

/**
 * The explicit grant for the worktree root, through the same client the Editor's trust surface
 * uses. A refused grant leaves the action in place and reports the refusal under the correlation id
 * the server answered with (falling back to the run's), never its message.
 */
function useWorktreeTrustGrant(
  root: string | null,
  correlationId: string | undefined,
): WorktreeTrustGrant {
  const [granting, setGranting] = useState(false);
  const grant = useCallback(async (): Promise<boolean> => {
    if (root === null || granting) return false;
    setGranting(true);
    try {
      await mutateWorkspaceTrust(root, "grant");
      return true;
    } catch (error) {
      const refusalCorrelationId = workspaceTrustFailure(error)?.correlationId ?? correlationId;
      reportClientDiagnostic(
        "[keiko] coding workbench worktree trust grant refused",
        refusalCorrelationId === undefined ? undefined : { correlationId: refusalCorrelationId },
      );
      return false;
    } finally {
      setGranting(false);
    }
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
