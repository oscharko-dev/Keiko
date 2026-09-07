"use client";

// Git client dependency seam (Issue #1574, Epic #1571). Carries forward verbatim the reusable
// internals of the removed GovernedGitFlowCard form surface (contract §2 "replace"): the injectable
// client interface, the default BFF wiring, the typed-code label maps, the error formatter, and the
// mutation-state hook with its seqRef stale-guard. The shell (#1574) consumes only the read methods;
// the carry-forward mutation refs (branchCreate/branchSwitch/stage/unstage/commit*/push*) are the
// documented reuse home for #1575 (changes/diff/commit) and #1576/#1577 (branch/history/sync/PR/merge).

import { useCallback, useRef, useState } from "react";
import type {
  GitCommitMessageViolationCode,
  GitCommitQualityWarningCode,
} from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  cloneRepository as fetchCloneRepository,
  createProject,
  fetchGitBranches,
  fetchGitDeliverySyncPreview,
  fetchGitDeliveryCommitExecute,
  fetchGitDeliveryCommitPreview,
  fetchGitDeliveryMergeApprove,
  fetchGitDeliveryMergeExecute,
  fetchGitDeliveryMergePreview,
  fetchGitDeliveryLocalBranchCreate,
  fetchGitDeliveryLocalBranchSwitch,
  fetchGitDeliveryPrApprove,
  fetchGitDeliveryPrDescriptionApply,
  fetchGitDeliveryPrDescriptionApprove,
  fetchGitDeliveryPrDescriptionPreview,
  fetchGitDeliveryPrDescriptionStatus,
  fetchGitDeliveryPrExecute,
  fetchGitDeliveryPrPreview,
  fetchGitDeliveryPushExecute,
  fetchGitDeliveryPushPreview,
  fetchGitDeliveryStage,
  fetchGitDeliveryUnstage,
  fetchGitDiff,
  fetchGitStructuredDiff,
  fetchGitHistory,
  fetchGitRemotes,
  fetchGitSummary,
  fetchGitStatus,
  fetchProjects,
  proposeCommit,
  proposeGitDeliverySync,
  proposePush,
  reconnectProject,
  type GitDeliveryCommitPreviewResponse,
  type GitDeliveryMutationResponse,
} from "@/lib/api";
import { notifyGitRepositoryStateInvalidated } from "../git-repository-state-events";

// The outcome of any Git mutation. Push execute adds the publish-rejection / recovery fields; they
// are optional so a branch/staging/commit outcome (which omits them) is assignable.
export type GitMutationOutcome = GitDeliveryMutationResponse & {
  readonly publishRejectionReason?: string;
  readonly recoveryDisposition?: string;
  readonly recoveryActionHint?: string;
};

// ─── Injected client (DI seam for tests + #1575-1577 reuse home) ─────────────────────────────────

export interface GitClientSeam {
  // Read surface consumed by the #1574 shell.
  readonly listRepositories: typeof fetchProjects;
  readonly registerRepository: typeof createProject;
  readonly reconnectRepository: typeof reconnectProject;
  readonly cloneRepository: typeof fetchCloneRepository;
  readonly listBranches: typeof fetchGitBranches;
  readonly getSummary: typeof fetchGitSummary;
  readonly getHistory: typeof fetchGitHistory;
  readonly getRemotes: typeof fetchGitRemotes;
  readonly getStatus: typeof fetchGitStatus;
  readonly getDiff: typeof fetchGitDiff;
  readonly getStructuredDiff: typeof fetchGitStructuredDiff;
  // Carry-forward mutation refs (consumed by #1575/#1576/#1577, not by the shell).
  readonly branchCreate: typeof fetchGitDeliveryLocalBranchCreate;
  readonly branchSwitch: typeof fetchGitDeliveryLocalBranchSwitch;
  readonly stage: typeof fetchGitDeliveryStage;
  readonly unstage: typeof fetchGitDeliveryUnstage;
  readonly commitPreview: typeof fetchGitDeliveryCommitPreview;
  readonly commitExecute: typeof fetchGitDeliveryCommitExecute;
  // F3 (epic #3384 final audit): the standalone Git Client Window's commit/push actions must
  // satisfy the epic's unconditional approval requirement (correction 5) themselves — unlike
  // `prApprove`/`prExecute` and `mergeApprove`/`mergeExecute`, whose mint-then-execute pairing is
  // composed by their own card, `commitChanges`/`runPushSync` compose nothing: they call these
  // single mint-then-execute seam entries, which resolve to the static "approval-required"
  // outcome when the mint itself is denied rather than dead-ending (see `proposeCommit`/
  // `proposePush`, api.ts).
  readonly commitPropose: typeof proposeCommit;
  readonly syncPreview: typeof fetchGitDeliverySyncPreview;
  readonly syncExecute: typeof proposeGitDeliverySync;
  readonly pushPreview: typeof fetchGitDeliveryPushPreview;
  readonly pushExecute: typeof fetchGitDeliveryPushExecute;
  readonly pushPropose: typeof proposePush;
  readonly prPreview: typeof fetchGitDeliveryPrPreview;
  // #3387/#3399 (epic #3384, wave8a review): required exactly like `mergeApprove` below — the
  // generic Git window's PR pane always gets the real approval-before-execute path and the
  // preview -> approve -> apply Description panel, never a degraded pre-#3387 unapproved execute
  // or a hidden Description panel. DEFAULT_GIT_CLIENT wires every one of them to the real BFF
  // clients, and every fixture building a `GitClientSeam` must do the same.
  readonly prApprove: typeof fetchGitDeliveryPrApprove;
  readonly prExecute: typeof fetchGitDeliveryPrExecute;
  readonly prDescriptionPreview: typeof fetchGitDeliveryPrDescriptionPreview;
  readonly prDescriptionApprove: typeof fetchGitDeliveryPrDescriptionApprove;
  readonly prDescriptionApply: typeof fetchGitDeliveryPrDescriptionApply;
  readonly prDescriptionStatus: typeof fetchGitDeliveryPrDescriptionStatus;
  readonly mergePreview: typeof fetchGitDeliveryMergePreview;
  readonly mergeApprove: typeof fetchGitDeliveryMergeApprove;
  readonly mergeExecute: typeof fetchGitDeliveryMergeExecute;
}

