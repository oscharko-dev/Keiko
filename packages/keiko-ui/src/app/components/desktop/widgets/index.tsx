import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { registerWindowRender } from "../windows/WindowsRegistry";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
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
import { ReviewWidget } from "./cards/ReviewWidget";
import { AgentRunWidget, type AgentRunCfg } from "./cards/AgentRunWidget";
import { IntegrationsWidget } from "./cards/IntegrationsWidget";
import { KeikoTwinPanel } from "./panels/KeikoTwinPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { ConnectorPickerWidget } from "./cards/ConnectorPickerWidget";
import { FigmaSnapshotWindow } from "./figma/FigmaSnapshotWindow";
import { FigmaJsonSourceWindow } from "./figma/FigmaJsonSourceWindow";
import { FigmaImageSourceWindow } from "./figma/FigmaImageSourceWindow";
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
      if (activeProject?.path !== undefined) cfg.workspaceRoot = activeProject.path;
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
          mini={ctx.mini === true}
          minimalChat={ctx.minimalChat === true}
          compact={ctx.compact === true}
          controlsNarrow={ctx.controlsNarrow === true}
          barCompact={ctx.barCompact === true}
          workflowCompact={ctx.workflowCompact === true}
          linkedRoot={ctx.linkedRoot}
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
registerWindowRender("promptEnhancer", () => <PromptEnhancerPanel />);
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
  const root = str(cfg, "root");
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
    ctx.openWindow("editor", { root: fileRoot, file: path });
  };
  return root !== undefined ? (
    <FilesWidget
      root={root}
      onActiveFileChange={onActiveFileChange}
      onRootChange={onRootChange}
      onOpenFile={onOpenFile}
    />
  ) : (
    <FilesWidget
      onActiveFileChange={onActiveFileChange}
      onRootChange={onRootChange}
      onOpenFile={onOpenFile}
    />
  );
});
registerWindowRender("editor", (cfg, ctx) => {
  const root = str(cfg, "root");
  const file = str(cfg, "file");
  const props: {
    root?: string;
    file?: string;
    windowId?: string;
    linkedRoot?: string | null;
    linkedFilePath?: string | undefined;
    linkedCapsuleIds?: readonly string[];
    linkedCapsuleSetIds?: readonly string[];
  } = {};
  if (root !== undefined) props.root = root;
  if (file !== undefined) props.file = file;
  props.linkedRoot = ctx.linkedRoot;
  props.linkedFilePath = ctx.linkedFilePath;
  props.linkedCapsuleIds = ctx.linkedCapsuleIds;
  props.linkedCapsuleSetIds = ctx.linkedCapsuleSetIds;
  props.windowId = ctx.windowId;
  return <EditorWidget {...props} />;
});
registerWindowRender("browser", (cfg) => {
  const url = str(cfg, "url");
  return url !== undefined && url !== "" ? <BrowserWidget url={url} /> : <BrowserWidget />;
});
registerWindowRender("terminal", (cfg) => {
  const cwd = str(cfg, "cwd");
  const projectPath = str(cfg, "projectPath");
  const props: { cwd?: string; projectPath?: string } = {};
  if (cwd !== undefined) props.cwd = cwd;
  if (projectPath !== undefined) props.projectPath = projectPath;
  return <TerminalWidget {...props} />;
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
