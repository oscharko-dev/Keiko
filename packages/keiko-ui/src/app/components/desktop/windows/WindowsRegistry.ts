import type { ReactNode } from "react";
import type { IconName } from "../Icons";

export type WindowType =
  | "chat"
  | "chatHistory"
  | "files"
  | "editor"
  | "browser"
  | "terminal"
  | "review"
  | "agents"
  | "integ"
  | "keiko"
  | "settings"
  | "project"
  | "search"
  | "plugins"
  | "automations"
  | "mobile"
  | "inspector"
  | "activity"
  | "notifications"
  | "resources"
  // Epic #189 Slice 3 — Local Knowledge connector picker window.
  | "connector"
  // Epic #270 — Quality Intelligence: a singleton hub (start runs + run list) plus per-run result
  // cards. QI lives inside the Workspace like every other window, not as a full-page route.
  | "quality"
  | "qiRun"
  // Epic #532 — Relationship engine: a singleton tool window (graph list + inspector + impact +
  // health). Like QI, it lives inside the Workspace, not as a full-page route.
  | "relationships"
  // Epic #750, Issue #756 — Figma/Snapshot surface. Paste a board link, trigger a snapshot-build,
  // view captured screens + IR summaries. Connects to the QI hub as a figma-snapshot source.
  | "figma";

export interface WindowSize {
  readonly w: number;
  readonly h: number;
}

export type ConfigFieldType = "text" | "select" | "textarea" | "perm" | "directory";

export interface ConfigField {
  readonly key: string;
  readonly label: string;
  readonly type: ConfigFieldType;
  readonly def?: string;
  readonly optional?: boolean;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  readonly prefix?: string;
}

export interface WindowRenderContext {
  readonly mini?: boolean;
  readonly linkedRoot: string | null;
  readonly linkedFilePath: string | undefined;
  readonly linkedRoots: readonly string[];
  /** Epic #710 #718 — capsule ids from connected Connector windows (capsule kind only). */
  readonly linkedCapsuleIds: readonly string[];
  /** Epic #710 #718 — capsule-set ids from connected Connector windows (capsule-set kind only). */
  readonly linkedCapsuleSetIds: readonly string[];
  /** Epic #750 #756 — snapshot run ids from connected Figma Snapshot windows. */
  readonly linkedFigmaSnapshotRunIds: readonly string[];
  readonly updateCfg: (patch: Record<string, string | number | boolean | undefined>) => void;
  /**
   * Open another Workspace window from inside this one (e.g. the QI hub opening a per-run result
   * card). Singleton targets focus the existing instance; others spawn a new card carrying `cfg`.
   * Returns the new/focused window id, or null when the workspace viewport is not ready.
   */
  readonly openWindow: (
    type: WindowType,
    cfg?: Record<string, string | number | boolean>,
  ) => string | null;
}

export interface WindowTypeDef {
  readonly title: string;
  readonly icon: IconName;
  readonly accent?: boolean;
  readonly desc: string;
  readonly w: number;
  readonly h: number;
  readonly min: WindowSize;
  readonly tiny: WindowSize;
  readonly tool?: boolean;
  readonly singleton?: boolean;
  readonly config?: readonly ConfigField[];
  readonly cta?: string;
  readonly render: (cfg: Record<string, unknown>, ctx: WindowRenderContext) => ReactNode;
}

export const CHAT_MINI_W = 430;
export const CHAT_MINI_H = 430;

const DEFAULT_MIN: WindowSize = { w: 150, h: 110 };
const DEFAULT_TINY: WindowSize = { w: 290, h: 190 };

interface PartialDef {
  readonly title: string;
  readonly icon: IconName;
  readonly accent?: boolean;
  readonly desc: string;
  readonly w: number;
  readonly h: number;
  readonly min?: WindowSize;
  readonly tiny?: WindowSize;
  readonly tool?: boolean;
  readonly singleton?: boolean;
  readonly config?: readonly ConfigField[];
  readonly cta?: string;
}

