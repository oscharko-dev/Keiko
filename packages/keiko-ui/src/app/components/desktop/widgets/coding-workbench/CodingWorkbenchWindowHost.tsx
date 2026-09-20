"use client";

import type { ReactNode } from "react";
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
  const root = typeof cfg.repositoryPath === "string" ? cfg.repositoryPath : context.selectedRoot;
  return (
    <CodingWorkbenchWindow
      historySelection={typeof cfg.historySelection === "string" ? cfg.historySelection : undefined}
      onHistorySelectionHandled={() =>
        context.openWindow("coding", { historySelection: undefined, repositoryPath: undefined })
      }
      onOpenHistory={() => context.openWindow("codingHistory")}
      selectedRoot={root ?? undefined}
      onSelectRepository={(repositoryPath) => {
        context.updateCfg({ repositoryPath });
        reportClientDiagnostic("[keiko] coding workbench repository selection requested");
      }}
      onOpenGit={(target) => openGit(context, target)}
    />
  );
}
