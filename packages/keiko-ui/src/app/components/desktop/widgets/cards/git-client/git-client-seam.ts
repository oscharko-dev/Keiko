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
  fetchGitDeliverySyncExecute,
  fetchGitDeliverySyncPreview,
  fetchGitDeliveryCommitExecute,
  fetchGitDeliveryCommitPreview,
  fetchGitDeliveryMergeExecute,
  fetchGitDeliveryMergePreview,
  fetchGitDeliveryLocalBranchCreate,
  fetchGitDeliveryLocalBranchSwitch,
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
  type GitDeliveryCommitPreviewResponse,
  type GitDeliveryMutationResponse,
} from "@/lib/api";

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
  readonly syncPreview: typeof fetchGitDeliverySyncPreview;
  readonly syncExecute: typeof fetchGitDeliverySyncExecute;
  readonly pushPreview: typeof fetchGitDeliveryPushPreview;
  readonly pushExecute: typeof fetchGitDeliveryPushExecute;
  readonly prPreview: typeof fetchGitDeliveryPrPreview;
  readonly prExecute: typeof fetchGitDeliveryPrExecute;
  readonly mergePreview: typeof fetchGitDeliveryMergePreview;
  readonly mergeExecute: typeof fetchGitDeliveryMergeExecute;
}

export const DEFAULT_GIT_CLIENT: GitClientSeam = {
  listRepositories: fetchProjects,
  registerRepository: createProject,
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
  syncPreview: fetchGitDeliverySyncPreview,
  syncExecute: fetchGitDeliverySyncExecute,
  pushPreview: fetchGitDeliveryPushPreview,
  pushExecute: fetchGitDeliveryPushExecute,
  prPreview: fetchGitDeliveryPrPreview,
  prExecute: fetchGitDeliveryPrExecute,
  mergePreview: fetchGitDeliveryMergePreview,
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

export function useGitActions(
  client: GitClientSeam,
  projectId: string,
): {
  readonly flow: GitActionFlowState;
  readonly preview: GitDeliveryCommitPreviewResponse | null;
  readonly previewDraft: string | null;
  readonly previewError: string | null;
  readonly runMutation: (op: () => Promise<GitMutationOutcome>) => void;
  readonly runPreview: (messageDraft: string) => void;
  readonly reset: () => void;
} {
  const [flow, setFlow] = useState<GitActionFlowState>({
    busy: false,
    outcome: null,
    error: null,
  });
  const [preview, setPreview] = useState<GitDeliveryCommitPreviewResponse | null>(null);
  const [previewDraft, setPreviewDraft] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const previewSeqRef = useRef(0);

  const runMutation = useCallback((op: () => Promise<GitMutationOutcome>): void => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setFlow({ busy: true, outcome: null, error: null });
    void op().then(
      (res) => {
        if (seqRef.current === seq) setFlow({ busy: false, outcome: res, error: null });
      },
      (err: unknown) => {
        if (seqRef.current === seq)
          setFlow({ busy: false, outcome: null, error: formatGitError(err) });
      },
    );
  }, []);

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

  // Invalidates any in-flight mutation (so a late response cannot write into this flow) and clears
  // the displayed outcome/preview. Callers reset on repository switch to prevent a stale result from
  // one repository surfacing under another.
  const reset = useCallback((): void => {
    seqRef.current += 1;
    previewSeqRef.current += 1;
    setFlow({ busy: false, outcome: null, error: null });
    setPreview(null);
    setPreviewDraft(null);
    setPreviewError(null);
  }, []);

  return { flow, preview, previewDraft, previewError, runMutation, runPreview, reset };
}