// Render is deferred at module load — the real render functions are injected
// below so this file does not import the components and avoid a cycle.
const PARTIAL: Readonly<Record<WindowType, PartialDef>> = {
  chat: {
    title: "Chat",
    icon: "newChat",
    accent: true,
    desc: "Talk to Keiko",
    w: 480,
    h: 480,
    min: { w: 300, h: 260 },
    config: [
      {
        key: "title",
        label: "Title",
        type: "text",
        def: "New chat",
        optional: true,
        placeholder: "Name this conversation",
      },
    ],
  },
  chatHistory: {
    title: "Chat History",
    icon: "archive",
    desc: "Manage conversations",
    w: 380,
    h: 560,
    min: { w: 300, h: 320 },
    tiny: { w: 260, h: 220 },
    tool: true,
    singleton: true,
  },
  files: {
    title: "Files",
    icon: "files",
    accent: true,
    desc: "Browse a folder",
    w: 290,
    h: 340,
    tiny: { w: 200, h: 150 },
    config: [{ key: "root", label: "Folder", type: "directory", def: "" }],
  },
  editor: {
    title: "Editor",
    icon: "editor",
    desc: "Edit a text file",
    w: 480,
    h: 360,
    config: [
      {
        key: "file",
        label: "File path",
        type: "text",
        def: "",
        optional: true,
        placeholder: "src/app.ts",
      },
      {
        key: "root",
        label: "Root",
        type: "directory",
        def: "",
        optional: true,
      },
    ],
  },
  browser: {
    title: "Browser",
    icon: "browser",
    desc: "Open a URL",
    w: 460,
    h: 340,
    config: [
      // Audit C302 — "localhost:5173" was the Vite dev-server default of the design
      // prototype; it prefilled the form and stuck in the header badge.
      {
        key: "url",
        label: "URL",
        type: "text",
        def: "",
        optional: true,
        placeholder: "https://…",
      },
    ],
  },
  terminal: {
    title: "Terminal",
    icon: "terminal",
    accent: true,
    desc: "Run commands",
    w: 460,
    h: 250,
    tiny: { w: 250, h: 140 },
    config: [
      // ADR-0018 — terminal is a permitted-command tool. The user picks the command per run; the
      // window only needs a project path (acts as projectId) and an optional starting cwd.
      { key: "projectPath", label: "Project path", type: "text", def: "" },
      { key: "cwd", label: "Working directory", type: "directory", def: "" },
    ],
  },
  review: {
    title: "Review",
    icon: "review",
    desc: "Review a proposed diff",
    w: 520,
    h: 420,
    config: [
      {
        key: "runId",
        label: "Run ID",
        type: "text",
        def: "",
        optional: true,
        placeholder: "e.g. r-2026-06-01-…",
      },
    ],
  },
  agents: {
    title: "Agents",
    icon: "agents",
    desc: "Run a BFF workflow",
    w: 520,
    h: 560,
    tiny: { w: 250, h: 140 },
    cta: "Start agent",
    config: [],
  },
  integ: {
    title: "Integrations",
    icon: "plugins",
    desc: "Connect apps",
    w: 320,
    h: 300,
    config: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        options: ["GitHub", "Linear", "Slack", "Sentry"],
        def: "GitHub",
      },
    ],
  },
  keiko: {
    title: "Keiko",
    icon: "spark",
    desc: "Keiko twin",
    w: 344,
    h: 520,
    tool: true,
    singleton: true,
  },
  settings: {
    title: "Settings",
    icon: "settings",
    desc: "Preferences",
    w: 470,
    h: 560,
    tool: true,
    singleton: true,
  },
  project: {
    title: "Project",
    icon: "folder",
    desc: "Project tree",
    w: 304,
    h: 440,
    tool: true,
    singleton: true,
  },
  search: {
    title: "Search",
    icon: "search",
    desc: "Search the workspace",
    w: 320,
    h: 500,
    tool: true,
    singleton: true,
  },
  plugins: {
    title: "Plugins",
    icon: "plugins",
    desc: "Plugins & tools",
    w: 320,
    h: 470,
    tool: true,
    singleton: true,
  },
  automations: {
    title: "Automations",
    icon: "automations",
    desc: "Workflow automations",
    w: 320,
    h: 300,
    tool: true,
    singleton: true,
  },
  mobile: {
    // Audit C412 — title case like every other two-word title ("Figma Snapshot").
    title: "Keiko Mobile",
    icon: "mobile",
    desc: "Mobile companion",
    w: 300,
    h: 380,
    tool: true,
    singleton: true,
  },
  inspector: {
    title: "Inspector",
    icon: "layers",
    desc: "Inspect the workspace",
    w: 290,
    h: 440,
    tool: true,
    singleton: true,
  },
  activity: {
    title: "Activity",
    icon: "activity",
    desc: "Activity timeline",
    w: 322,
    h: 460,
    tool: true,
    singleton: true,
  },
  notifications: {
    title: "Notifications",
    icon: "bell",
    // Audit C412 — the desc only repeated the title; add information like the
    // other palette descriptions ("Browse a folder", "Run commands").
    desc: "Review alerts & updates",
    w: 300,
    h: 360,
    tool: true,
    singleton: true,
  },
  resources: {
    title: "Resources",
    icon: "cube",
    desc: "System resources",
    w: 300,
    h: 320,
    tool: true,
    singleton: true,
  },
  // Epic #189 Slice 3 — compact connector picker window. The user selects a ready capsule or
  // capsule-set; the selection is stored in cfg so the relationship-edge binding can read it.
  connector: {
    title: "Connector",
    icon: "plugins",
    accent: true,
    desc: "Pick a Local Knowledge connector",
    w: 320,
    h: 380,
    min: { w: 280, h: 300 },
    config: [],
    cta: "Select connector",
  },
  // Epic #270 — Quality Intelligence hub. Singleton tool window: start a run (requirements or
  // workspace folder) and browse past runs. Selecting/finishing a run opens a `qiRun` result card.
  quality: {
    title: "Quality Intelligence",
    icon: "check",
    accent: true,
    desc: "Design & review test cases",
    w: 384,
    h: 580,
    min: { w: 300, h: 320 },
    tiny: { w: 260, h: 200 },
    tool: true,
    singleton: true,
  },
  // Epic #270 — Quality Intelligence run result card. Non-singleton: one card per run (keyed by
  // cfg.runId). Shows the generated test cases, per-candidate review, and export.
  qiRun: {
    title: "QI Run",
    icon: "check",
    desc: "Generated test cases",
    w: 760,
    h: 660,
    min: { w: 320, h: 280 },
    tiny: { w: 280, h: 200 },
    config: [{ key: "runId", label: "Run ID", type: "text", def: "" }],
  },
  // Epic #532 — Relationship engine hub. Singleton tool window: browse the governed relationship
  // graph (list + filters), inspect a relationship (type/lifecycle/activity/audit/evidence/impact),
  // and review bounded impact, dependency, and health surfaces. Opens once from the LeftRail.
  relationships: {
    title: "Relationships",
    icon: "branch",
    accent: true,
    desc: "Inspect the relationship graph",
    w: 760,
    h: 600,
    min: { w: 360, h: 320 },
    tiny: { w: 300, h: 220 },
    tool: true,
    singleton: true,
  },
  // Epic #750, Issue #756 — Figma/Snapshot surface. Paste a board link, trigger a snapshot-build,
  // view captured screens + IR summaries, connect to the QI hub as a figma-snapshot source.
  // PAT stays server-side; the window only stores the resulting snapshotRunId in cfg.
  figma: {
    title: "Figma Snapshot",
    icon: "layers",
    accent: true,
    desc: "Capture a Figma board snapshot",
    w: 420,
    h: 540,
    min: { w: 320, h: 360 },
    tiny: { w: 280, h: 240 },
  },
};