export const DEFAULT_GIT_CLIENT: GitClientSeam = {
  listRepositories: fetchProjects,
  registerRepository: createProject,
  reconnectRepository: reconnectProject,
  cloneRepository: fetchCloneRepository,
  listBranches: fetchGitBranches,
  getSummary: fetchGitSummary,
  getHistory: fetchGitHistory,
  getRemotes: fetchGitRemotes,
  getStatus: fetchGitStatus,
  getDiff: fetchGitDiff,
  getStructuredDiff: fetchGitStructuredDiff,
  branchCreate: fetchGitDeliveryLocalBranchCreate,
  branchSwitch: fetchGitDeliveryLocalBranchSwitch,
  stage: fetchGitDeliveryStage,
  unstage: fetchGitDeliveryUnstage,
  commitPreview: fetchGitDeliveryCommitPreview,
  commitExecute: fetchGitDeliveryCommitExecute,
  commitPropose: proposeCommit,
  syncPreview: fetchGitDeliverySyncPreview,
  syncExecute: proposeGitDeliverySync,
  pushPreview: fetchGitDeliveryPushPreview,
  pushExecute: fetchGitDeliveryPushExecute,
  pushPropose: proposePush,
  prPreview: fetchGitDeliveryPrPreview,
  prApprove: fetchGitDeliveryPrApprove,
  prExecute: fetchGitDeliveryPrExecute,
  prDescriptionPreview: fetchGitDeliveryPrDescriptionPreview,
  prDescriptionApprove: fetchGitDeliveryPrDescriptionApprove,
  prDescriptionApply: fetchGitDeliveryPrDescriptionApply,
  prDescriptionStatus: fetchGitDeliveryPrDescriptionStatus,
  mergePreview: fetchGitDeliveryMergePreview,
  mergeApprove: fetchGitDeliveryMergeApprove,
  mergeExecute: fetchGitDeliveryMergeExecute,
};

// ─── Label maps (typed codes → human text; never colour-alone) ──────────────────────────────────

const WARNING_LABEL: Readonly<Record<GitCommitQualityWarningCode, string>> = {
  "mixed-scope": "Mixed scope — changes span several areas",
  "wip-marker": "Work-in-progress marker in the subject",
  "large-change": "Large change — many files staged",
  "empty-body": "No commit body",
  "non-conventional-subject": "Subject is not a conventional-commit type",
};

const VIOLATION_LABEL: Readonly<Record<GitCommitMessageViolationCode, string>> = {
  "empty-subject": "The subject line is empty",
  "missing-conventional-prefix": "Missing a conventional-commit type prefix",
  "disallowed-type": "The commit type is not allowed",
  "subject-too-long": "The subject line is too long",
  "missing-issue-key": "Missing the required issue key",
  "missing-signoff": "Missing the Signed-off-by trailer",
};

export const STATUS_LABEL: Readonly<Record<GitDeliveryMutationResponse["status"], string>> = {
  succeeded: "Succeeded",
  blocked: "Blocked",
  "approval-required": "Approval required",
  failed: "Failed",
  "recovery-required": "Recovery required",
};

export function warningLabel(code: GitCommitQualityWarningCode): string {
  return WARNING_LABEL[code];
}

export function violationLabel(code: GitCommitMessageViolationCode): string {
  return VIOLATION_LABEL[code];
}

