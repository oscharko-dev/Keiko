import type { ReactNode } from "react";
import type { IconName } from "../Icons";

export type WindowType =
  | "chat"
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
  | "resources";

export interface WindowSize {
  readonly w: number;
  readonly h: number;
}

export interface WindowRenderContext {
  readonly linkedRoot: string | null;
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
  },
  files: {
    title: "Files",
    icon: "files",
    accent: true,
    desc: "Browse a folder",
    w: 290,
    h: 340,
    tiny: { w: 200, h: 150 },
  },
  editor: { title: "Editor", icon: "editor", desc: "Edit a file", w: 480, h: 360 },
  browser: { title: "Browser", icon: "browser", desc: "Open a URL", w: 460, h: 340 },
  terminal: {
    title: "Terminal",
    icon: "terminal",
    accent: true,
    desc: "Run commands",
    w: 460,
    h: 250,
    tiny: { w: 250, h: 140 },
  },
  review: { title: "Review", icon: "review", desc: "View code diffs", w: 420, h: 320 },
  agents: {
    title: "Agents",
    icon: "agents",
    desc: "Spin up a working agent",
    w: 360,
    h: 230,
    tiny: { w: 250, h: 140 },
  },
  integ: { title: "Integrations", icon: "plugins", desc: "Connect apps", w: 320, h: 300 },
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
    title: "Keiko mobile",
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
    desc: "Notifications",
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
  const base: Omit<WindowTypeDef, "accent" | "tool" | "singleton"> = {
    title: partial.title,
    icon: partial.icon,
    desc: partial.desc,
    w: partial.w,
    h: partial.h,
    min: partial.min ?? DEFAULT_MIN,
    tiny: partial.tiny ?? DEFAULT_TINY,
    render,
  };
  const extra: { accent?: boolean; tool?: boolean; singleton?: boolean } = {};
  if (partial.accent === true) extra.accent = true;
  if (partial.tool === true) extra.tool = true;
  if (partial.singleton === true) extra.singleton = true;
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
  "files",
  "editor",
  "browser",
  "terminal",
  "review",
  "agents",
  "integ",
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
