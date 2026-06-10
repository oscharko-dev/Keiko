import { registerWindowRender } from "../windows/WindowsRegistry";
import type { WindowRenderContext } from "../windows/WindowsRegistry";
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
import { FigmaSnapshotWindow } from "./figma/FigmaSnapshotWindow";
import { QiHubPanel } from "./quality-intelligence/QiHubPanel";
import { QiRunCard } from "./quality-intelligence/QiRunCard";
import { RelationshipsView } from "../../../relationships/RelationshipsView";
import { buildConnectedRunSources } from "./quality-intelligence/connectedSources";
import type { QualityIntelligenceInlineSource } from "@oscharko-dev/keiko-contracts";

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" ? v : undefined;
}

function bool(cfg: Record<string, unknown>, key: string): boolean | undefined {
  const v = cfg[key];
  return typeof v === "boolean" ? v : undefined;
}

// Reconstruct the inline sources a qiRun window's run was launched from so the run card can re-check
// drift (Epic #735). The hub serialises the connected source set (file / folders / capsules /
// capsule-sets / figma snapshots, in the RunLauncher's exact order) into `connectedSourcesJson` when
// it opens the run; we parse it here so re-check sees byte-identical sources and an unchanged source
// reports no drift. Older windows that carry only the single connectedFilePath/connectedRoot scalars
// fall back to reconstructing a single source. Empty → the card hides the drift affordance.
function qiConnectedSources(
  cfg: Record<string, unknown>,
): readonly QualityIntelligenceInlineSource[] {
  const json = str(cfg, "connectedSourcesJson");
  if (json !== undefined && json.length > 0) {
    try {
      const parsed: unknown = JSON.parse(json);
      // The server re-validates every source entry, so a light array guard is enough here.
      if (Array.isArray(parsed)) return parsed as readonly QualityIntelligenceInlineSource[];
    } catch {
      // fall through to the legacy single-source reconstruction
    }
  }
  return buildConnectedRunSources({
    connectedFilePath: str(cfg, "connectedFilePath") ?? null,
    connectedRoot: str(cfg, "connectedRoot") ?? null,
  });
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
  });
  return sources.length > 0 ? { connectedSourcesJson: JSON.stringify(sources) } : {};
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
      ctx.openWindow("qiRun", { runId, ...connectedSourcesCfgFromCtx(ctx) });
    }}
    connectedRoot={ctx.linkedRoot}
    connectedFilePath={ctx.linkedFilePath ?? null}
    connectedRoots={ctx.linkedRoots}
    connectedCapsuleIds={ctx.linkedCapsuleIds}
    connectedCapsuleSetIds={ctx.linkedCapsuleSetIds}
    connectedFigmaSnapshotRunIds={ctx.linkedFigmaSnapshotRunIds}
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
  const connectedSources = qiConnectedSources(cfg);
  // A regeneration writes a NEW immutable run; open it on the canvas so the user sees the merged
  // (fresh + regenerated) tests, carrying the same connected sources so the new card can itself
  // re-check drift (Epic #735, Issue #744 "refreshed card"). The original run card is left intact.
  const carried = str(cfg, "connectedSourcesJson");
  return (
    <QiRunCard
      runId={runId}
      connectedSources={connectedSources}
      onRegenerated={(result) => {
        ctx.openWindow("qiRun", {
          runId: result.runId,
          ...(carried !== undefined && carried.length > 0 ? { connectedSourcesJson: carried } : {}),
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
// Audit C302 — the config defaults are empty now (the old prototype values leaked
// into the header badge); treat "" like absent so the widgets fall back to their
// own demo/display defaults instead of rendering an empty tab label / URL input.
registerWindowRender("editor", (cfg) => {
  const file = str(cfg, "file");
  return file !== undefined && file !== "" ? <EditorWidget file={file} /> : <EditorWidget />;
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
// uiux-fix F023 C054 — no real integrations exist yet; the widget renders an honest
// static list, so the legacy `provider` cfg (fabricated "connected" state) is ignored.
registerWindowRender("integ", () => <IntegrationsWidget />);
// Epic #750 #756 — Figma Snapshot Workspace window. snapshotRunId is persisted into cfg by the
// component after a successful build so the connected QI hub can read it via linkedFigmaSnapshotRunIds.
registerWindowRender("figma", (cfg, ctx) => {
  const snapshotRunId = str(cfg, "snapshotRunId");
  return (
    <FigmaSnapshotWindow
      snapshotRunId={snapshotRunId}
      updateCfg={(patch) => {
        ctx.updateCfg(patch);
      }}
    />
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