export function formatGitError(err: unknown): string {
  if (err instanceof ApiError) return `${err.message} (${err.code})`;
  if (err instanceof Error) return err.message;
  return "An unexpected error occurred.";
}

// ─── Mutation-state hook (carried from useGovernedGitActions; consumed by #1575-1577) ─────────────

export interface GitActionFlowState {
  readonly busy: boolean;
  readonly outcome: GitMutationOutcome | null;
  readonly error: string | null;
}

interface MutationFlowController {
  readonly flow: GitActionFlowState;
  readonly runMutation: (op: () => Promise<GitMutationOutcome>) => void;
  readonly resetFlow: () => void;
}

// The mutation half of useGitActions: tracks busy/outcome/error for a single in-flight mutation
// and guards against a late (stale) response overwriting a newer one via seqRef.
function useMutationFlow(projectId: string, repositoryRoot?: string): MutationFlowController {
  const [flow, setFlow] = useState<GitActionFlowState>({
    busy: false,
    outcome: null,
    error: null,
  });
  const seqRef = useRef(0);

  const runMutation = useCallback(
    (op: () => Promise<GitMutationOutcome>): void => {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      setFlow({ busy: true, outcome: null, error: null });
      void op().then(
        (res): void => {
          if (
            res.status === "succeeded" ||
            res.status === "failed" ||
            res.status === "recovery-required"
          ) {
            notifyGitRepositoryStateInvalidated(projectId, repositoryRoot);
          }
          if (seqRef.current === seq) setFlow({ busy: false, outcome: res, error: null });
        },
        (err: unknown): void => {
          if (seqRef.current === seq)
            setFlow({ busy: false, outcome: null, error: formatGitError(err) });
        },
      );
    },
    [projectId, repositoryRoot],
  );

  const resetFlow = useCallback((): void => {
    seqRef.current += 1;
    setFlow({ busy: false, outcome: null, error: null });
  }, []);

  return { flow, runMutation, resetFlow };
}

interface CommitPreviewController {
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewDraft: string | null;
  readonly previewError: string | null;
  readonly runPreview: (messageDraft: string) => void;
  readonly resetPreview: () => void;
}

// The commit-preview half of useGitActions: tracks the last previewed draft/result and guards
// against a late (stale) preview response overwriting a newer one via previewSeqRef.
function useCommitPreviewFlow(client: GitClientSeam, projectId: string): CommitPreviewController {
  const [preview, setPreview] = useState<GitDeliveryCommitPreviewResponse | null>(null);
  const [previewDraft, setPreviewDraft] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewSeqRef = useRef(0);

  const runPreview = useCallback(
    (messageDraft: string): void => {
      const seq = previewSeqRef.current + 1;
      previewSeqRef.current = seq;
      setPreview(null);
      setPreviewDraft(null);
      setPreviewError(null);
      void client.commitPreview({ projectId, messageDraft }).then(
        (res) => {
          if (previewSeqRef.current !== seq) return;
          setPreview(res);
          setPreviewDraft(messageDraft);
        },
        (err: unknown) => {
          if (previewSeqRef.current !== seq) return;
          setPreview(null);
          setPreviewDraft(null);
          setPreviewError(formatGitError(err));
        },
      );
    },
    [client, projectId],
  );

  const resetPreview = useCallback((): void => {
    previewSeqRef.current += 1;
    setPreview(null);
    setPreviewDraft(null);
    setPreviewError(null);
  }, []);

  return { preview, previewDraft, previewError, runPreview, resetPreview };
}

export function useGitActions(
  client: GitClientSeam,
  projectId: string,
  repositoryRoot?: string,
): {
  readonly flow: GitActionFlowState;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewDraft: string | null;
  readonly previewError: string | null;
  readonly runMutation: (op: () => Promise<GitMutationOutcome>) => void;
  readonly runPreview: (messageDraft: string) => void;
  readonly reset: () => void;
} {
  const mutationFlow = useMutationFlow(projectId, repositoryRoot);
  const commitPreview = useCommitPreviewFlow(client, projectId);
  const { resetFlow } = mutationFlow;
  const { resetPreview } = commitPreview;

  // Invalidates any in-flight mutation (so a late response cannot write into this flow) and clears
  // the displayed outcome/preview. Callers reset on repository switch to prevent a stale result from
  // one repository surfacing under another.
  const reset = useCallback((): void => {
    resetFlow();
    resetPreview();
  }, [resetFlow, resetPreview]);

  return {
    flow: mutationFlow.flow,
    preview: commitPreview.preview,
    previewDraft: commitPreview.previewDraft,
    previewError: commitPreview.previewError,
    runMutation: mutationFlow.runMutation,
    runPreview: commitPreview.runPreview,
    reset,
  };
}
