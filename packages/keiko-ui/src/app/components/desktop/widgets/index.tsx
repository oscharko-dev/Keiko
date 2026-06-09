import { registerWindowRender } from "../windows/WindowsRegistry";
import { ProjectPanel } from "./panels/ProjectPanel";
import { SearchPanel } from "./panels/SearchPanel";
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
import { QiHubPanel } from "./quality-intelligence/QiHubPanel";
import { QiRunCard } from "./quality-intelligence/QiRunCard";
import { RelationshipsView } from "../../../relationships/RelationshipsView";
import type { QualityIntelligenceInlineSource } from "@oscharko-dev/keiko-contracts";

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" ? v : undefined;
}

function bool(cfg: Record<string, unknown>, key: string): boolean | undefined {
  const v = cfg[key];
  return typeof v === "boolean" ? v : undefined;
}

// Reconstruct the QI run source from a qiRun window's cfg so the run card can re-check drift
// (Epic #735). A connected file takes precedence over a connected folder; absent both → undefined
// (the card then hides the drift affordance).
function qiConnectedSource(
  cfg: Record<string, unknown>,
): QualityIntelligenceInlineSource | undefined {
  const filePath = str(cfg, "connectedFilePath");
  if (filePath !== undefined && filePath.length > 0) {
    const label = filePath.split("/").pop() ?? filePath;
    return { kind: "file", label, path: filePath };
  }
  const root = str(cfg, "connectedRoot");
  if (root !== undefined && root.length > 0) {
    const label = root.split("/").pop() ?? root;
    return { kind: "workspace", label, path: root };
  }
  return undefined;
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

registerWindowRender("project", () => <ProjectPanel />);
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

// Epic #270 — Quality Intelligence. The hub is a singleton tool window; selecting/finishing a run
// opens a `qiRun` result card on the canvas (one per run, keyed by cfg.runId).
registerWindowRender("quality", (_cfg, ctx) => (
  <QiHubPanel
    openRun={(runId) => {
      ctx.openWindow("qiRun", {
        runId,
        ...(ctx.linkedFilePath !== undefined && ctx.linkedFilePath !== null
          ? { connectedFilePath: ctx.linkedFilePath }
          : {}),
        ...(ctx.linkedRoot !== undefined && ctx.linkedRoot !== null
          ? { connectedRoot: ctx.linkedRoot }
          : {}),
      });
    }}
    connectedRoot={ctx.linkedRoot}
    connectedFilePath={ctx.linkedFilePath ?? null}
    connectedRoots={ctx.linkedRoots}
    connectedCapsuleIds={ctx.linkedCapsuleIds}
  />
));
registerWindowRender("qiRun", (cfg) => {
  const runId = str(cfg, "runId");
  const connectedSource = qiConnectedSource(cfg);
  return runId !== undefined && runId !== "" ? (
    <QiRunCard runId={runId} connectedSource={connectedSource} />
  ) : (
    <div className="lk-empty">
      <p className="lk-empty-body">Open a run from the Quality Intelligence hub.</p>
    </div>
  );
});

// Epic #532 — Relationship engine hub. Singleton tool window mirroring the QI hub: the governed
// relationship graph lives inside the Workspace, not as a full-page route.
registerWindowRender("relationships", () => <RelationshipsView />);

registerWindowRender("files", (cfg, ctx) => {
  const root = str(cfg, "root");
  const onActiveFileChange = (path: string | null, resolvedRoot: string | null): void => {
    ctx.updateCfg({
      activeFilePath: path ?? undefined,
      resolvedRoot: resolvedRoot ?? undefined,
    });
  };
  // Persist the new root into cfg so opening a different machine path survives reload, and so a
  // connected Chat re-binds to the new folder on the next scope update.
  const onRootChange = (nextRoot: string): void => {
    ctx.updateCfg({ root: nextRoot, activeFilePath: undefined, resolvedRoot: undefined });
  };
  return root !== undefined ? (
    <FilesWidget root={root} onActiveFileChange={onActiveFileChange} onRootChange={onRootChange} />
  ) : (
    <FilesWidget onActiveFileChange={onActiveFileChange} onRootChange={onRootChange} />
  );
});
registerWindowRender("editor", (cfg) => {
  const file = str(cfg, "file");
  return file !== undefined ? <EditorWidget file={file} /> : <EditorWidget />;
});
registerWindowRender("browser", (cfg) => {
  const url = str(cfg, "url");
  return url !== undefined ? <BrowserWidget url={url} /> : <BrowserWidget />;
});
registerWindowRender("terminal", (cfg) => {
  const cwd = str(cfg, "cwd");
  const projectPath = str(cfg, "projectPath");
  const props: { cwd?: string; projectPath?: string } = {};
  if (cwd !== undefined) props.cwd = cwd;
  if (projectPath !== undefined) props.projectPath = projectPath;
  return <TerminalWidget {...props} />;
});
registerWindowRender("review", (cfg) => {
  const runId = str(cfg, "runId");
  return runId !== undefined && runId !== "" ? <ReviewWidget runId={runId} /> : <ReviewWidget />;
});
registerWindowRender("agents", (cfg, ctx) => (
  <AgentRunWidget
    cfg={toAgentCfg(cfg)}
    linkedRoot={ctx.linkedRoot}
    linkedFilePath={ctx.linkedFilePath}
  />
));
registerWindowRender("integ", (cfg) => {
  const provider = str(cfg, "provider");
  return provider !== undefined ? (
    <IntegrationsWidget provider={provider} />
  ) : (
    <IntegrationsWidget />
  );
});
// Epic #189 Slice 3 M2 — connector picker window. updateCfg persists selectedKind/selectedId into
// the window's cfg so the relationship-edge binding (M3) can read the selection.
registerWindowRender("connector", (cfg, ctx) => {
  const selectedKind = str(cfg, "selectedKind");
  const selectedId = str(cfg, "selectedId");
  return (
    <ConnectorPickerWidget
      selectedKind={selectedKind}
      selectedId={selectedId}
      onSelect={(patch) => {
        ctx.updateCfg(patch);
      }}
    />
  );
});
