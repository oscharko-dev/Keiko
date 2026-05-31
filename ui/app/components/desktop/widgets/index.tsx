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
  const role = str(cfg, "role");
  if (role !== undefined) out.role = role;
  const model = str(cfg, "model");
  if (model !== undefined) out.model = model;
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

registerWindowRender("files", (cfg) => {
  const root = str(cfg, "root");
  return root !== undefined ? <FilesWidget root={root} /> : <FilesWidget />;
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
  const shell = str(cfg, "shell");
  const props: { cwd?: string; shell?: string } = {};
  if (cwd !== undefined) props.cwd = cwd;
  if (shell !== undefined) props.shell = shell;
  return <TerminalWidget {...props} />;
});
registerWindowRender("review", (cfg) => {
  const base = str(cfg, "base");
  const head = str(cfg, "head");
  const props: { base?: string; head?: string } = {};
  if (base !== undefined) props.base = base;
  if (head !== undefined) props.head = head;
  return <ReviewWidget {...props} />;
});
registerWindowRender("agents", (cfg, ctx) => (
  <AgentRunWidget cfg={toAgentCfg(cfg)} linkedRoot={ctx.linkedRoot} />
));
registerWindowRender("integ", (cfg) => {
  const provider = str(cfg, "provider");
  return provider !== undefined
    ? <IntegrationsWidget provider={provider} />
    : <IntegrationsWidget />;
});
