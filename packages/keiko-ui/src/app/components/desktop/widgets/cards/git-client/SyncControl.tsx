"use client";

import { useId } from "react";
import type { ReactNode } from "react";
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import { OPTIONAL_WIDGET_EN_MESSAGES } from "@/lib/i18n-messages.optional.en";
import type { GitRepositorySummary, GitRepositorySummaryRemote } from "@/lib/types";
import { Icons } from "../../../Icons";
import { PRIMARY_BTN, SECONDARY_BTN, SUBTLE_TEXT_STYLE, disabledStyle } from "./git-client-styles";
import type { SyncOutcomeView } from "./sync-outcome";

// PascalCase aliases so the JSX tag itself signals "component", not member access (S6770).
const ResetIcon = Icons.reset;

type GitSyncUiAction = "fetch" | "pull" | "push" | "publish-upstream" | "blocked";

export interface GitSyncView {
  readonly action: GitSyncUiAction;
  readonly label: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly diverged?: boolean | undefined;
  readonly remoteAlias?: string | undefined;
  readonly remoteBranchName?: string | undefined;
  readonly sourceBranchName?: string | undefined;
  readonly setUpstreamTracking?: boolean | undefined;
}

function preferredRemote(summary: GitRepositorySummary): GitRepositorySummaryRemote | undefined {
  return summary.remotes.find((remote) => remote.name === "origin") ?? summary.remotes[0];
}

function englishSyncTranslate(
  key: Parameters<OptionalWidgetTranslate>[0],
  values?: Record<string, string | number>,
): string {
  const catalog: Readonly<Record<string, string>> = OPTIONAL_WIDGET_EN_MESSAGES;
  const template = catalog[key] ?? key;
  return template.replace(/\{(\w+)\}/gu, (_m, name: string) => String(values?.[name] ?? ""));
}

export function deriveSyncView(
  summary: GitRepositorySummary | null,
  loading: boolean,
  t: OptionalWidgetTranslate = englishSyncTranslate,
): GitSyncView {
  if (loading && summary === null) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.sync"),
      description: t("gitClientWindow.sync.checking"),
      disabled: true,
    };
  }
  if (summary === null) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.sync"),
      description: t("gitClientWindow.sync.selectRepo"),
      disabled: true,
    };
  }
  if (!summary.available) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.unavailable"),
      description: t("gitClientWindow.sync.openRepo"),
      disabled: true,
    };
  }
  if (summary.detached) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.detached"),
      description: t("gitClientWindow.sync.switchBranch"),
      disabled: true,
    };
  }
  if (summary.conflictedCount > 0) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.conflicts"),
      description: t("gitClientWindow.sync.resolveConflicts"),
      disabled: true,
    };
  }
  const branch = summary.branch ?? "";
  if (branch.length === 0) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.noBranch"),
      description: t("gitClientWindow.sync.createBranch"),
      disabled: true,
    };
  }
  const remote = preferredRemote(summary);
  if (remote === undefined) {
    return {
      action: "blocked",
      label: t("gitClientWindow.sync.noRemote"),
      description: t("gitClientWindow.sync.addRemote"),
      disabled: true,
    };
  }
  if (summary.upstream === undefined) {
    return {
      action: "publish-upstream",
      label: t("gitClientWindow.sync.publish"),
      description: t("gitClientWindow.sync.publishDesc", { branch, remote: remote.name }),
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
      label: t("gitClientWindow.sync.fetch"),
      diverged: true,
      description: t("gitClientWindow.sync.divergedDesc", {
        ahead: summary.ahead.toString(),
        behind: summary.behind.toString(),
      }),
      disabled: false,
      remoteAlias,
    };
  }
  if (summary.behind > 0) {
    return {
      action: "pull",
      label: t("gitClientWindow.sync.pull"),
      description: t("gitClientWindow.sync.behindDesc", {
        behind: summary.behind.toString(),
        ref: summary.upstream.ref,
      }),
      disabled: false,
      remoteAlias,
    };
  }
  if (summary.ahead > 0) {
    return {
      action: "push",
      label: t("gitClientWindow.sync.push"),
      description: t("gitClientWindow.sync.aheadDesc", {
        ahead: summary.ahead.toString(),
        ref: summary.upstream.ref,
      }),
      disabled: false,
      remoteAlias,
      remoteBranchName,
      sourceBranchName: branch,
      setUpstreamTracking: false,
    };
  }
  return {
    action: "fetch",
    label: t("gitClientWindow.sync.fetch"),
    description: t("gitClientWindow.sync.upToDateDesc", { ref: summary.upstream.ref }),
    disabled: false,
    remoteAlias,
  };
}

export function SyncControl({
  view,
  busy,
  outcome,
  error,
  // #3653: a transient failure of the repository-summary read is folded into `view` as a
  // disabled "blocked" action with no way back — the read is never retried merely because the
  // connection recovers, and `view` alone cannot distinguish that from a structural reason (no
  // remote, detached HEAD, …) that a retry could never fix. Passing the raw read failure alongside
  // `view` lets this control offer Retry only for the actually-retryable case.
  summaryError,
  onRun,
  onRetrySummary,
}: {
  readonly view: GitSyncView;
  readonly busy: boolean;
  readonly outcome: SyncOutcomeView | null;
  readonly error: string | null;
  readonly summaryError: string | null;
  readonly onRun: () => void;
  readonly onRetrySummary: () => void;
}): ReactNode {
  const t = useOptionalWidgetTranslate();
  const disabled = view.disabled || busy;
  const descriptionId = useId();
  const syncLabelId = useId();
  // A settled-but-failed outcome is a failure, not a status: it must not be announced with role=status
  // and must not be painted in the neutral colour just because the request itself did not throw.
  const failed = error !== null || outcome?.failed === true;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
      <button
        type="button"
        disabled={disabled}
        style={{
          ...PRIMARY_BTN,
          minWidth: 88,
          height: 34,
          padding: "0 12px",
          ...disabledStyle(disabled),
        }}
        aria-label={t("gitClientWindow.sync.run", {
          state: busy ? t("gitClientWindow.sync.syncing") : view.label,
        })}
        aria-describedby={descriptionId}
        onClick={onRun}
      >
        <ResetIcon size={12} /> {busy ? "Syncing" : view.label}
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
        role={failed ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
        aria-labelledby={`${syncLabelId} ${descriptionId}`}
        style={{
          display: "block",
          minWidth: 0,
          maxWidth: 172,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          font: "500 11.5px var(--font-ui)",
          color: failed ? "var(--danger)" : "var(--fg-muted)",
        }}
        title={error ?? outcome?.message ?? view.description}
      >
        {error ?? outcome?.message ?? view.description}
      </span>
      {summaryError !== null ? (
        <button type="button" style={SECONDARY_BTN} onClick={onRetrySummary}>
          {t("gitDelivery.action.retry")}
        </button>
      ) : null}
      {view.diverged === true ? (
        <span style={{ ...SUBTLE_TEXT_STYLE, maxWidth: 320 }}>
          {t("gitClientWindow.sync.mergeHint")}
        </span>
      ) : null}
    </div>
  );
}
