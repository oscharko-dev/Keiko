"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { newClientCorrelationId } from "@/lib/bff-correlation";
import { reportCodingWorkbenchInteraction } from "@/lib/coding-workbench-interaction";
import {
  useOptionalActiveWorkspace,
  type ActiveWorkspaceApi,
} from "../../context/ActiveWorkspaceContext";
import type { WindowCfgRecord, WindowRenderContext } from "../../windows/WindowsRegistry";
import { CodingWorkbenchWindow, type CodingWorkbenchGitTarget } from "./CodingWorkbenchWindow";
import type { WorkbenchExecutionLocation } from "./CodingWorkbenchRepositorySelector";
import {
  ConnectorWindowsProvider,
  useWorkspaceConnectorWindows,
} from "../../connector-windows-context";

function openGit(context: WindowRenderContext, target: CodingWorkbenchGitTarget): void {
  const { root, binding, repositoryDialog, descriptionReview } = target;
  if (root !== null && descriptionReview !== undefined) {
    context.openWindow("governedPullRequest", {
      projectPath: root,
      descriptionOwnerAndRepo: descriptionReview.ownerAndRepo,
      descriptionPrNumber: descriptionReview.prNumber,
      descriptionProposalId: descriptionReview.proposalId,
      descriptionSnapshotDigest: descriptionReview.snapshotDigest,
    });
    return;
  }
  context.openWindow(
    "governedGit",
    repositoryDialog === undefined && root === null
      ? undefined
      : {
          ...(root === null ? {} : { projectPath: root }),
          ...(binding === "repository" ? { rootBinding: "coding-repository" } : {}),
          ...(repositoryDialog === undefined
            ? {}
            : { repositoryDialog, repositoryReturnWindow: context.windowId }),
        },
  );
}

// #E review: a chosen target branch is meaningful only for the repository it was chosen against.
// `context.updateCfg` merges its patch into the existing cfg, so a caller that changes
// `repositoryPath` without also naming `targetBranch` (Coding History's `onOpen`/`onNew`,
// CodingHistoryPanel.tsx) leaves a foreign branch in place. Fixed at the owning layer instead of at
// each caller: the branch is stored alongside the root it was chosen for, and is only ever handed
// to the window when that root still matches the one currently resolved — so ANY path that changes
// the repository, present or future, drops a foreign branch for free.
function resolvedTargetBranch(
  cfg: WindowCfgRecord,
  root: string | null | undefined,
): string | undefined {
  const targetBranch = typeof cfg.targetBranch === "string" ? cfg.targetBranch : undefined;
  const targetBranchRoot =
    typeof cfg.targetBranchRoot === "string" ? cfg.targetBranchRoot : undefined;
  if (
    targetBranch === undefined ||
    root === null ||
    root === undefined ||
    targetBranchRoot !== root
  )
    return undefined;
  return targetBranch;
}

function isHistoryRestore(selection: string | undefined): boolean {
  return selection !== undefined && !selection.startsWith("new:");
}

function handledHistoryPatch(restoringHistory: boolean): WindowCfgRecord {
  return {
    historySelection: undefined,
    ...(restoringHistory
      ? { executionLocation: undefined, targetBranch: undefined, targetBranchRoot: undefined }
      : {}),
  };
}

// Existing windows may have no repositoryPath yet. Seed them once from the shell, then keep their
// own selection independent of subsequent Chat or Git context changes. The decision waits for the
// first render that knows the shell's state: a restored layout mounts this window on first paint,
// before the shell's project has loaded, and deciding then left the window without a repository
// for good. A window that meets an active task-workspace binding first never seeds.
//
// #4271: the decision also waits for the task-workspace state's first answer. Until then a null
// binding means "not read yet", not "unbound": seeding the shell's project in that window bound
// that folder in place of the active task workspace whenever the project loaded first. A failed
// read decides nothing either; the next successful read does. A binding that is present was read,
// so it decides at once. Without a provider (no task workspaces on this surface) there is nothing
// to wait for.
function activeBindingKnown(workspace: ActiveWorkspaceApi | null): boolean {
  // No provider reads as `undefined`, which is not null: known.
  return workspace?.activeBinding !== null || (!workspace.loading && workspace.error === null);
}

function shellSeed(context: WindowRenderContext): { readonly root: string | null } | null {
  if (context.activeBinding !== null) return { root: null };
  return typeof context.selectedRoot === "string" ? { root: context.selectedRoot } : null;
}

function useShellSeedRoot(
  context: WindowRenderContext,
  cfgRoot: string | undefined,
): string | null | undefined {
  const workspace = useOptionalActiveWorkspace();
  const seed = useRef<{ readonly root: string | null } | null>(null);
  if (seed.current === null && cfgRoot === undefined && activeBindingKnown(workspace))
    seed.current = shellSeed(context);
  const decided = seed.current;
  const reported = useRef(false);
  useEffect((): void => {
    if (decided === null || reported.current) return;
    reported.current = true;
    reportCodingWorkbenchInteraction(
      { interaction: decided.root === null ? "repository-seed-skipped" : "repository-seeded" },
      newClientCorrelationId(),
    );
  }, [decided]);
  return decided?.root;
}

/** Keep feature navigation inside the Workbench's existing observed lazy-load boundary. */
export function CodingWorkbenchWindowHost({
  cfg,
  context,
}: {
  readonly cfg: WindowCfgRecord;
  readonly context: WindowRenderContext;
}): ReactNode {
  const cfgRoot = typeof cfg.repositoryPath === "string" ? cfg.repositoryPath : undefined;
  const seedRoot = useShellSeedRoot(context, cfgRoot);
  const root = cfgRoot ?? seedRoot;
  const historySelection =
    typeof cfg.historySelection === "string" ? cfg.historySelection : undefined;
  const restoringHistory = isHistoryRestore(historySelection);
  const targetBranch = restoringHistory ? undefined : resolvedTargetBranch(cfg, root);
  const selectedLocation: WorkbenchExecutionLocation | undefined =
    !restoringHistory && (cfg.executionLocation === "local" || cfg.executionLocation === "worktree")
      ? cfg.executionLocation
      : undefined;
  const connectorWindows = useWorkspaceConnectorWindows(context.openWindow);
  return (
    <ConnectorWindowsProvider value={connectorWindows}>
      <CodingWorkbenchWindow
        draftKey={context.windowId}
        historySelection={historySelection}
        onHistorySelectionHandled={() => context.updateCfg(handledHistoryPatch(restoringHistory))}
        onOpenHistory={() => context.openWindow("codingHistory")}
        selectedRoot={root ?? undefined}
        selectedBranch={targetBranch}
        selectedLocation={selectedLocation}
        onSelectRepository={(repositoryPath) => {
          // #A review: a selection is local window state until Start, not a failure — routine
          // diagnostics were removed here (they showed up server-side as warn-level client
          // failures for an ordinary pick). The run-start request already carries the bound
          // repository and target branch for the operation that actually matters.
          context.updateCfg({
            repositoryPath,
            targetBranch: undefined,
            targetBranchRoot: undefined,
            executionLocation: undefined,
          });
        }}
        onSelectBranch={(branch) => {
          context.updateCfg({ targetBranch: branch, targetBranchRoot: root ?? undefined });
        }}
        onSelectLocation={(executionLocation) => context.updateCfg({ executionLocation })}
        onOpenGit={(target) => openGit(context, target)}
      />
    </ConnectorWindowsProvider>
  );
}
