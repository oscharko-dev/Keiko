import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { registerWindowRender } from "../windows/WindowsRegistry";
import type { WindowRenderContext, WindowType } from "../windows/WindowsRegistry";
import { ChatWindow } from "../ChatWindow";
import { ChatSessionProvider } from "../context/ChatSessionContext";
import { useChatSession } from "../hooks/useChatSession";
import { ProjectPanel } from "./panels/ProjectPanel";
import { ChatHistoryPanel } from "./panels/ChatHistoryPanel";
import { SearchPanel } from "./panels/SearchPanel";
import { PromptEnhancerPanel } from "./panels/PromptEnhancerPanel";
import { PluginsPanel } from "./panels/PluginsPanel";
import { AutomationsPanel } from "./panels/AutomationsPanel";
import { MobilePanel } from "./panels/MobilePanel";
import { InspectorPanel } from "./panels/InspectorPanel";
import { NotificationsPanel } from "./panels/NotificationsPanel";
import { ResourcesPanel } from "./panels/ResourcesPanel";
import { TimelinePanel } from "./panels/TimelinePanel";
import { FilesWidget } from "./cards/FilesWidget";
import { EditorWidget } from "./cards/EditorWidget";
import { BrowserWidget } from "./cards/BrowserWidget";
import { TerminalWidget } from "./cards/TerminalWidget";
import { CommandsWidget } from "./cards/CommandsWidget";
import { RuntimeHubWidget } from "./cards/RuntimeHubWidget";
import { GitClientWindow } from "./cards/git-client/GitClientWindow";
import { GovernedPullRequestCard } from "./cards/GovernedPullRequestCard";
import { GovernedMergeCard } from "./cards/GovernedMergeCard";
import { ContainerStatusWidget } from "./cards/ContainerStatusWidget";
import { ReviewWidget } from "./cards/ReviewWidget";
import { AgentRunWidget, type AgentRunCfg } from "./cards/AgentRunWidget";
import { IntegrationsWidget } from "./cards/IntegrationsWidget";
import { KeikoTwinPanel } from "./panels/KeikoTwinPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { ConnectorPickerWidget } from "./cards/ConnectorPickerWidget";
import { PdfCitationPreviewWindow } from "./cards/PdfCitationPreviewWindow";
import { FigmaSnapshotWindow } from "./figma/FigmaSnapshotWindow";
import { FigmaJsonSourceWindow } from "./figma/FigmaJsonSourceWindow";
import { FigmaImageSourceWindow } from "./figma/FigmaImageSourceWindow";
import { requestGatewaySetup } from "./shared/gatewaySetupBus";
import { QiHubPanel } from "./quality-intelligence/QiHubPanel";
import { QiRunCard } from "./quality-intelligence/QiRunCard";
import { RelationshipsView } from "../../../relationships/RelationshipsView";
import { MemoriaVivaWindow } from "../../../memoriaviva/components/MemoriaVivaWindow";
import { ConnectorGraph } from "../../../local-knowledge/connector-graph";
import {
  buildConnectedRunSources,
  connectedRunSourcesCfgFromInlineSources,
  connectedRunSourcesCfgFromSources,
  connectedRunSourcesFromWindowCfg,
} from "./quality-intelligence/connectedSources";
import type { ChatMessage } from "@/lib/types";

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