const RENDER_REGISTRY = new Map<
  WindowType,
  (cfg: Record<string, unknown>, ctx: WindowRenderContext) => ReactNode
>();

export function registerWindowRender(
  type: WindowType,
  render: (cfg: Record<string, unknown>, ctx: WindowRenderContext) => ReactNode,
): void {
  RENDER_REGISTRY.set(type, render);
}

function buildDef(type: WindowType, partial: PartialDef): WindowTypeDef {
  const render = (cfg: Record<string, unknown>, ctx: WindowRenderContext): ReactNode => {
    const fn = RENDER_REGISTRY.get(type);
    if (fn !== undefined) return fn(cfg, ctx);
    return null;
  };
  const base: Omit<WindowTypeDef, "accent" | "tool" | "singleton" | "config" | "cta"> = {
    title: partial.title,
    icon: partial.icon,
    desc: partial.desc,
    w: partial.w,
    h: partial.h,
    min: partial.min ?? DEFAULT_MIN,
    tiny: partial.tiny ?? DEFAULT_TINY,
    render,
  };
  const extra: {
    accent?: boolean;
    tool?: boolean;
    singleton?: boolean;
    config?: readonly ConfigField[];
    cta?: string;
  } = {};
  if (partial.accent === true) extra.accent = true;
  if (partial.tool === true) extra.tool = true;
  if (partial.singleton === true) extra.singleton = true;
  if (partial.config !== undefined) extra.config = partial.config;
  if (partial.cta !== undefined) extra.cta = partial.cta;
  return { ...base, ...extra };
}

function buildAll(): Readonly<Record<WindowType, WindowTypeDef>> {
  const out = {} as Record<WindowType, WindowTypeDef>;
  (Object.keys(PARTIAL) as WindowType[]).forEach((key) => {
    out[key] = buildDef(key, PARTIAL[key]);
  });
  return out;
}

export const WIN_TYPES: Readonly<Record<WindowType, WindowTypeDef>> = buildAll();

// Wave 5 palette ordering. Cards first, then tools.
export const TYPE_ORDER: readonly WindowType[] = [
  "chat",
  "chatHistory",
  "connector",
  "figma",
  "files",
  "editor",
  "browser",
  "terminal",
  "review",
  "agents",
  "integ",
  "quality",
  "relationships",
  "keiko",
  "project",
  "search",
  "plugins",
  "automations",
  "mobile",
  "inspector",
  "activity",
  "notifications",
  "resources",
  "settings",
];
