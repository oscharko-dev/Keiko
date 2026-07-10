import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useTranslate } from "@/lib/i18n";
import { registerWindowRender } from "../windows/WindowsRegistry";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
import { useChatSessionContext } from "../context/ChatSessionContext";
import { requestGatewaySetup } from "./shared/gatewaySetupBus";
import {
  buildConnectedRunSources,
  connectedRunSourcesCfgFromInlineSources,
  connectedRunSourcesCfgFromSources,
  connectedRunSourcesFromWindowCfg,
} from "./quality-intelligence/connectedSources";
import type { AgentRunCfg } from "./cards/AgentRunWidget";

function WindowChunkFallback(): ReactNode {
  const t = useTranslate();
  return <div className="lk-loading">{t("common.loading")}</div>;
}

const windowChunkFallback = WindowChunkFallback;
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
const TimelinePanel = dynamic(
  () => import("./panels/TimelinePanel").then((mod) => mod.TimelinePanel),
  { ssr: false, loading: windowChunkFallback },
);
const KeikoTwinPanel = dynamic(
  () => import("./panels/KeikoTwinPanel").then((mod) => mod.KeikoTwinPanel),
  { ssr: false, loading: windowChunkFallback },
);
const SettingsPanel = dynamic(
  () => import("./panels/SettingsPanel").then((mod) => mod.SettingsPanel),
  { ssr: false, loading: windowChunkFallback },
);
const UpdateWindow = dynamic(
  () => import("../update/UpdateWindow").then((mod) => mod.UpdateWindow),
  { ssr: false, loading: windowChunkFallback },
);
const FilesWidget = dynamic(() => import("./cards/FilesWidget").then((mod) => mod.FilesWidget), {
  ssr: false,
  loading: windowChunkFallback,
});
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
const CodingWorkbenchWindow = dynamic(
  () => import("./coding-workbench/CodingWorkbenchWindow").then((mod) => mod.CodingWorkbenchWindow),
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
const IntegrationsWidget = dynamic(
  () => import("./cards/IntegrationsWidget").then((mod) => mod.IntegrationsWidget),
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

// Issue #446 (ADR-0090) — the single root-resolution choke point for bound surfaces. When a task
// workspace is active, its managed-worktree root OVERRIDES the window's per-window cfg root and the
// linked-window fallback, so a switch atomically retargets every surface and none can keep executing
// against the previous workspace (AC1/AC2, SC1/SC3). In unbound mode (no active workspace) the legacy
// cfg → linkedRoot chain is preserved unchanged.
export function resolveBoundRoot(
  ctx: Pick<WindowRenderContext, "activeRoot" | "linkedRoot">,
  cfgRoot: string | undefined,
): string | undefined {
  return ctx.activeRoot ?? cfgRoot ?? ctx.linkedRoot ?? undefined;
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
    openChatWindow={(chat) => {
      ctx.openWindow("chat", { chatId: chat.id, title: chat.title });
    }}
  />
));
registerWindowRender("project", () => <ProjectPanel />);
registerWindowRender("promptEnhancer", (_cfg, ctx) => (
  <PromptEnhancerPanel
    connectedRoot={ctx.linkedRoot}
    connectedFilePath={ctx.linkedFilePath ?? null}
    connectedRoots={ctx.linkedRoots}
  />
));
function SearchPanelSessionHost({ ctx }: { readonly ctx: WindowRenderContext }): ReactNode {
  const { activeProject } = useChatSessionContext();
  return (
    <SearchPanel
      root={ctx.activeRoot ?? ctx.linkedRoot ?? activeProject?.path ?? undefined}
      openEditorFile={ctx.openEditorFile}
    />
  );
}

registerWindowRender("search", (_cfg, ctx) => <SearchPanelSessionHost ctx={ctx} />);
registerWindowRender("plugins", () => <PluginsPanel />);
registerWindowRender("automations", () => <AutomationsPanel />);
registerWindowRender("mobile", () => <MobilePanel />);
registerWindowRender("inspector", () => <InspectorPanel />);
registerWindowRender("notifications", () => <NotificationsPanel />);
registerWindowRender("resources", () => <ResourcesPanel />);
registerWindowRender("activity", () => <TimelinePanel />);
registerWindowRender("keiko", () => <KeikoTwinPanel />);
registerWindowRender("settings", (_cfg, ctx) => (
  <SettingsPanel openUpdatesWindow={() => ctx.openWindow("updates", { entrypoint: "settings" })} />
));
registerWindowRender("updates", () => <UpdateWindow />);
registerWindowRender("localKnowledge", () => <ConnectorGraph showBackToWorkspace={false} />);
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
    openRun={(runId, recheckableSources) => {
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
      onRegenerated={(result) => {
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
  const root = resolveBoundRoot(ctx, str(cfg, "root"));
  const onActiveFileChange = (
    path: string | null,
    resolvedRoot: string | null,
    activeDirectoryPath?: string | null,
  ): void => {
    const patch: Record<string, string | undefined> = {
      activeFilePath: path ?? undefined,
      resolvedRoot: resolvedRoot ?? undefined,
    };
    if (activeDirectoryPath !== undefined) {
      patch.activeDirectoryPath = activeDirectoryPath ?? undefined;
    }
    ctx.updateCfg(patch);
  };
  // Persist the new root into cfg so opening a different machine path survives reload, and so a
  // connected Chat re-binds to the new folder on the next scope update.
  const onRootChange = (nextRoot: string): void => {
    ctx.updateCfg({
      root: nextRoot,
      activeFilePath: undefined,
      activeDirectoryPath: undefined,
      resolvedRoot: undefined,
    });
  };
  const onOpenFile = (fileRoot: string, path: string): void => {
    ctx.openWindow("editor", { root: fileRoot, file: path, openFiles: [path] });
  };
  const onOpenGitDelivery = (projectRoot: string): void => {
    ctx.openWindow("governedGit", { projectPath: projectRoot });
  };
  return root !== undefined ? (
    <FilesWidget
      root={root}
      onActiveFileChange={onActiveFileChange}
      onRootChange={onRootChange}
      onOpenFile={onOpenFile}
      onOpenGitDelivery={onOpenGitDelivery}
    />
  ) : (
    <FilesWidget
      onActiveFileChange={onActiveFileChange}
      onRootChange={onRootChange}
      onOpenFile={onOpenFile}
      onOpenGitDelivery={onOpenGitDelivery}
    />
  );
});
registerWindowRender("editor", (cfg, ctx) => {
  const root = resolveBoundRoot(ctx, str(cfg, "root"));
  return (
    <EditorWindowSessionHost key={ctx.activeRoot ?? "unbound"} cfg={cfg} ctx={ctx} root={root} />
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
  // Issue #446 — when a workspace is active the terminal opens in (and resolves commands against) the
  // active root; the previous workspace cannot leak in as a stale cwd/projectId after a switch (SC3).
  const projectPath = resolveBoundRoot(ctx, str(cfg, "projectPath"));
  const cwd = ctx.activeRoot ?? str(cfg, "cwd");
  const props: { cwd?: string; projectPath?: string } = {};
  if (cwd !== undefined) props.cwd = cwd;
  if (projectPath !== undefined) props.projectPath = projectPath;
  return <TerminalWidget {...props} />;
});
registerWindowRender("commands", (cfg, ctx) => {
  const projectPath = resolveBoundRoot(ctx, str(cfg, "projectPath"));
  const props: { projectPath?: string } = {};
  if (projectPath !== undefined) props.projectPath = projectPath;
  return <CommandsWidget {...props} />;
});
registerWindowRender("runtime", (cfg, ctx) => {
  const projectPath = resolveBoundRoot(ctx, str(cfg, "projectPath"));
  const openWithProject = (
    type: "commands" | "governedGit" | "governedPullRequest" | "governedMerge",
    root: string,
  ): void => {
    ctx.openWindow(type, { projectPath: root });
  };
  return (
    <RuntimeHubWidget
      projectPath={projectPath}
      onProjectPathChange={(nextProjectPath) => ctx.updateCfg({ projectPath: nextProjectPath })}
      onOpenFiles={(root) => {
        ctx.openWindow("files", root !== undefined ? { root } : undefined);
      }}
      onOpenCommands={(root) => openWithProject("commands", root)}
      onOpenContainers={(root) => {
        ctx.openWindow("containerStatus", root !== undefined ? { projectPath: root } : undefined);
      }}
      onOpenGovernedGit={(root) => openWithProject("governedGit", root)}
      onOpenPullRequest={(root) => openWithProject("governedPullRequest", root)}
      onOpenMerge={(root) => openWithProject("governedMerge", root)}
    />
  );
});
registerWindowRender("coding", (cfg) => <CodingWorkbenchWindow state={str(cfg, "state")} />);
// Epic #1571, Issue #1574 — Git client window shell. The active project root acts as the projectId.
// Read it from cfg (projectPath / workspaceRoot, like terminal/agents) and fall back to a linked
// Files/Editor window root; an empty state renders when none is available. The shell persists the
// selected repository via ctx.updateCfg (so resolveBoundRoot re-targets) and opens the reused
// governed Pull Request / Merge windows via ctx.openWindow.
registerWindowRender("governedGit", (cfg, ctx) => {
  // Issue #446 (AC3 / SC2) — the active workspace root is the projectId, so the read surface and the
  // governed PR/merge windows run scoped to the active worktree and can never execute against the
  // previous workspace after a switch.
  const projectId = resolveBoundRoot(ctx, str(cfg, "projectPath") ?? str(cfg, "workspaceRoot"));
  return (
    <GitClientWindow
      projectId={projectId}
      onOpenFiles={(root) => ctx.openWindow("files", { root })}
      onOpenEditor={(root) => ctx.openWindow("editor", { root })}
      updateCfg={(patch) => ctx.updateCfg(patch)}
    />
  );
});
// Epic #470, Issue #477 — Governed GitHub pull request command center. The active project root acts as
// the projectId; the published head branch is carried in cfg from the Publish section.
registerWindowRender("governedPullRequest", (cfg, ctx) => {
  const projectId = resolveBoundRoot(ctx, str(cfg, "projectPath") ?? str(cfg, "workspaceRoot"));
  const headBranchName = str(cfg, "headBranchName") ?? undefined;
  return <GovernedPullRequestCard projectId={projectId} headBranchName={headBranchName} />;
});
// Epic #470, Issue #478 — Governed merge command center. The active project root acts as the projectId;
// the head branch under review is carried in cfg from the Pull Request section.
registerWindowRender("governedMerge", (cfg, ctx) => {
  const projectId = resolveBoundRoot(ctx, str(cfg, "projectPath") ?? str(cfg, "workspaceRoot"));
  const headBranchName = str(cfg, "headBranchName") ?? undefined;
  return <GovernedMergeCard projectId={projectId} headBranchName={headBranchName} />;
});
// Issue #1388 (ADR-0070) — container engine status surface. Always renders: the unavailable state
// degrades gracefully and never blocks. An optional project path scopes the allowlisted catalog.
registerWindowRender("containerStatus", (cfg, ctx) => {
  const projectPath = resolveBoundRoot(ctx, str(cfg, "projectPath"));
  const props: { projectPath?: string } = {};
  if (projectPath !== undefined) props.projectPath = projectPath;
  return <ContainerStatusWidget {...props} />;
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
// uiux-fix F023 C054 — no real integrations exist yet; the widget renders an honest
// static list, so the legacy `provider` cfg (fabricated "connected" state) is ignored.
registerWindowRender("integ", () => <IntegrationsWidget />);
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
      openScreenSource={({ snapshotRunId: runId, screenId, name }) => {
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
      updateCfg={(patch) => {
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
      updateCfg={(patch) => {
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
      onSelect={(patch) => {
        ctx.updateCfg(patch);
      }}
      onManageConnectors={() => {
        ctx.openWindow("localKnowledge");
      }}
    />
  );
});
