"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import type { GitRepositorySummary, GitRepositorySummaryRemote } from "@/lib/types";
import { Icons } from "../../../Icons";
import {
  PRIMARY_BTN,
  STATUS_PILL_STYLE,
  SUBTLE_TEXT_STYLE,
  disabledStyle,
} from "./git-client-styles";

export type GitSyncUiAction = "fetch" | "pull" | "push" | "publish-upstream" | "blocked";

export interface GitSyncView {
  readonly action: GitSyncUiAction;
  readonly label: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly remoteAlias?: string | undefined;
  readonly remoteBranchName?: string | undefined;
  readonly sourceBranchName?: string | undefined;
  readonly setUpstreamTracking?: boolean | undefined;
}

function preferredRemote(summary: GitRepositorySummary): GitRepositorySummaryRemote | undefined {
  return summary.remotes.find((remote) => remote.name === "origin") ?? summary.remotes[0];
}

export function deriveSyncView(
  summary: GitRepositorySummary | null,
  loading: boolean,
): GitSyncView {
  if (loading && summary === null) {
    return {
      action: "blocked",
      label: "Sync",
      description: "Checking repository sync state.",
      disabled: true,
    };
  }
  if (summary === null) {
    return {
      action: "blocked",
      label: "Sync",
      description: "Select a repository to sync.",
      disabled: true,
    };
  }
  if (!summary.available) {
    return {
      action: "blocked",
      label: "Sync unavailable",
      description: "Open a Git repository before syncing.",
      disabled: true,
    };
  }
  if (summary.detached) {
    return {
      action: "blocked",
      label: "Detached HEAD",
      description: "Switch to a branch or create a branch before syncing.",
      disabled: true,
    };
  }
  if (summary.conflictedCount > 0) {
    return {
      action: "blocked",
      label: "Resolve conflicts",
      description: "Resolve conflicted files in Changes before syncing.",
      disabled: true,
    };
  }
  const branch = summary.branch ?? "";
  if (branch.length === 0) {
    return {
      action: "blocked",
      label: "No branch",
      description: "Create or switch to a branch before syncing.",
      disabled: true,
    };
  }
  const remote = preferredRemote(summary);
  if (remote === undefined) {
    return {
      action: "blocked",
      label: "No remote",
      description: "Add a Git remote before fetching, pulling, or pushing.",
      disabled: true,
    };
  }
  if (summary.upstream === undefined) {
    return {
      action: "publish-upstream",
      label: "Publish upstream",
      description: `Publish ${branch} to ${remote.name} and set upstream tracking.`,
      disabled: false,
      remoteAlias: remote.name,
      remoteBranchName: branch,
      sourceBranchName: branch,
      setUpstreamTracking: true,
    };
  }
  const remoteAlias = summary.upstream.remote ?? remote.name;
  const remoteBranchName = summary.upstream.branch ?? branch;
  if (summary.ahead > 0 && summary.behind > 0) {
    return {
      action: "fetch",
      label: "Fetch",
      description: `Diverged: ${summary.ahead.toString()} ahead, ${summary.behind.toString()} behind. Fetch latest, then use Merge to reconcile.`,
      disabled: false,
      remoteAlias,
    };
  }
  if (summary.behind > 0) {
    return {
      action: "pull",
      label: "Pull",
      description: `${summary.behind.toString()} behind ${summary.upstream.ref}. Pull fast-forward changes.`,
      disabled: false,
      remoteAlias,
    };
  }
  if (summary.ahead > 0) {
    return {
      action: "push",
      label: "Push",
      description: `${summary.ahead.toString()} ahead of ${summary.upstream.ref}. Push local commits.`,
      disabled: false,
      remoteAlias,
      remoteBranchName,
      sourceBranchName: branch,
      setUpstreamTracking: false,
    };
  }
  return {
    action: "fetch",
    label: "Fetch",
    description: `Up to date with ${summary.upstream.ref}. Fetch checks for remote updates.`,
    disabled: false,
    remoteAlias,
  };
}

export function SyncControl({
  view,
  busy,
  outcome,
  error,
  onRun,
}: {
  readonly view: GitSyncView;
  readonly busy: boolean;
  readonly outcome: string | null;
  readonly error: string | null;
  readonly onRun: () => void;
}): ReactNode {
  const disabled = view.disabled || busy;
  const descriptionId = useId();
  const syncLabelId = useId();
  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <button
        type="button"
        disabled={disabled}
        style={{ ...PRIMARY_BTN, minWidth: 112, ...disabledStyle(disabled) }}
        aria-label={`Run sync: ${busy ? "syncing" : view.label}`}
        aria-describedby={descriptionId}
        onClick={onRun}
      >
        <Icons.reset size={12} /> {busy ? "Syncing" : view.label}
      </button>
      {/* GEN-UI-A11Y-017: role=status derives no accessible name from its own text, and a
          static aria-label duplicating the announced content is the fragile pattern the finding
          flags. Instead the accessible name is composed from REAL rendered content — an sr-only
          "Sync:" context label plus this region's own live text — so name and announcement can
          never diverge. */}
      <span id={syncLabelId} className="rv-sr-only">
        Sync:
      </span>
      <span
        id={descriptionId}
        role={error === null ? "status" : "alert"}
        aria-live="polite"
        aria-atomic="true"
        aria-labelledby={`${syncLabelId} ${descriptionId}`}
        style={{
          ...STATUS_PILL_STYLE,
          maxWidth: 320,
          whiteSpace: "normal",
          color: error === null ? "var(--fg-muted)" : "var(--danger)",
        }}
      >
        {error ?? outcome ?? view.description}
      </span>
      {view.action === "fetch" && view.description.startsWith("Diverged") ? (
        <span style={{ ...SUBTLE_TEXT_STYLE, maxWidth: 320 }}>
          Use the Merge entry point after fetching to reconcile diverged branches.
        </span>
      ) : null}
    </div>
  );
}
