"use client";

import { useRef, type ReactNode } from "react";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
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

/** Keep feature navigation inside the Workbench's existing observed lazy-load boundary. */
export function CodingWorkbenchWindowHost({
  cfg,
  context,
}: {
  readonly cfg: WindowCfgRecord;
  readonly context: WindowRenderContext;
}): ReactNode {
  const cfgRoot = typeof cfg.repositoryPath === "string" ? cfg.repositoryPath : undefined;
  const targetBranch = typeof cfg.targetBranch === "string" ? cfg.targetBranch : undefined;
  // Existing windows may have no repositoryPath yet. Seed them once from the shell, then keep
  // their own selection independent of subsequent Chat or Git context changes.
  const initialRoot = useRef(context.activeBinding === null ? context.selectedRoot : null);
  const root = cfgRoot ?? initialRoot.current;
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
        context.updateCfg({ repositoryPath, targetBranch: undefined });
        reportClientDiagnostic("[keiko] coding workbench repository selection requested");
      }}
      onSelectBranch={(branch) => {
        context.updateCfg({ targetBranch: branch });
        reportClientDiagnostic("[keiko] coding workbench target branch selected");
      }}
      onOpenGit={(target) => openGit(context, target)}
    />
  );
}
