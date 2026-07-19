"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import type { WindowCfgRecord, WindowRenderContext } from "../windows/WindowsRegistry";
import { useEditorSettings } from "./cards/useEditorSettings";

const DebugPanel = dynamic(() => import("./panels/DebugPanel").then((mod) => mod.DebugPanel), {
  ssr: false,
  loading: () => null,
});

function projectPath(cfg: WindowCfgRecord): string | undefined {
  const value = cfg.projectPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function activeFile(cfg: WindowCfgRecord): string | undefined {
  const value = cfg.activeFile;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Loads only after the Debug window itself opens. Both the capability and opaque workspace identity
 * remain server-projected by the M7 settings snapshot; this boundary only avoids charging dormant
 * debugging controls to the desktop first-load path.
 */
export function DebugPanelSessionHost({
  cfg,
  ctx,
  root: rootOverride,
}: {
  readonly cfg: WindowCfgRecord;
  readonly ctx: WindowRenderContext;
  readonly root?: string | undefined;
}): ReactNode {
  const root = rootOverride ?? ctx.activeRoot ?? projectPath(cfg) ?? ctx.linkedRoot ?? undefined;
  const editorSettings = useEditorSettings(root);
  const debugging = editorSettings.snapshot?.debugging;
  return (
    <DebugPanel
      root={root ?? ""}
      activeFile={ctx.linkedFilePath ?? activeFile(cfg)}
      workspaceId={editorSettings.snapshot?.debugWorkspaceId}
      activationRevision={debugging?.revision}
      debugEnabled={debugging?.state === "available"}
      openEditorFile={ctx.openEditorFile}
    />
  );
}
