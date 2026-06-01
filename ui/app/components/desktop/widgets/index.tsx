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

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" ? v : undefined;
}

function bool(cfg: Record<string, unknown>, key: string): boolean | undefined {
  const v = cfg[key];
  return typeof v === "boolean" ? v : undefined;
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

registerWindowRender("files", (cfg, ctx) => {
  const root = str(cfg, "root");
  const onActiveFileChange = (path: string | null, resolvedRoot: string | null): void => {
    ctx.updateCfg({
      activeFilePath: path ?? undefined,
      resolvedRoot: resolvedRoot ?? undefined,
    });
  };
  return root !== undefined
    ? <FilesWidget root={root} onActiveFileChange={onActiveFileChange} />
    : <FilesWidget onActiveFileChange={onActiveFileChange} />;
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
  return runId !== undefined && runId !== ""
    ? <ReviewWidget runId={runId} />
    : <ReviewWidget />;
});
registerWindowRender("agents", (cfg, ctx) => (
  <AgentRunWidget cfg={toAgentCfg(cfg)} linkedRoot={ctx.linkedRoot} linkedFilePath={ctx.linkedFilePath} />
));
registerWindowRender("integ", (cfg) => {
  const provider = str(cfg, "provider");
  return provider !== undefined
    ? <IntegrationsWidget provider={provider} />
    : <IntegrationsWidget />;
});
