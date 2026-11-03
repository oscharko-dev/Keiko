"use client";

import type { ReactNode } from "react";
import type { QualityIntelligenceInlineSource } from "@oscharko-dev/keiko-contracts";
import type { WindowRenderContext } from "../../windows/WindowsRegistry";
import { QiHubPanel } from "./QiHubPanel";
import {
  buildConnectedRunSources,
  connectedRunSourcesCfgFromInlineSources,
  connectedRunSourcesCfgFromSources,
} from "./connectedSources";

// Use the RunLauncher's source builder so re-checking retains source order and labels.
function connectedSourcesCfgFromCtx(ctx: WindowRenderContext): Record<string, string> {
  return connectedRunSourcesCfgFromSources(
    buildConnectedRunSources({
      connectedFilePath: ctx.linkedFilePath ?? null,
      connectedRoot: ctx.linkedRoot,
      connectedRoots: ctx.linkedRoots,
      connectedCapsuleIds: ctx.linkedCapsuleIds,
      connectedCapsuleSetIds: ctx.linkedCapsuleSetIds,
      connectedFigmaSnapshotRunIds: ctx.linkedFigmaSnapshotRunIds,
      connectedFigmaSnapshotSources: ctx.linkedFigmaSnapshotSources,
      connectedImageSources: ctx.linkedImageSources,
    }),
  );
}

/** Load the QI source adapters with their window, preserving the shared chunk lifecycle fallback. */
export function QiHubWindowHost({ ctx }: { readonly ctx: WindowRenderContext }): ReactNode {
  return (
    <QiHubPanel
      openRun={(runId: string, recheckableSources?: readonly QualityIntelligenceInlineSource[]) => {
        const sourceCfg =
          recheckableSources !== undefined
            ? connectedRunSourcesCfgFromInlineSources(recheckableSources)
            : connectedSourcesCfgFromCtx(ctx);
        ctx.openWindow("qiRun", { runId, ...sourceCfg });
      }}
      connectedRoot={ctx.linkedRoot}
      connectedFilePath={ctx.linkedFilePath ?? null}
      connectedRoots={ctx.linkedRoots}
      connectedCapsuleIds={ctx.linkedCapsuleIds}
      connectedCapsuleSetIds={ctx.linkedCapsuleSetIds}
      connectedFigmaSnapshotRunIds={ctx.linkedFigmaSnapshotRunIds}
      connectedFigmaSnapshotSources={ctx.linkedFigmaSnapshotSources}
      connectedImageSources={ctx.linkedImageSources}
    />
  );
}
