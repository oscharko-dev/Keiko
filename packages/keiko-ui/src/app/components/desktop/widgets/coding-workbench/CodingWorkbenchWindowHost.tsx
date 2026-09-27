"use client";

import { useRef, type ReactNode } from "react";
import type { WindowCfgRecord, WindowRenderContext } from "../../windows/WindowsRegistry";
import { CodingWorkbenchWindow, type CodingWorkbenchGitTarget } from "./CodingWorkbenchWindow";

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

/** Keep feature navigation inside the Workbench's existing observed lazy-load boundary. */
export function CodingWorkbenchWindowHost({
  cfg,
  context,
}: {
  readonly cfg: WindowCfgRecord;
  readonly context: WindowRenderContext;
}): ReactNode {
  const cfgRoot = typeof cfg.repositoryPath === "string" ? cfg.repositoryPath : undefined;
  // Existing windows may have no repositoryPath yet. Seed them once from the shell, then keep
  // their own selection independent of subsequent Chat or Git context changes.
  const initialRoot = useRef(context.activeBinding === null ? context.selectedRoot : null);
  const root = cfgRoot ?? initialRoot.current;
  const targetBranch = resolvedTargetBranch(cfg, root);
  return (
    <CodingWorkbenchWindow
      historySelection={typeof cfg.historySelection === "string" ? cfg.historySelection : undefined}
      onHistorySelectionHandled={() =>
        context.openWindow("coding", { historySelection: undefined })
      }
      onOpenHistory={() => context.openWindow("codingHistory")}
      selectedRoot={root ?? undefined}
      selectedBranch={targetBranch}
      onSelectRepository={(repositoryPath) => {
        // #A review: a selection is local window state until Start, not a failure — routine
        // diagnostics were removed here (they showed up server-side as warn-level client
        // failures for an ordinary pick). The run-start request already carries the bound
        // repository and target branch for the operation that actually matters.
        context.updateCfg({ repositoryPath, targetBranch: undefined, targetBranchRoot: undefined });
      }}
      onSelectBranch={(branch) => {
        context.updateCfg({ targetBranch: branch, targetBranchRoot: root ?? undefined });
      }}
      onOpenGit={(target) => openGit(context, target)}
    />
  );
}
