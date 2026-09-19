import dynamic from "next/dynamic";
import { gitObjectId } from "./gitObjectId";
import { useEffect, useMemo, type ReactNode } from "react";
import type {
  QualityIntelligenceInlineSource,
  QualityIntelligenceUiRegenerateResult,
} from "@oscharko-dev/keiko-contracts";
import type { Chat } from "@/lib/types";
import { registerWindowRender } from "../windows/WindowsRegistry";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import type { WindowCfgValue } from "../windows/types";
import { useChatSessionContext } from "../context/ChatSessionContext";
import { requestGatewaySetup } from "./shared/gatewaySetupBus";
import {
  buildConnectedRunSources,
  connectedRunSourcesCfgFromInlineSources,
  connectedRunSourcesCfgFromSources,
  connectedRunSourcesFromWindowCfg,
} from "./quality-intelligence/connectedSources";
import type { AgentRunCfg } from "./cards/AgentRunWidget";
import { useWorkspaceManifest } from "../hooks/useWorkspaceManifest";
import { workspaceRootTargets } from "../workspaceRootTargets";
import { BoundRootTarget, type BoundRootSurfaceType } from "./BoundRootTarget";
import { ManagedTaskWorkspaceGate } from "./ManagedTaskWorkspaceGate";
import { createWindowChunkFallback } from "./WindowChunkFallback";

