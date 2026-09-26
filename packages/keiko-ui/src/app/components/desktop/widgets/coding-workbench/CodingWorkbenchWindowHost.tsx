"use client";

import { useEffect, useRef, type ReactNode } from "react";
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

/**
 * #3610: the per-window repository path (the setup card's first bind, a Git clone or open that
 * returns here, a history selection) is a one-shot choice. Once the header-wide selection changes,
 * the header is the one source again (#3563): a stale path kept the Workbench in the repository the
 * operator had just left while the header named another one. The first render never releases it.
 */
function useReleaseStaleRepositoryPath(
  cfgRoot: string | undefined,
  context: WindowRenderContext,
): void {
  const headerRoot = context.selectedRoot ?? null;
  const previousHeaderRoot = useRef(headerRoot);
  useEffect(() => {
    if (previousHeaderRoot.current === headerRoot) return;
    previousHeaderRoot.current = headerRoot;
    if (cfgRoot !== undefined && cfgRoot !== headerRoot) {
      context.updateCfg({ repositoryPath: undefined });
      reportClientDiagnostic("[keiko] coding workbench repository selection released");
    }
  }, [cfgRoot, context, headerRoot]);
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
  useReleaseStaleRepositoryPath(cfgRoot, context);
  const root = cfgRoot ?? context.selectedRoot;
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