function num(cfg: Record<string, unknown>, key: string): number | undefined {
  const v = cfg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function stringArray(cfg: Record<string, unknown>, key: string): readonly string[] | undefined {
  const raw = cfg[key];
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return values.length > 0 ? values : undefined;
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

function ChatWindowSessionHost({
  cfg,
  ctx,
}: {
  readonly cfg: Record<string, unknown>;
  readonly ctx: WindowRenderContext;
}): ReactNode {
  const session = useChatSession({ autoCreate: false });
  const creatingRef = useRef(false);
  const chatId = str(cfg, "chatId");
  const title = str(cfg, "title");
  const { updateCfg } = ctx;
  const { activeChat, activeProject, chats, loading, openChat, openNewChat } = session;
  const activeTarget =
    activeChat !== undefined && activeChat.status !== "closed" ? activeChat : undefined;

  useEffect(() => {
    if (loading) return;
    if (chatId !== undefined) {
      if (activeTarget?.id === chatId) return;
      const target = chats.find((chat) => chat.id === chatId && chat.status !== "closed");
      if (target !== undefined) void openChat(target);
      return;
    }
    if (creatingRef.current) return;
    creatingRef.current = true;
    void openNewChat(undefined, title)
      .then((created) => {
        if (created !== undefined) updateCfg({ chatId: created.id, title: created.title });
      })
      .finally(() => {
        creatingRef.current = false;
      });
  }, [chatId, activeTarget?.id, chats, loading, openChat, openNewChat, title, updateCfg]);

  useEffect(() => {
    if (loading || chatId === undefined || activeTarget?.id !== chatId) return;
    if (activeTarget.title !== title) updateCfg({ title: activeTarget.title });
  }, [activeTarget?.id, activeTarget?.title, chatId, loading, title, updateCfg]);

  const targetMissing =
    chatId !== undefined &&
    !session.loading &&
    activeTarget?.id !== chatId &&
    !session.chats.some((chat) => chat.id === chatId && chat.status !== "closed");
  const waitingForTarget = session.loading || (chatId !== undefined && activeTarget?.id !== chatId);
  const openRunResult = useCallback(
    (message: ChatMessage): void => {
      if (message.runId === undefined) return;
      const cfg: Record<string, string | number | boolean> = { runId: message.runId };
      const workflow = message.workflowId ?? message.taskType;
      if (workflow !== undefined) cfg.workflow = workflow;
      // Issue #446 — when a task workspace is active, a run opened from chat is scoped to its root, so
      // the chat task-context stays consistent with the other bound surfaces.
      const runRoot = ctx.activeRoot ?? activeProject?.path;
      if (runRoot !== undefined) cfg.workspaceRoot = runRoot;
      ctx.openWindow("agents", cfg);
    },
    [activeProject?.path, ctx],
  );

  return (
    <ChatSessionProvider value={session}>
      {targetMissing ? (
        <div className="lk-empty">
          <p className="lk-empty-title">Chat not found</p>
          <p className="lk-empty-body">This conversation was deleted or is no longer available.</p>
        </div>
      ) : waitingForTarget ? (
        <div className="lk-loading">Opening chat...</div>
      ) : (
        <ChatWindow
          windowId={ctx.windowId}
          mini={ctx.mini === true}
          minimalChat={ctx.minimalChat === true}
          compact={ctx.compact === true}
          controlsNarrow={ctx.controlsNarrow === true}
          barCompact={ctx.barCompact === true}
          workflowCompact={ctx.workflowCompact === true}
          linkedRoot={ctx.activeRoot ?? ctx.linkedRoot}
          linkedRoots={ctx.linkedRoots}
          openEditorFile={ctx.openEditorFile}
          previewWindows={{
            add: ctx.openWindow,
            focus: ctx.focusWindow,
            update: ctx.updateWindow,
          }}
          onOpenRunResult={openRunResult}
        />
      )}
    </ChatSessionProvider>
  );
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
registerWindowRender("search", () => <SearchPanel />);
registerWindowRender("plugins", () => <PluginsPanel />);
registerWindowRender("automations", () => <AutomationsPanel />);
registerWindowRender("mobile", () => <MobilePanel />);
registerWindowRender("inspector", () => <InspectorPanel />);
registerWindowRender("notifications", () => <NotificationsPanel />);
registerWindowRender("resources", () => <ResourcesPanel />);
registerWindowRender("activity", () => <TimelinePanel />);
registerWindowRender("keiko", () => <KeikoTwinPanel />);
registerWindowRender("settings", () => <SettingsPanel />);
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
  const file = str(cfg, "file");
  const openFiles = stringArray(cfg, "openFiles");
  const layoutJson = str(cfg, "layoutJson");
  const revealLineStart = num(cfg, "revealLineStart");
  const revealLineEnd = num(cfg, "revealLineEnd");
  const revealRequestId = str(cfg, "revealRequestId");
  const props: {
    root?: string;
    file?: string;
    openFiles?: readonly string[];
    layoutJson?: string;
    revealLineStart?: number;
    revealLineEnd?: number;
    revealRequestId?: string;
    windowId?: string;
    linkedRoot?: string | null;
    linkedFilePath?: string | undefined;
    linkedCapsuleIds?: readonly string[];
    linkedCapsuleSetIds?: readonly string[];
    onWorkspaceChange?:
      | ((patch: {
          root?: string | undefined;
          file?: string | undefined;
          openFiles?: readonly string[] | undefined;
          layoutJson?: string | undefined;
        }) => void)
      | undefined;
  } = {};
  if (root !== undefined) props.root = root;
  if (file !== undefined) props.file = file;
  if (openFiles !== undefined) props.openFiles = openFiles;
  if (layoutJson !== undefined) props.layoutJson = layoutJson;
  if (revealLineStart !== undefined) props.revealLineStart = revealLineStart;
  if (revealLineEnd !== undefined) props.revealLineEnd = revealLineEnd;
  if (revealRequestId !== undefined) props.revealRequestId = revealRequestId;
  props.linkedRoot = ctx.linkedRoot;
  props.linkedFilePath = ctx.linkedFilePath;
  props.linkedCapsuleIds = ctx.linkedCapsuleIds;
  props.linkedCapsuleSetIds = ctx.linkedCapsuleSetIds;
  props.windowId = ctx.windowId;
  props.onWorkspaceChange = (patch) => {
    ctx.updateCfg(patch);
  };
  // Issue #446 (AC4 / SC3) — remount on a workspace switch so no Monaco model or open document from
  // the previous workspace root survives into the new one. The #1491 dirty-buffer/hot-exit save fires
  // on unmount before the new tree mounts.
  return <EditorWidget key={ctx.activeRoot ?? "unbound"} {...props} />;
});
registerWindowRender("browser", (cfg) => {
  const url = str(cfg, "url");
  return url !== undefined && url !== "" ? <BrowserWidget url={url} /> : <BrowserWidget />;
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
      openWindow={(key, windowCfg) => ctx.openWindow(key as WindowType, windowCfg)}
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