const windowChunkFallback = createWindowChunkFallback("window chunk"); // i18n-exempt: diagnostic stage id, never rendered
const ChatWindowSessionHost = dynamic(
  () => import("./SelectionAwareWorkspaceHosts").then((mod) => mod.ChatWindowSessionHost),
  { ssr: false, loading: windowChunkFallback },
);
const ProjectPanel = dynamic(
  () => import("./panels/ProjectPanel").then((mod) => mod.ProjectPanel),
  { ssr: false, loading: windowChunkFallback },
);
const ChatHistoryPanel = dynamic(
  () => import("./panels/ChatHistoryPanel").then((mod) => mod.ChatHistoryPanel),
  { ssr: false, loading: windowChunkFallback },
);
const SearchPanel = dynamic(() => import("./panels/SearchPanel").then((mod) => mod.SearchPanel), {
  ssr: false,
  loading: windowChunkFallback,
});
const ProblemsPanel = dynamic(
  () => import("./panels/ProblemsPanel").then((mod) => mod.ProblemsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const DebugPanelSessionHost = dynamic(
  () => import("./DebugPanelSessionHost").then((mod) => mod.DebugPanelSessionHost),
  {
    ssr: false,
    loading: windowChunkFallback,
  },
);
const PromptEnhancerPanel = dynamic(
  () => import("./panels/PromptEnhancerPanel").then((mod) => mod.PromptEnhancerPanel),
  { ssr: false, loading: windowChunkFallback },
);
const PluginsPanel = dynamic(
  () => import("./panels/PluginsPanel").then((mod) => mod.PluginsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const AutomationsPanel = dynamic(
  () => import("./panels/AutomationsPanel").then((mod) => mod.AutomationsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const MobilePanel = dynamic(() => import("./panels/MobilePanel").then((mod) => mod.MobilePanel), {
  ssr: false,
  loading: windowChunkFallback,
});
const InspectorPanel = dynamic(
  () => import("./panels/InspectorPanel").then((mod) => mod.InspectorPanel),
  { ssr: false, loading: windowChunkFallback },
);
const NotificationsPanel = dynamic(
  () => import("./panels/NotificationsPanel").then((mod) => mod.NotificationsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const ResourcesPanel = dynamic(
  () => import("./panels/ResourcesPanel").then((mod) => mod.ResourcesPanel),
  { ssr: false, loading: windowChunkFallback },
);
type TimelinePanelModule = typeof import("./panels/TimelinePanel");
const TimelinePanel = dynamic(
  (): Promise<TimelinePanelModule["TimelinePanel"]> =>
    import("./panels/TimelinePanel").then(
      (mod): TimelinePanelModule["TimelinePanel"] => mod.TimelinePanel,
    ),
  {
    ssr: false,
    loading: windowChunkFallback,
  },
);
const SettingsPanel = dynamic(
  () => import("./panels/SettingsPanel").then((mod) => mod.SettingsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const UpdateWindow = dynamic(
  () => import("../update/UpdateWindow").then((mod) => mod.UpdateWindow),
  { ssr: false, loading: windowChunkFallback },
);
const FilesWindowSessionHost = dynamic(
  () => import("./SelectionAwareWorkspaceHosts").then((mod) => mod.FilesWindowSessionHost),
  { ssr: false, loading: windowChunkFallback },
);
const EditorWindowSessionHost = dynamic(
  () => import("./SelectionAwareWorkspaceHosts").then((mod) => mod.EditorWindowSessionHost),
  { ssr: false, loading: windowChunkFallback },
);
const BrowserWidget = dynamic(
  () => import("./cards/BrowserWidget").then((mod) => mod.BrowserWidget),
  { ssr: false, loading: windowChunkFallback },
);
const DocumentationBrowserWidget = dynamic(
  () => import("./cards/DocumentationBrowserWidget").then((mod) => mod.DocumentationBrowserWidget),
  { ssr: false, loading: windowChunkFallback },
);
const TerminalWidget = dynamic(
  () => import("./cards/TerminalWidget").then((mod) => mod.TerminalWidget),
  { ssr: false, loading: windowChunkFallback },
);
const CommandsWidget = dynamic(
  () => import("./cards/CommandsWidget").then((mod) => mod.CommandsWidget),
  { ssr: false, loading: windowChunkFallback },
);
const RuntimeHubWidget = dynamic(
  () => import("./cards/RuntimeHubWidget").then((mod) => mod.RuntimeHubWidget),
  { ssr: false, loading: windowChunkFallback },
);
const CodingHistoryPanel = dynamic(
  () => import("./coding-workbench/CodingHistoryPanel").then((mod) => mod.CodingHistoryPanel),
  { ssr: false },
);
const CodingWorkbenchWindow = dynamic(
  () => import("./coding-workbench/CodingWorkbenchWindow").then((mod) => mod.CodingWorkbenchWindow),
  { ssr: false, loading: windowChunkFallback },
);
const WorkspaceTrustPanel = dynamic(
  () => import("../workspace-trust/WorkspaceTrustPanel").then((mod) => mod.WorkspaceTrustPanel),
  { ssr: false, loading: windowChunkFallback },
);
const GitClientWindow = dynamic(
  () => import("./cards/git-client/GitClientWindow").then((mod) => mod.GitClientWindow),
  { ssr: false, loading: windowChunkFallback },
);
const GovernedPullRequestCard = dynamic(
  () => import("./cards/GovernedPullRequestCard").then((mod) => mod.GovernedPullRequestCard),
  { ssr: false, loading: windowChunkFallback },
);
const GovernedMergeCard = dynamic(
  () => import("./cards/GovernedMergeCard").then((mod) => mod.GovernedMergeCard),
  { ssr: false, loading: windowChunkFallback },
);
const ContainerStatusWidget = dynamic(
  () => import("./cards/ContainerStatusWidget").then((mod) => mod.ContainerStatusWidget),
  { ssr: false, loading: windowChunkFallback },
);
const ReviewWidget = dynamic(() => import("./cards/ReviewWidget").then((mod) => mod.ReviewWidget), {
  ssr: false,
  loading: windowChunkFallback,
});
const AgentRunWidget = dynamic(
  () => import("./cards/AgentRunWidget").then((mod) => mod.AgentRunWidget),
  { ssr: false, loading: windowChunkFallback },
);
const AtlassianConnectorsPanel = dynamic(
  () => import("./connectors/AtlassianConnectorsPanel").then((mod) => mod.AtlassianConnectorsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const ConnectorPickerWidget = dynamic(
  () => import("./cards/ConnectorPickerWidget").then((mod) => mod.ConnectorPickerWidget),
  { ssr: false, loading: windowChunkFallback },
);
const PdfCitationPreviewWindow = dynamic(
  () => import("./cards/PdfCitationPreviewWindow").then((mod) => mod.PdfCitationPreviewWindow),
  { ssr: false, loading: windowChunkFallback },
);
const FigmaSnapshotWindow = dynamic(
  () => import("./figma/FigmaSnapshotWindow").then((mod) => mod.FigmaSnapshotWindow),
  { ssr: false, loading: windowChunkFallback },
);
const FigmaJsonSourceWindow = dynamic(
  () => import("./figma/FigmaJsonSourceWindow").then((mod) => mod.FigmaJsonSourceWindow),
  { ssr: false, loading: windowChunkFallback },
);
const FigmaImageSourceWindow = dynamic(
  () => import("./figma/FigmaImageSourceWindow").then((mod) => mod.FigmaImageSourceWindow),
  { ssr: false, loading: windowChunkFallback },
);
const QiHubPanel = dynamic(
  () => import("./quality-intelligence/QiHubPanel").then((mod) => mod.QiHubPanel),
  { ssr: false, loading: windowChunkFallback },
);
const QiRunCard = dynamic(
  () => import("./quality-intelligence/QiRunCard").then((mod) => mod.QiRunCard),
  { ssr: false, loading: windowChunkFallback },
);
const RelationshipsView = dynamic(
  () => import("../../../relationships/RelationshipsView").then((mod) => mod.RelationshipsView),
  { ssr: false, loading: windowChunkFallback },
);
const MemoriaVivaWindow = dynamic(
  () =>
    import("../../../memoriaviva/components/MemoriaVivaWindow").then(
      (mod) => mod.MemoriaVivaWindow,
    ),
  { ssr: false, loading: windowChunkFallback },
);
const ConnectorGraph = dynamic(
  () => import("../../../local-knowledge/connector-graph").then((mod) => mod.ConnectorGraph),
  { ssr: false, loading: windowChunkFallback },
);

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" ? v : undefined;
}

function num(cfg: Record<string, unknown>, key: string): number | undefined {
  const value = cfg[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

const CODING_REPOSITORY_BINDING = "coding-repository";

function displayNameFromRoot(root: string | null | undefined): string | undefined {
  if (root === null || root === undefined) return undefined;
  let segment = "";
  for (const part of root.split(/[\\/]/u)) {
    if (part.length > 0) segment = part;
  }
  return segment.length > 0 ? segment : root;
}

function isCodingRepositoryBinding(
  cfg: Record<string, unknown>,
  configuredRoot: string | undefined,
): boolean {
  return configuredRoot !== undefined && str(cfg, "rootBinding") === CODING_REPOSITORY_BINDING;
}

function isManagedTaskWorkspaceRoot(root: string | undefined): boolean {
  if (root === undefined || root.length === 0) return false;
  const normalized = root.replaceAll("\\", "/");
  return normalized.includes("/.keiko/") && normalized.includes("/task-workspaces/");
}

function isNonEmptyRoot(root: string | undefined): root is string {
  return root !== undefined && root.length > 0;
}

function hasManagedTaskWorkspaceDrift(
  cfg: Record<string, unknown>,
  configuredRoot: string | undefined,
): boolean {
  const resolvedRoot = str(cfg, "resolvedRoot");
  return (
    isNonEmptyRoot(configuredRoot) &&
    !isManagedTaskWorkspaceRoot(configuredRoot) &&
    isManagedTaskWorkspaceRoot(resolvedRoot)
  );
}

function shouldUseConfiguredRepositoryRoot(
  cfg: Record<string, unknown>,
  configuredRoot: string | undefined,
  activeRoot: string | null,
): boolean {
  if (isCodingRepositoryBinding(cfg, configuredRoot)) return true;
  // #3506 review — `hasManagedTaskWorkspaceDrift` compares cfg.resolvedRoot (the root the Files
  // widget last reported through onActiveFileChange) against cfg.root. When an active task
  // binding is present, `resolveBoundRoot` returned ctx.activeRoot, so FilesWidget correctly
  // persisted THAT as resolvedRoot. Treating this expected difference as drift pins the window
  // to the repository via PersistRepositoryRootBinding and permanently disables the
  // active-root override for the surface. Only apply the drift repair when no active binding is
  // in effect (ctx.activeRoot === null) — the explicit `coding-repository` binding above stays
  // untouched.
  if (activeRoot !== null) return false;
  return hasManagedTaskWorkspaceDrift(cfg, configuredRoot);
}

function gitRepositoryRoot(
  cfg: Record<string, unknown>,
  ctx: Pick<WindowRenderContext, "selectedRoot" | "linkedRoot">,
  configuredRoot: string | undefined,
): string | undefined {
  if (isCodingRepositoryBinding(cfg, configuredRoot)) return configuredRoot;
  if (isNonEmptyRoot(configuredRoot) && !isManagedTaskWorkspaceRoot(configuredRoot)) {
    return configuredRoot;
  }
  const contextRoot = ctx.selectedRoot ?? ctx.linkedRoot ?? undefined;
  return isManagedTaskWorkspaceRoot(contextRoot) ? undefined : contextRoot;
}

function PersistRepositoryRootBinding({
  cfg,
  ctx,
  root,
  rootKey,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
  readonly root: string | undefined;
  readonly rootKey: "projectPath" | "root";
}): null {
  const needsRepair =
    root !== undefined &&
    root.length > 0 &&
    !isManagedTaskWorkspaceRoot(root) &&
    (str(cfg, rootKey) !== root || str(cfg, "rootBinding") !== CODING_REPOSITORY_BINDING);
  useEffect((): void => {
    if (!needsRepair || root === undefined) return;
    const patch: Record<string, WindowCfgValue> = {
      [rootKey]: root,
      rootBinding: CODING_REPOSITORY_BINDING,
    };
    ctx.updateCfg(patch);
  }, [ctx, needsRepair, root, rootKey]);
  return null;
}

function codingRepositoryCfg(root: string): Record<string, WindowCfgValue> {
  return { root, rootBinding: CODING_REPOSITORY_BINDING };
}

function completeRepositoryConnection(
  cfg: Record<string, unknown>,
  ctx: WindowRenderContext,
  root: string,
): void {
  const returnWindow = str(cfg, "repositoryReturnWindow");
  if (!returnWindow) return;
  ctx.updateWindow(returnWindow, { cfg: { repositoryPath: root } });
  ctx.focusWindow(returnWindow);
  ctx.updateCfg({ repositoryReturnWindow: "" });
}

// Issue #446 (ADR-0090) — the single root-resolution choke point for bound surfaces. When a task
// workspace is active, its managed-worktree root overrides ordinary per-window roots so a switch
// atomically retargets legacy task-bound surfaces. Windows that explicitly carry
// `rootBinding: "coding-repository"` are not task-bound: they are repository control surfaces
// opened from the central Git widget and must keep the configured repository root while a run's
// managed worktree remains internal. In unbound mode an explicit per-window root stays
// authoritative; the Workbench-wide selection is only the default for windows without one.
export function resolveBoundRoot(
  ctx: Pick<WindowRenderContext, "activeRoot" | "selectedRoot" | "linkedRoot">,
  cfgRoot: string | undefined,
): string | undefined {
  return ctx.activeRoot ?? cfgRoot ?? ctx.selectedRoot ?? ctx.linkedRoot ?? undefined;
}

function boundRootFallback({
  ctx,
  configuredRoot,
  honorConfiguredRoot,
  ignoreActiveRoot,
}: {
  readonly ctx: Pick<WindowRenderContext, "activeRoot" | "selectedRoot" | "linkedRoot">;
  readonly configuredRoot: string | undefined;
  readonly honorConfiguredRoot: boolean;
  readonly ignoreActiveRoot: boolean;
}): string | undefined {
  if (honorConfiguredRoot && configuredRoot !== undefined) return configuredRoot;
  if (ignoreActiveRoot) return configuredRoot ?? ctx.selectedRoot ?? ctx.linkedRoot ?? undefined;
  return resolveBoundRoot(ctx, configuredRoot);
}

// Issue #2619 — `surface` replaces the free-text label: it selects the window's entry in
// BOUND_ROOT_SURFACES, which carries both the display label and whether the window may follow the
// focused root (ADR-0147 D1). One key, so the label and the governance class cannot drift apart.
function BoundRootSurface({
  ctx,
  configuredRoot,
  surface,
  onSelect,
  children,
  honorConfiguredRoot = false,
  ignoreActiveRoot = false,
}: {
  readonly ctx: WindowRenderContext;
  readonly configuredRoot: string | undefined;
  readonly surface: BoundRootSurfaceType;
  readonly onSelect: (root: string) => void;
  readonly children: (root: string | undefined) => ReactNode;
  readonly honorConfiguredRoot?: boolean;
  readonly ignoreActiveRoot?: boolean;
}): ReactNode {
  const fallbackRoot = boundRootFallback({
    ctx,
    configuredRoot,
    honorConfiguredRoot,
    ignoreActiveRoot,
  });
  return (
    <BoundRootTarget
      fallbackRoot={fallbackRoot}
      configuredRoot={configuredRoot}
      lockedToActiveRoot={!honorConfiguredRoot && !ignoreActiveRoot && ctx.activeBinding !== null}
      surface={surface}
      onSelect={onSelect}
    >
      {children}
    </BoundRootTarget>
  );
}

function bool(cfg: Record<string, unknown>, key: string): boolean | undefined {
  const v = cfg[key];
  return typeof v === "boolean" ? v : undefined;
}

function stringArrayJson(cfg: Record<string, unknown>, key: string): readonly string[] {
  const raw = str(cfg, key);
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
  } catch {
    return [];
  }
}

// Serialise the currently-connected source set (Files folders/file, Connector capsules, Figma
// snapshots) into a scalar cfg field so it can ride through openWindow (whose cfg values must be
// scalars). Reuses the SAME builder the RunLauncher generates from, so a re-check reconstructs the
// exact sources — same order, same labels — and never reports false drift on an unchanged source.
function connectedSourcesCfgFromCtx(ctx: WindowRenderContext): Record<string, string> {
  const sources = buildConnectedRunSources({
    connectedFilePath: ctx.linkedFilePath ?? null,
    connectedRoot: ctx.linkedRoot,
    connectedRoots: ctx.linkedRoots,
    connectedCapsuleIds: ctx.linkedCapsuleIds,
    connectedCapsuleSetIds: ctx.linkedCapsuleSetIds,
    connectedFigmaSnapshotRunIds: ctx.linkedFigmaSnapshotRunIds,
    connectedFigmaSnapshotSources: ctx.linkedFigmaSnapshotSources,
    connectedImageSources: ctx.linkedImageSources,
  });
  return connectedRunSourcesCfgFromSources(sources);
}

function agentAccess(cfg: Record<string, unknown>): "ask" | "full" | undefined {
  const v = cfg["access"];
  return v === "ask" || v === "full" ? v : undefined;
}

function toAgentCfg(cfg: Record<string, unknown>): AgentRunCfg {
  const out: AgentRunCfg = {};
  const workflow = str(cfg, "workflow");
  if (workflow !== undefined) out.workflow = workflow;
  const model = str(cfg, "model");
  if (model !== undefined) out.model = model;
  const runId = str(cfg, "runId");
  if (runId !== undefined) out.runId = runId;
  const fingerprint = str(cfg, "fingerprint");
  if (fingerprint !== undefined) out.fingerprint = fingerprint;
  const workspaceRoot = str(cfg, "workspaceRoot");
  if (workspaceRoot !== undefined) out.workspaceRoot = workspaceRoot;
  const inputJson = str(cfg, "inputJson");
  if (inputJson !== undefined) out.inputJson = inputJson;
  const keikoMode = bool(cfg, "keikoMode");
  if (keikoMode !== undefined) out.keikoMode = keikoMode;
  const access = agentAccess(cfg);
  if (access !== undefined) out.access = access;
  return out;
}

registerWindowRender("chat", (cfg, ctx) => <ChatWindowSessionHost cfg={cfg} ctx={ctx} />);
registerWindowRender("chatHistory", (_cfg, ctx) => (
  <ChatHistoryPanel
    openChatWindow={(chat: Chat) => {
      ctx.openWindow("chat", {
        chatId: chat.id,
        projectPath: chat.projectPath,
        title: chat.title,
      });
    }}
  />
));
registerWindowRender("project", (_cfg, ctx) => (
  <ProjectPanel
    openChatWindow={(chat: Chat): void => {
      ctx.openWindow("chat", {
        chatId: chat.id,
        projectPath: chat.projectPath,
        title: chat.title,
      });
    }}
  />
));
registerWindowRender("promptEnhancer", (_cfg, ctx) => (
  <PromptEnhancerPanel
    connectedRoot={ctx.linkedRoot}
    connectedFilePath={ctx.linkedFilePath ?? null}
    connectedRoots={ctx.linkedRoots}
  />
));
function SearchPanelSessionHost({
  cfg,
  ctx,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
}): ReactNode {
  const root = ctx.activeRoot ?? str(cfg, "root") ?? ctx.linkedRoot ?? undefined;
  const workspace = useWorkspaceManifest(root);
  const roots = useMemo(
    () => workspaceRootTargets(root, workspace.manifest),
    [root, workspace.manifest],
  );
  return <SearchPanel root={root} roots={roots} openEditorFile={ctx.openEditorFile} />;
}

registerWindowRender("search", (cfg, ctx) => <SearchPanelSessionHost cfg={cfg} ctx={ctx} />);
registerWindowRender("plugins", () => <PluginsPanel />);
registerWindowRender("automations", () => <AutomationsPanel />);
registerWindowRender("mobile", () => <MobilePanel />);
registerWindowRender("inspector", () => <InspectorPanel />);
registerWindowRender("notifications", () => <NotificationsPanel />);
registerWindowRender("resources", () => <ResourcesPanel />);
registerWindowRender("activity", () => <TimelinePanel />);
function SettingsPanelSessionHost({ ctx }: { readonly ctx: WindowRenderContext }): ReactNode {
  const { activeProject } = useChatSessionContext();
  return (
    <SettingsPanel
      root={ctx.activeRoot ?? ctx.linkedRoot ?? activeProject?.path ?? undefined}
      openUpdatesWindow={() => ctx.openWindow("updates", { entrypoint: "settings" })}
      openWorkspaceTrust={() => ctx.openWindow("workspaceTrust")}
    />
  );
}

registerWindowRender("settings", (_cfg, ctx) => <SettingsPanelSessionHost ctx={ctx} />);
registerWindowRender("workspaceTrust", () => <WorkspaceTrustPanel />);
registerWindowRender("updates", () => <UpdateWindow />);
registerWindowRender("localKnowledge", () => <ConnectorGraph showBackToWorkspace={false} />);
// Issue #2213 (Epic #2092, ADR-0126) — workspace Problems panel; jump-to-line via ctx.openEditorFile.
registerWindowRender("problems", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath");
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="problems"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(root) => <ProblemsPanel root={root ?? ""} openEditorFile={ctx.openEditorFile} />}
    </BoundRootSurface>
  );
});
registerWindowRender("debug", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath");
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="debug"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(root) => <DebugPanelSessionHost cfg={cfg} ctx={ctx} root={root} />}
    </BoundRootSurface>
  );
});
registerWindowRender("pdfCitationPreview", (cfg, ctx) => (
  <PdfCitationPreviewWindow
    cfg={cfg}
    focusWindow={ctx.focusWindow}
    restoreWindow={ctx.restoreWindow}
    updateCfg={ctx.updateCfg}
    windowId={ctx.windowId}
  />
));

// Epic #270 — Quality Intelligence. The hub is a singleton tool window; selecting/finishing a run
// opens a `qiRun` result card on the canvas (one per run, keyed by cfg.runId).
registerWindowRender("quality", (_cfg, ctx) => (
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
));
registerWindowRender("qiRun", (cfg, ctx) => {
  const runId = str(cfg, "runId");
  if (runId === undefined || runId === "") {
    return (
      <div className="lk-empty">
        <p className="lk-empty-body">Open a run from the Quality Intelligence hub.</p>
      </div>
    );
  }
  const connectedSources = connectedRunSourcesFromWindowCfg(cfg);
  // A regeneration writes a NEW immutable run; open it on the canvas so the user sees the merged
  // (fresh + regenerated) tests, carrying the same connected sources so the new card can itself
  // re-check drift (Epic #735, Issue #744 "refreshed card"). The original run card is left intact.
  const sourceCfg = connectedRunSourcesCfgFromSources(connectedSources);
  return (
    <QiRunCard
      runId={runId}
      connectedSources={connectedSources}
      onRegenerated={(result: QualityIntelligenceUiRegenerateResult) => {
        ctx.openWindow("qiRun", {
          runId: result.runId,
          ...sourceCfg,
        });
      }}
    />
  );
});

// Epic #532 — Relationship engine hub. Singleton tool window mirroring the QI hub: the governed
// relationship graph lives inside the Workspace, not as a full-page route.
registerWindowRender("relationships", () => <RelationshipsView />);

registerWindowRender("files", (cfg, ctx) => {
  const configuredRoot = str(cfg, "root");
  const honorConfiguredRoot = shouldUseConfiguredRepositoryRoot(
    cfg,
    configuredRoot,
    ctx.activeRoot,
  );
  const root = honorConfiguredRoot ? configuredRoot : resolveBoundRoot(ctx, configuredRoot);
  return (
    <>
      {honorConfiguredRoot ? (
        <PersistRepositoryRootBinding cfg={cfg} ctx={ctx} root={configuredRoot} rootKey="root" />
      ) : null}
      <FilesWindowSessionHost cfg={cfg} ctx={ctx} root={root} />
    </>
  );
});
registerWindowRender("editor", (cfg, ctx) => {
  const configuredRoot = str(cfg, "root");
  const honorConfiguredRoot = shouldUseConfiguredRepositoryRoot(
    cfg,
    configuredRoot,
    ctx.activeRoot,
  );
  const root = honorConfiguredRoot ? configuredRoot : resolveBoundRoot(ctx, configuredRoot);
  return (
    <>
      {honorConfiguredRoot ? (
        <PersistRepositoryRootBinding cfg={cfg} ctx={ctx} root={configuredRoot} rootKey="root" />
      ) : null}
      <EditorWindowSessionHost cfg={cfg} ctx={ctx} root={root} />
    </>
  );
});
registerWindowRender("browser", (cfg) => {
  const url = str(cfg, "url");
  return url !== undefined && url !== "" ? <BrowserWidget url={url} /> : <BrowserWidget />;
});
registerWindowRender("docbrowser", (cfg, ctx) => {
  const target = str(cfg, "target");
  // Epic #1852 — an already-indexed manual points the user at the Local Knowledge (Knowledge Pods)
  // surface so they can open the existing pod instead of creating a duplicate.
  const onOpenKnowledgePods = (): void => {
    ctx.openWindow("localKnowledge");
  };
  return target !== undefined && target !== "" ? (
    <DocumentationBrowserWidget target={target} onOpenKnowledgePods={onOpenKnowledgePods} />
  ) : (
    <DocumentationBrowserWidget onOpenKnowledgePods={onOpenKnowledgePods} />
  );
});
registerWindowRender("terminal", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath");
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="terminal"
      onSelect={(root) => ctx.updateCfg({ projectPath: root, cwd: root })}
    >
      {(root) => {
        const cwd = root ?? str(cfg, "cwd");
        const props: { cwd?: string; projectPath?: string } = {};
        if (cwd !== undefined) props.cwd = cwd;
        if (root !== undefined) props.projectPath = root;
        return <TerminalWidget {...props} />;
      }}
    </BoundRootSurface>
  );
});
registerWindowRender("commands", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath");
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="commands"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(root) => (
        <CommandsWidget
          {...(root === undefined ? {} : { projectPath: root })}
          onOpenWorkspaceTrust={() => ctx.openWindow("workspaceTrust")}
        />
      )}
    </BoundRootSurface>
  );
});
registerWindowRender("runtime", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath");
  const openWithProject = (
    type: "commands" | "governedGit" | "governedPullRequest" | "governedMerge",
    root: string,
  ): void => {
    ctx.openWindow(type, { projectPath: root });
  };
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="runtime"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(projectPath) => (
        <RuntimeHubWidget
          projectPath={projectPath}
          onProjectPathChange={(nextProjectPath: string) =>
            ctx.updateCfg({ projectPath: nextProjectPath })
          }
          onOpenFiles={(root: string | undefined) => {
            ctx.openWindow("files", root !== undefined ? { root } : undefined);
          }}
          onOpenCommands={(root: string) => openWithProject("commands", root)}
          onOpenContainers={(root: string | undefined) => {
            ctx.openWindow(
              "containerStatus",
              root !== undefined ? { projectPath: root } : undefined,
            );
          }}
          onOpenGovernedGit={(root: string) => openWithProject("governedGit", root)}
          onOpenPullRequest={(root: string) => openWithProject("governedPullRequest", root)}
          onOpenMerge={(root: string) => openWithProject("governedMerge", root)}
        />
      )}
    </BoundRootSurface>
  );
});
registerWindowRender("codingHistory", (_cfg, ctx) => (
  <CodingHistoryPanel
    onOpen={(task) =>
      ctx.openWindow("coding", { repositoryPath: task.projectPath, historySelection: task.id })
    }
    onNew={() => ctx.openWindow("coding", { historySelection: `new:${Date.now()}` })}
  />
));
registerWindowRender("coding", (cfg, ctx) => (
  <CodingWorkbenchWindow
    historySelection={str(cfg, "historySelection")}
    onHistorySelectionHandled={() =>
      ctx.openWindow("coding", { historySelection: undefined, repositoryPath: undefined })
    }
    onOpenHistory={() => ctx.openWindow("codingHistory")}
    selectedRoot={str(cfg, "repositoryPath") ?? ctx.selectedRoot ?? undefined}
    onOpenGit={({ root, binding, repositoryDialog, descriptionReview }) => {
      if (root !== null && descriptionReview !== undefined) {
        ctx.openWindow("governedPullRequest", {
          projectPath: root,
          descriptionOwnerAndRepo: descriptionReview.ownerAndRepo,
          descriptionPrNumber: descriptionReview.prNumber,
          descriptionProposalId: descriptionReview.proposalId,
          descriptionSnapshotDigest: descriptionReview.snapshotDigest,
        });
        return;
      }
      ctx.openWindow(
        "governedGit",
        repositoryDialog === undefined && root === null
          ? undefined
          : {
              ...(root === null ? {} : { projectPath: root }),
              ...(binding === "repository" ? { rootBinding: CODING_REPOSITORY_BINDING } : {}),
              ...(repositoryDialog === undefined
                ? {}
                : { repositoryDialog, repositoryReturnWindow: ctx.windowId }),
            },
      );
    }}
  />
));
// Epic #1571, Issue #1574 — Git client window shell. The selected repository root acts as the
// projectId. Read it from cfg (projectPath / workspaceRoot) and fall back to the global selected
// repository; an empty state renders when none is available. The shell persists the selected
// repository via ctx.updateCfg and opens the reused governed Pull Request / Merge windows via
// ctx.openWindow.
registerWindowRender("governedGit", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath") ?? str(cfg, "workspaceRoot");
  // Product rule (2026-09-15): Git is the repository's central control surface. A concrete
  // repository root is authoritative per window, and the global selected repository is the fallback.
  // The active task worktree is an internal run detail; it must not replace repository truth.
  const repositoryRoot = gitRepositoryRoot(cfg, ctx, configuredRoot);
  const honorConfiguredRoot = isNonEmptyRoot(repositoryRoot);
  const initialCommit = gitObjectId(str(cfg, "commit"));
  const initialPath = str(cfg, "path");
  const dialog = str(cfg, "repositoryDialog");
  const initialRepositoryDialog = dialog === "clone" || dialog === "open" ? dialog : undefined;
  const lockedRepositoryLabel = displayNameFromRoot(repositoryRoot ?? ctx.selectedRoot);
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={repositoryRoot ?? configuredRoot}
      surface="governedGit"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
      honorConfiguredRoot={honorConfiguredRoot}
      ignoreActiveRoot
    >
      {(projectId) => (
        <ManagedTaskWorkspaceGate ctx={ctx} root={projectId}>
          {honorConfiguredRoot ? (
            <PersistRepositoryRootBinding
              cfg={cfg}
              ctx={ctx}
              root={repositoryRoot}
              rootKey="projectPath"
            />
          ) : null}
          <GitClientWindow
            key={projectId ?? ""}
            projectId={projectId}
            lockedToActiveRoot={false}
            lockedRepositoryLabel={lockedRepositoryLabel}
            initialPath={initialPath}
            initialCommit={initialCommit}
            initialRepositoryDialog={initialRepositoryDialog}
            onRepositoryConnected={(root: string) => completeRepositoryConnection(cfg, ctx, root)}
            onOpenFiles={(root: string) => ctx.openWindow("files", codingRepositoryCfg(root))}
            onOpenEditor={(root: string) => ctx.openWindow("editor", codingRepositoryCfg(root))}
            onOpenEditorFile={ctx.openEditorFile}
            updateCfg={(patch: Record<string, WindowCfgValue>) => ctx.updateCfg(patch)}
          />
        </ManagedTaskWorkspaceGate>
      )}
    </BoundRootSurface>
  );
});
// Epic #470, Issue #477 — Governed GitHub pull request command center. The active project root acts as
// the projectId; the published head branch is carried in cfg from the Publish section.
registerWindowRender("governedPullRequest", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath") ?? str(cfg, "workspaceRoot");
  const headBranchName = str(cfg, "headBranchName") ?? undefined;
  const descriptionOwnerAndRepo = str(cfg, "descriptionOwnerAndRepo");
  const descriptionPrNumber = num(cfg, "descriptionPrNumber");
  const descriptionProposalId = str(cfg, "descriptionProposalId");
  const descriptionSnapshotDigest = str(cfg, "descriptionSnapshotDigest");
  const descriptionProposal =
    descriptionOwnerAndRepo === undefined ||
    descriptionPrNumber === undefined ||
    descriptionProposalId === undefined ||
    descriptionSnapshotDigest === undefined
      ? undefined
      : {
          projectId: configuredRoot ?? "",
          ownerAndRepo: descriptionOwnerAndRepo,
          prNumber: descriptionPrNumber,
          proposalId: descriptionProposalId,
          snapshotDigest: descriptionSnapshotDigest,
        };
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="governedPullRequest"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(projectId) => (
        <GovernedPullRequestCard
          projectId={projectId}
          headBranchName={headBranchName}
          ownerAndRepo={descriptionOwnerAndRepo}
          descriptionPrNumber={descriptionPrNumber}
          descriptionProposal={descriptionProposal}
        />
      )}
    </BoundRootSurface>
  );
});
// Epic #470, Issue #478 — Governed merge command center. The active project root acts as the projectId;
// the head branch under review is carried in cfg from the Pull Request section.
registerWindowRender("governedMerge", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath") ?? str(cfg, "workspaceRoot");
  const headBranchName = str(cfg, "headBranchName") ?? undefined;
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="governedMerge"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(projectId) => <GovernedMergeCard projectId={projectId} headBranchName={headBranchName} />}
    </BoundRootSurface>
  );
});
// Issue #1388 (ADR-0070) — container engine status surface. Always renders: the unavailable state
// degrades gracefully and never blocks. An optional project path scopes the allowlisted catalog.
registerWindowRender("containerStatus", (cfg, ctx) => {
  const configuredRoot = str(cfg, "projectPath");
  return (
    <BoundRootSurface
      ctx={ctx}
      configuredRoot={configuredRoot}
      surface="containerStatus"
      onSelect={(root) => ctx.updateCfg({ projectPath: root })}
    >
      {(projectPath) => (
        <ContainerStatusWidget {...(projectPath === undefined ? {} : { projectPath })} />
      )}
    </BoundRootSurface>
  );
});
// uiux-fix F018 C110: a review window without a run ID was a dead end — the empty
// state now offers an inline run-ID form, persisted via updateCfg like files/figma.
registerWindowRender("review", (cfg, ctx) => {
  const runId = str(cfg, "runId");
  const onRunIdSubmit = (nextRunId: string): void => {
    ctx.updateCfg({ runId: nextRunId });
  };
  return runId !== undefined && runId !== "" ? (
    <ReviewWidget runId={runId} onRunIdSubmit={onRunIdSubmit} />
  ) : (
    <ReviewWidget onRunIdSubmit={onRunIdSubmit} />
  );
});
registerWindowRender("agents", (cfg, ctx) => (
  <AgentRunWidget
    cfg={toAgentCfg(cfg)}
    linkedRoot={ctx.linkedRoot}
    linkedFilePath={ctx.linkedFilePath}
  />
));
registerWindowRender("memoria", () => <MemoriaVivaWindow />);
// Issues #2950/#3108 — the former prototype integration/twin state is gone. This shipped window
// renders the existing BFF-owned connector, scope, sync, and approval surface from ADR-0128.
registerWindowRender("integ", () => <AtlassianConnectorsPanel />);
// Epic #750 #756 — Figma Snapshot Workspace window. snapshotRunId is persisted into cfg by the
// component after a successful build so the connected QI hub can read it via linkedFigmaSnapshotRunIds.
registerWindowRender("figma", (cfg, ctx) => {
  const snapshotRunId = str(cfg, "snapshotRunId");
  const selectedScreenIds = stringArrayJson(cfg, "selectedScreenIdsJson");
  const selectedScreenName = str(cfg, "selectedScreenName");
  return (
    <FigmaSnapshotWindow
      sourceWindowId={ctx.windowId}
      snapshotRunId={snapshotRunId}
      selectedScreenIds={selectedScreenIds}
      selectedScreenName={selectedScreenName}
      openScreenSource={({
        snapshotRunId: runId,
        screenId,
        name,
      }: {
        readonly snapshotRunId: string;
        readonly screenId: string;
        readonly name: string;
      }) => {
        ctx.openWindow("figmaView", {
          snapshotRunId: runId,
          selectedScreenIdsJson: JSON.stringify([screenId]),
          selectedScreenName: name,
        });
      }}
      // Issue #1399: deep-link a PAT/credential error straight to the Figma access-token settings.
      openTokenSettings={() => {
        requestGatewaySetup();
        ctx.openWindow("settings");
      }}
      updateCfg={(patch: Record<string, string | number | boolean | undefined>) => {
        ctx.updateCfg(patch);
      }}
    />
  );
});

registerWindowRender("figmaView", (cfg, ctx) => {
  const snapshotRunId = str(cfg, "snapshotRunId");
  const selectedScreenIds = stringArrayJson(cfg, "selectedScreenIdsJson");
  const selectedScreenName = str(cfg, "selectedScreenName");
  return (
    <FigmaSnapshotWindow
      sourceWindowId={ctx.windowId}
      snapshotRunId={snapshotRunId}
      selectedScreenIds={selectedScreenIds}
      selectedScreenName={selectedScreenName}
      // Issue #1399: deep-link a PAT/credential error straight to the Figma access-token settings.
      openTokenSettings={() => {
        requestGatewaySetup();
        ctx.openWindow("settings");
      }}
      updateCfg={(patch: Record<string, string | number | boolean | undefined>) => {
        ctx.updateCfg(patch);
      }}
    />
  );
});

registerWindowRender("figmaJson", (cfg) => {
  const snapshotRunId = str(cfg, "snapshotRunId");
  const screenId = str(cfg, "screenId");
  const selectedScreenName = str(cfg, "selectedScreenName");
  return (
    <FigmaJsonSourceWindow
      snapshotRunId={snapshotRunId}
      screenId={screenId}
      screenName={selectedScreenName}
    />
  );
});

registerWindowRender("figmaImage", (cfg) => {
  const imageSrc = str(cfg, "imageSrc");
  const selectedScreenName = str(cfg, "selectedScreenName");
  return <FigmaImageSourceWindow imageSrc={imageSrc} screenName={selectedScreenName} />;
});

// Epic #189 Slice 3 M2 — connector picker window. updateCfg persists selectedKind/selectedId into
// the window's cfg so the relationship-edge binding (M3) can read the selection.
registerWindowRender("connector", (cfg, ctx) => {
  const presentation = str(cfg, "presentation");
  const selectedKind = str(cfg, "selectedKind");
  const selectedId = str(cfg, "selectedId");
  const selectedLabel = str(cfg, "selectedLabel");
  const selectedState = str(cfg, "selectedState");
  return (
    <ConnectorPickerWidget
      presentation={presentation}
      selectedKind={selectedKind}
      selectedId={selectedId}
      selectedLabel={selectedLabel}
      selectedState={selectedState}
      onSelect={(patch: { selectedKind: string; selectedId: string }) => {
        ctx.updateCfg(patch);
      }}
      onManageConnectors={() => {
        ctx.openWindow("localKnowledge");
      }}
    />
  );
});
