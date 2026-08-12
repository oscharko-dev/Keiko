import type { ReactNode } from "react";
import type {
  QualityIntelligenceFigmaSnapshotSource,
  QualityIntelligenceImageSource,
  WorkspaceBinding,
} from "@oscharko-dev/keiko-contracts";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../hooks/useWorkspace.types";
import type { IconName } from "../Icons";
import type { I18nTranslate } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n-messages.en";
import type { AppWindow, WindowCfgValue } from "./types";

export type WindowType =
  | "chat"
  | "chatHistory"
  | "memoria"
  | "files"
  | "editor"
  | "browser"
  | "docbrowser"
  | "terminal"
  | "commands"
  | "runtime"
  // Epic #1982, Issue #1990 — first-class Coding Workbench singleton. Browser code renders only
  // contract/server projections; sidecar, shell, git, provider, and connector authority stay server-side.
  | "coding"
  // Issue #1388 (ADR-0070) — Container engine status surface. A read-mostly status card: probes the
  // host container engine on demand and, when available, exposes the server-frozen diagnostic task
  // catalog + a governed run control. With no engine it shows the structured unavailable state and
  // never blocks the rest of Keiko. No durable state of its own (capability is re-probed per mount).
  | "containerStatus"
  | "review"
  | "agents"
  | "integ"
  | "keiko"
  | "settings"
  | "workspaceTrust"
  // Issue #1696 — governed package-update window. Opened only from Settings/startup notification,
  // not from the rail or command palette.
  | "updates"
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
  // Local Knowledge Connector hub. Singleton tool window: manages capsules inside the Workspace.
  | "localKnowledge"
  // Issue #2213 (Epic #2092) — workspace Problems panel. Singleton tool window.
  | "problems"
  // Issue #2346 (Epic #2096) — one bounded debug window with stack, variables, watches, and output.
  | "debug"
  // Epic #270 — Quality Intelligence: a singleton hub (start runs + run list) plus per-run result
  // cards. QI lives inside the Workspace like every other window, not as a full-page route.
  | "quality"
  | "qiRun"
  // Epic #532 — Relationship engine: a singleton tool window (graph list + inspector + impact +
  // health). Like QI, it lives inside the Workspace, not as a full-page route.
  | "relationships"
  // Epic #1307, Issue #1314 — Prompt Enhancer: a singleton tool window. Enter a raw prompt, choose a
  // profile + missing-info strategy, and review the governed Enhanced Prompt (sections, grounding
  // plan, safety rules, output schema, quality criteria, candidate scorecards) before any downstream
  // use. Deterministic by default; an optional enhancement model is routed through the Model Gateway.
  | "promptEnhancer"
  // Epic #750, Issue #756 — Figma/Snapshot surface. Paste a board link, trigger a snapshot-build,
  // view captured screens + IR summaries. Connects to the QI hub as a figma-snapshot source.
  | "figma"
  // A scoped Figma View card derived from the singleton Snapshot manager. Unlike the manager, this
  // is intentionally repeatable: each card can expose its JSON and image sources independently.
  | "figmaView"
  // A scoped, JSON-only Figma Screen-IR source window derived from a Figma Snapshot view.
  | "figmaJson"
  // A scoped, image-only Figma screen-render source window derived from a Figma Snapshot view.
  | "figmaImage"
  // Epic #1631, Issue #1634 — passive PDF viewer window backed only by verified #1633 preview
  // sessions. Not palette-launchable: opened programmatically from a citation preview action.
  | "pdfCitationPreview"
  // Epic #470, Issue #475 — Git flow surface. A per-project card walking
  // branch → staging → commit (live preview + message-policy + policy decision) entirely through the
  // governed mutation kernel.
  | "governedGit"
  // Epic #470, Issue #477 — Governed GitHub pull request command center. Turns a published branch into
  // a review-ready PR (synthesized editable metadata + readiness + recommendation) through the governed
  // PR gateway.
  | "governedPullRequest"
  // Epic #470, Issue #478 — Governed merge command center. Turns a review-ready PR into a merged base
  // branch (eligible-strategy selector + readiness + final high-risk approval) through the governed
  // merge gateway.
  | "governedMerge";

export type WindowCfgRecord = Record<string, WindowCfgValue>;

interface ChatWindowCfg extends WindowCfgRecord {
  readonly chatId?: string;
  readonly title?: string;
  readonly modelId?: string;
  readonly selectionHandoffId?: string;
  readonly newChatRequestId?: string;
}

interface FilesWindowCfg extends WindowCfgRecord {
  readonly root?: string;
  readonly activeFilePath?: string;
  readonly activeDirectoryPath?: string;
  readonly resolvedRoot?: string;
}

interface EditorWindowCfg extends WindowCfgRecord {
  readonly root?: string;
  readonly file?: string;
  readonly openFiles?: readonly string[];
  readonly layoutJson?: string;
  readonly rootSessionsJson?: string;
}

interface FigmaSourceWindowCfg extends WindowCfgRecord {
  readonly snapshotRunId?: string;
  readonly screenId?: string;
  readonly selectedScreenIdsJson?: string;
  readonly selectedScreenName?: string;
  readonly imageSrc?: string;
}

interface ProjectRootWindowCfg extends WindowCfgRecord {
  readonly projectPath?: string;
  readonly root?: string;
}

export type WindowCfgByType = {
  readonly [K in WindowType]: WindowCfgRecord;
} & {
  readonly chat: ChatWindowCfg;
  readonly files: FilesWindowCfg;
  readonly editor: EditorWindowCfg;
  readonly figma: FigmaSourceWindowCfg;
  readonly figmaView: FigmaSourceWindowCfg;
  readonly figmaJson: FigmaSourceWindowCfg;
  readonly figmaImage: FigmaSourceWindowCfg;
  readonly terminal: ProjectRootWindowCfg & { readonly cwd?: string };
  readonly runtime: ProjectRootWindowCfg;
  readonly coding: ProjectRootWindowCfg & {
    readonly runId?: string;
    readonly state?: string;
    readonly taskRef?: string;
  };
  readonly governedGit: ProjectRootWindowCfg;
  readonly governedPullRequest: ProjectRootWindowCfg & { readonly headBranchName?: string };
  readonly governedMerge: ProjectRootWindowCfg & { readonly headBranchName?: string };
  readonly qiRun: WindowCfgRecord & { readonly runId?: string };
  readonly connector: WindowCfgRecord & {
    readonly selectedKind?: string;
    readonly selectedId?: string;
  };
  readonly pdfCitationPreview: WindowCfgRecord & {
    readonly currentPage?: number;
    readonly pageNumber?: number;
    readonly sourceLabel?: string;
    readonly documentLabel?: string;
  };
};

interface WindowSize {
  readonly w: number;
  readonly h: number;
}

type ConfigFieldType = "text" | "select" | "textarea" | "perm" | "directory";

/**
 * Issue: German locale coverage. A launcher field carries MESSAGE KEYS, never display copy — the
 * three surfaces that render these fields (window launcher, New Window dialog, quick-access
 * commands) all read this one table, so an English literal here reached the user untranslated no
 * matter which locale was selected. `def` stays a raw string for machine defaults (`""`, an enum
 * member such as `"empty"`, a provider name); `defKey` is for the one case where the default is
 * user-visible COPY that gets typed into the created window (the chat title).
 */
// Not exported: the only cross-module consumer was a new-window field localizer that became
// redundant once the registry resolved its own message keys. `LocalizedConfigField` below is the
// shape callers actually receive.
interface ConfigField {
  readonly key: string;
  readonly labelKey: MessageKey;
  readonly type: ConfigFieldType;
  readonly def?: string;
  readonly defKey?: MessageKey;
  readonly optional?: boolean;
  readonly placeholderKey?: MessageKey;
  readonly options?: readonly string[];
  readonly prefix?: string;
}

/** A `ConfigField` with every message key already resolved for the active locale. */
export interface LocalizedConfigField {
  readonly key: string;
  readonly label: string;
  readonly type: ConfigFieldType;
  readonly def: string;
  readonly optional?: boolean;
  readonly placeholder?: string;
  readonly options?: readonly string[];
  readonly prefix?: string;
}

export interface WindowRenderContext {
  readonly windowId: string;
  readonly mini?: boolean;
  readonly minimalChat?: boolean;
  readonly compact?: boolean;
  readonly controlsNarrow?: boolean;
  readonly barCompact?: boolean;
  readonly workflowCompact?: boolean;
  readonly linkedRoot: string | null;
  readonly linkedFilePath: string | undefined;
  readonly linkedRoots: readonly string[];
  /** Epic #710 #718 — capsule ids from connected Connector windows (capsule kind only). */
  readonly linkedCapsuleIds: readonly string[];
  /** Epic #710 #718 — capsule-set ids from connected Connector windows (capsule-set kind only). */
  readonly linkedCapsuleSetIds: readonly string[];
  /** Epic #750 #756 — snapshot run ids from connected Figma Snapshot windows. */
  readonly linkedFigmaSnapshotRunIds: readonly string[];
  /** Figma Snapshot sources, optionally scoped to selected screen ids. */
  readonly linkedFigmaSnapshotSources?:
    readonly QualityIntelligenceFigmaSnapshotSource[] | undefined;
  /** Image-only sources connected to Quality Intelligence. */
  readonly linkedImageSources?: readonly QualityIntelligenceImageSource[] | undefined;
  /**
   * The available folder/repository selected for the whole Workbench. This is the shared base
   * context below an optional managed task-workspace binding; it never grants task execution
   * authority by itself.
   */
  readonly selectedRoot?: string | null;
  /**
   * Issue #446 (ADR-0090) — the active task-workspace root, or null in unbound mode. The SINGLE
   * retarget choke point: when a workspace is active this OVERRIDES a bound surface's per-window cfg
   * root, so a switch re-renders every window onto the new root atomically (no stale context).
   */
  readonly activeRoot: string | null;
  /** Issue #446 — the derived active binding (taskId/boundSurfaces/activeRoot), or null when unbound. */
  readonly activeBinding: WorkspaceBinding | null;
  readonly updateCfg: (patch: AppWindow["cfg"]) => void;
  /**
   * Open another Workspace window from inside this one (e.g. the QI hub opening a per-run result
   * card). Singleton targets focus the existing instance; others spawn a new card carrying `cfg`.
   * Returns the new/focused window id, or null when the workspace viewport is not ready.
   */
  readonly openWindow: (type: WindowType, cfg?: AppWindow["cfg"]) => string | null;
  readonly focusWindow: (id: string) => void;
  readonly restoreWindow?: ((id: string) => void) | undefined;
  readonly updateWindow: (id: string, patch: Partial<AppWindow>) => void;
  readonly openEditorFile: (request: OpenEditorFileRequest) => OpenEditorFileResult;
}

export type WindowRender<T extends WindowType = WindowType> = (
  cfg: WindowCfgByType[T],
  ctx: WindowRenderContext,
) => ReactNode;

export type WindowStatus = "placeholder";

export interface WindowTypeDef {
  readonly titleKey: MessageKey;
  readonly icon: IconName;
  readonly accent?: boolean;
  readonly descKey: MessageKey;
  readonly w: number;
  readonly h: number;
  readonly min: WindowSize;
  readonly tiny: WindowSize;
  readonly tool?: boolean;
  readonly singleton?: boolean;
  readonly config?: readonly ConfigField[];
  readonly ctaKey?: MessageKey;
  /**
   * KEIKO-0349: non-functional placeholder surface. Shell chrome (New Window palette, dock,
   * window title) may surface this to disclose to the user that the surface is a preview instead
   * of a working feature. Absence means "functional".
   */
  readonly status?: WindowStatus;
  readonly render: WindowRender;
}

export const CHAT_MINI_W = 430;

const DEFAULT_MIN: WindowSize = { w: 150, h: 110 };
const DEFAULT_TINY: WindowSize = { w: 290, h: 190 };

interface PartialDef {
  readonly titleKey: MessageKey;
  readonly icon: IconName;
  readonly accent?: boolean;
  readonly descKey: MessageKey;
  readonly w: number;
  readonly h: number;
  readonly min?: WindowSize;
  readonly tiny?: WindowSize;
  readonly tool?: boolean;
  readonly singleton?: boolean;
  readonly config?: readonly ConfigField[];
  readonly ctaKey?: MessageKey;
  readonly status?: WindowStatus;
}

// Render is deferred at module load — the real render functions are injected
// below so this file does not import the components and avoid a cycle.
const PARTIAL: Readonly<Record<WindowType, PartialDef>> = {
  chat: {
    titleKey: "window.type.chat.title",
    icon: "newChat",
    accent: true,
    descKey: "window.type.chat.desc",
    w: 480,
    h: 480,
    min: { w: 300, h: 260 },
    singleton: true,
    config: [
      {
        key: "title",
        labelKey: "window.field.title",
        type: "text",
        defKey: "window.default.chatTitle",
        optional: true,
        placeholderKey: "window.placeholder.chatTitle",
      },
    ],
  },
  chatHistory: {
    titleKey: "window.type.chatHistory.title",
    icon: "archive",
    descKey: "window.type.chatHistory.desc",
    w: 380,
    h: 560,
    min: { w: 300, h: 320 },
    tiny: { w: 260, h: 220 },
    tool: true,
    singleton: true,
  },
  memoria: {
    titleKey: "window.type.memoria.title",
    icon: "brain",
    descKey: "window.type.memoria.desc",
    w: 680,
    h: 600,
    min: { w: 420, h: 360 },
    tiny: { w: 300, h: 220 },
    tool: true,
    singleton: true,
  },
  files: {
    titleKey: "window.type.files.title",
    icon: "files",
    accent: true,
    descKey: "window.type.files.desc",
    w: 290,
    h: 340,
    tiny: { w: 200, h: 150 },
    config: [{ key: "root", labelKey: "window.field.folder", type: "directory" }],
  },
  editor: {
    titleKey: "window.type.editor.title",
    icon: "editor",
    descKey: "window.type.editor.desc",
    // Toggle-able from the left rail: `deriveOpenTools` reads `tool` to reflect the open state on
    // the rail button (the editor stays a config-capable card type opened via the New Window dialog
    // or `openWindow("editor", …)`; this only adds the rail-toggle affordance).
    tool: true,
    w: 920,
    h: 620,
    min: { w: 620, h: 380 },
    config: [
      {
        key: "root",
        labelKey: "window.field.folder",
        type: "directory",
        def: "",
        optional: true,
        placeholderKey: "window.placeholder.folderPath",
      },
      {
        key: "file",
        labelKey: "window.field.filePath",
        type: "text",
        def: "",
        optional: true,
        placeholderKey: "window.placeholder.relativeFilePath",
      },
    ],
  },
  browser: {
    titleKey: "window.type.browser.title",
    icon: "browser",
    descKey: "window.type.browser.desc",
    w: 460,
    h: 340,
    config: [
      // Audit C302 — "localhost:5173" was the Vite dev-server default of the design
      // prototype; it prefilled the form and stuck in the header badge.
      {
        key: "url",
        labelKey: "window.field.url",
        type: "text",
        def: "",
        optional: true,
        placeholderKey: "window.placeholder.url",
      },
    ],
  },
  docbrowser: {
    titleKey: "window.type.docbrowser.title",
    icon: "file",
    descKey: "window.type.docbrowser.desc",
    w: 480,
    h: 360,
    config: [
      {
        key: "target",
        labelKey: "window.field.documentationAddress",
        type: "text",
        def: "",
        optional: true,
        placeholderKey: "window.placeholder.documentationAddress",
      },
    ],
  },
  terminal: {
    titleKey: "window.type.terminal.title",
    icon: "terminal",
    accent: true,
    descKey: "window.type.terminal.desc",
    w: 460,
    h: 250,
    tiny: { w: 250, h: 140 },
    config: [
      // ADR-0018 — terminal is a permitted-command tool. The user picks the command per run; the
      // window only needs a project path (acts as projectId) and an optional starting cwd.
      { key: "projectPath", labelKey: "window.field.projectPath", type: "text" },
      { key: "cwd", labelKey: "window.field.workingDirectory", type: "directory" },
    ],
  },
  commands: {
    titleKey: "window.type.commands.title",
    icon: "terminal",
    accent: true,
    descKey: "window.type.commands.desc",
    w: 460,
    h: 280,
    tiny: { w: 250, h: 140 },
    config: [
      // Issue #1387 — the command runner discovers test/build/run tasks from the project's package
      // scripts. The window only needs a project path (acts as projectId); tasks are picked per run.
      { key: "projectPath", labelKey: "window.field.projectPath", type: "text" },
    ],
  },
  runtime: {
    titleKey: "window.type.runtime.title",
    icon: "cube",
    accent: true,
    descKey: "window.type.runtime.desc",
    w: 500,
    h: 390,
    min: { w: 320, h: 260 },
    tiny: { w: 260, h: 200 },
    config: [
      // Issue #1389 — this hub only carries the active project path and opens the specialized
      // governed surfaces. It does not execute commands or Git operations itself.
      { key: "projectPath", labelKey: "window.field.projectPath", type: "text", optional: true },
    ],
  },
  coding: {
    titleKey: "window.type.coding.title",
    icon: "code",
    accent: true,
    descKey: "window.type.coding.desc",
    w: 860,
    // #2644 docked the composer to the bottom of the shell, so this window's controls are only
    // reachable while the whole frame fits the scene. At the 1280x720 reference viewport the scene
    // offers ~623px between the top bar and the status footer; the previous 680 pushed the send
    // control behind the footer, where no amount of scrolling could reach it.
    h: 600,
    min: { w: 302, h: 420 },
    tiny: { w: 300, h: 260 },
    tool: true,
    singleton: true,
    config: [
      {
        key: "state",
        labelKey: "window.field.previewState",
        type: "select",
        options: [
          "empty",
          "running",
          "approval-required",
          "blocked",
          "governed-assist",
          "governed-assist-blocked",
          "supervised-approval-required",
          "supervised-approved",
          "supervised-denied",
          "supervised-stopped",
          "supervised-failed",
          "autonomous-confirmed",
          "autonomous-policy-blocked",
          "autonomous-verification-failed",
          "autonomous-completed",
          "failed",
          "completed",
        ],
        def: "empty",
        optional: true,
      },
    ],
  },
  containerStatus: {
    titleKey: "window.type.containerStatus.title",
    icon: "cube",
    descKey: "window.type.containerStatus.desc",
    w: 460,
    h: 320,
    min: { w: 300, h: 220 },
    tiny: { w: 250, h: 160 },
    config: [
      // Issue #1388 — the status surface probes the host container engine on demand. An optional
      // project path scopes the allowlisted diagnostic catalog; with no engine it degrades gracefully.
      { key: "projectPath", labelKey: "window.field.projectPath", type: "text", optional: true },
    ],
  },
  review: {
    titleKey: "window.type.review.title",
    icon: "review",
    descKey: "window.type.review.desc",
    w: 520,
    h: 420,
    config: [
      {
        key: "runId",
        labelKey: "window.field.runId",
        type: "text",
        def: "",
        optional: true,
        placeholderKey: "window.placeholder.runId",
      },
    ],
  },
  agents: {
    titleKey: "window.type.agents.title",
    icon: "agents",
    descKey: "window.type.agents.desc",
    w: 520,
    h: 560,
    tiny: { w: 250, h: 140 },
    ctaKey: "window.type.agents.cta",
    config: [],
  },
  integ: {
    titleKey: "window.type.integ.title",
    icon: "plugins",
    descKey: "window.type.integ.desc",
    w: 320,
    h: 300,
    config: [
      {
        key: "provider",
        labelKey: "window.field.provider",
        type: "select",
        options: ["GitHub", "Linear", "Slack", "Sentry"],
        def: "GitHub",
      },
    ],
  },
  keiko: {
    titleKey: "window.type.keiko.title",
    icon: "spark",
    descKey: "window.type.keiko.desc",
    w: 344,
    h: 520,
    tool: true,
    singleton: true,
  },
  settings: {
    titleKey: "window.type.settings.title",
    icon: "settings",
    descKey: "window.type.settings.desc",
    w: 470,
    h: 560,
    tool: true,
    singleton: true,
  },
  workspaceTrust: {
    titleKey: "window.type.workspaceTrust.title",
    icon: "settings",
    descKey: "window.type.workspaceTrust.desc",
    w: 620,
    h: 560,
    min: { w: 320, h: 360 },
    tiny: { w: 300, h: 250 },
    tool: true,
    singleton: true,
  },
  updates: {
    titleKey: "window.type.updates.title",
    icon: "activity",
    descKey: "window.type.updates.desc",
    w: 620,
    h: 640,
    min: { w: 420, h: 430 },
    tiny: { w: 320, h: 260 },
    singleton: true,
  },
  project: {
    titleKey: "window.type.project.title",
    icon: "folder",
    descKey: "window.type.project.desc",
    w: 304,
    h: 440,
    tool: true,
    singleton: true,
  },
  search: {
    titleKey: "window.type.search.title",
    icon: "search",
    descKey: "window.type.search.desc",
    w: 320,
    h: 500,
    tool: true,
    singleton: true,
  },
  plugins: {
    titleKey: "window.type.plugins.title",
    icon: "plugins",
    descKey: "window.type.plugins.desc",
    w: 320,
    h: 470,
    tool: true,
    singleton: true,
    status: "placeholder",
  },
  automations: {
    titleKey: "window.type.automations.title",
    icon: "automations",
    descKey: "window.type.automations.desc",
    w: 320,
    h: 300,
    tool: true,
    singleton: true,
    status: "placeholder",
  },
  mobile: {
    // Audit C412 — title case like every other two-word title ("Figma Snapshot").
    titleKey: "window.type.mobile.title",
    icon: "mobile",
    descKey: "window.type.mobile.desc",
    w: 300,
    h: 380,
    tool: true,
    singleton: true,
    status: "placeholder",
  },
  inspector: {
    titleKey: "window.type.inspector.title",
    icon: "layers",
    descKey: "window.type.inspector.desc",
    w: 290,
    h: 440,
    tool: true,
    singleton: true,
  },
  activity: {
    titleKey: "window.type.activity.title",
    icon: "activity",
    descKey: "window.type.activity.desc",
    w: 322,
    h: 460,
    tool: true,
    singleton: true,
  },
  notifications: {
    titleKey: "window.type.notifications.title",
    icon: "bell",
    // Audit C412 — the desc only repeated the title; add information like the
    // other palette descriptions ("Browse a folder", "Run commands").
    descKey: "window.type.notifications.desc",
    w: 300,
    h: 360,
    tool: true,
    singleton: true,
    status: "placeholder",
  },
  resources: {
    titleKey: "window.type.resources.title",
    icon: "cube",
    descKey: "window.type.resources.desc",
    w: 300,
    h: 320,
    tool: true,
    singleton: true,
    status: "placeholder",
  },
  // Epic #189 Slice 3 / Epic #1815 — compact Knowledge Pod picker window. The user selects
  // a ready capsule or capsule-set; the selection is stored in cfg for relationship binding.
  connector: {
    titleKey: "window.type.connector.title",
    icon: "server",
    accent: true,
    descKey: "window.type.connector.desc",
    w: 320,
    h: 380,
    min: { w: 220, h: 180 },
    config: [],
  },
  localKnowledge: {
    titleKey: "window.type.localKnowledge.title",
    icon: "localKnowledge",
    accent: true,
    descKey: "window.type.localKnowledge.desc",
    w: 720,
    h: 560,
    min: { w: 360, h: 320 },
    tiny: { w: 300, h: 220 },
    tool: true,
    singleton: true,
  },
  // Issue #2213 (Epic #2092, ADR-0126) — workspace Problems panel. Singleton tool window (one
  // deduplicated instance, localKnowledge-style) aggregating open-file diagnostics + verification
  // failures with jump-to-line.
  problems: {
    titleKey: "window.type.problems.title",
    icon: "activity",
    accent: true,
    descKey: "window.type.problems.desc",
    w: 640,
    h: 480,
    min: { w: 360, h: 280 },
    tiny: { w: 300, h: 200 },
    tool: true,
    singleton: true,
  },
  debug: {
    titleKey: "window.type.debug.title",
    icon: "activity",
    accent: true,
    descKey: "window.type.debug.desc",
    w: 680,
    h: 560,
    min: { w: 400, h: 320 },
    tiny: { w: 300, h: 240 },
    tool: true,
    singleton: true,
  },
  // Epic #270 — Quality Intelligence hub. Singleton tool window: start a run (requirements or
  // workspace folder) and browse past runs. Selecting/finishing a run opens a `qiRun` result card.
  quality: {
    titleKey: "window.type.quality.title",
    icon: "check",
    accent: true,
    descKey: "window.type.quality.desc",
    w: 384,
    h: 580,
    min: { w: 300, h: 320 },
    tiny: { w: 260, h: 200 },
    tool: true,
    singleton: true,
  },
  // Epic #1307, Issue #1314 — Prompt Enhancer singleton tool window. Dense workflow-first surface:
  // raw prompt → profile + strategy → governed Enhanced Prompt with candidate scorecards.
  promptEnhancer: {
    titleKey: "window.type.promptEnhancer.title",
    icon: "spark",
    accent: true,
    descKey: "window.type.promptEnhancer.desc",
    w: 880,
    h: 720,
    min: { w: 520, h: 420 },
    tiny: { w: 320, h: 240 },
    tool: true,
    singleton: true,
  },
  // Epic #270 — Quality Intelligence run result card. Non-singleton: one card per run (keyed by
  // cfg.runId). Shows the generated test cases, per-candidate review, and export.
  qiRun: {
    titleKey: "window.type.qiRun.title",
    icon: "check",
    descKey: "window.type.qiRun.desc",
    w: 760,
    h: 660,
    min: { w: 320, h: 280 },
    tiny: { w: 280, h: 200 },
    config: [{ key: "runId", labelKey: "window.field.runId", type: "text" }],
  },
  // Epic #532 — Relationship engine hub. Singleton tool window: browse the governed relationship
  // graph (list + filters), inspect a relationship (type/lifecycle/activity/audit/evidence/impact),
  // and review bounded impact, dependency, and health surfaces. Opens once from the LeftRail.
  relationships: {
    titleKey: "window.type.relationships.title",
    icon: "branch",
    accent: true,
    descKey: "window.type.relationships.desc",
    w: 760,
    h: 600,
    min: { w: 360, h: 320 },
    tiny: { w: 300, h: 220 },
    tool: true,
    singleton: true,
  },
  // Epic #750, Issue #756 — Figma Snapshot manager. Paste a board link, trigger snapshot builds,
  // inspect stored snapshots, and open scoped screen source cards for Quality Intelligence.
  // PAT stays server-side; the manager stores only the currently loaded snapshotRunId in cfg.
  figma: {
    titleKey: "window.type.figma.title",
    icon: "layers",
    accent: true,
    descKey: "window.type.figma.desc",
    w: 420,
    h: 540,
    min: { w: 320, h: 360 },
    tiny: { w: 280, h: 240 },
    tool: true,
    singleton: true,
  },
  figmaView: {
    titleKey: "window.type.figmaView.title",
    icon: "layers",
    accent: true,
    descKey: "window.type.figmaView.desc",
    w: 360,
    h: 360,
    min: { w: 300, h: 260 },
    tiny: { w: 260, h: 200 },
  },
  figmaJson: {
    titleKey: "window.type.figmaJson.title",
    icon: "file",
    accent: true,
    descKey: "window.type.figmaJson.desc",
    w: 520,
    h: 540,
    min: { w: 340, h: 300 },
    tiny: { w: 280, h: 220 },
  },
  figmaImage: {
    titleKey: "window.type.figmaImage.title",
    icon: "file",
    accent: true,
    descKey: "window.type.figmaImage.desc",
    w: 560,
    h: 420,
    min: { w: 300, h: 240 },
    tiny: { w: 240, h: 180 },
  },
  pdfCitationPreview: {
    titleKey: "window.type.pdfCitationPreview.title",
    icon: "file",
    accent: true,
    descKey: "window.type.pdfCitationPreview.desc",
    w: 880,
    h: 680,
    min: { w: 440, h: 320 },
    tiny: { w: 320, h: 220 },
  },
  // Epic #470, Issue #475 — Git flow. Branch → staging → commit, walked entirely
  // through the governed mutation kernel. Reads the active project root from cfg (like terminal).
  governedGit: {
    titleKey: "window.type.governedGit.title",
    icon: "git",
    accent: true,
    descKey: "window.type.governedGit.desc",
    w: 520,
    h: 640,
    min: { w: 360, h: 420 },
    tiny: { w: 300, h: 240 },
    tool: true,
    singleton: true,
    config: [{ key: "projectPath", labelKey: "window.field.projectPath", type: "text" }],
  },
  // Epic #470, Issue #477 — Governed GitHub pull request command center. Reads the active project root
  // from cfg (like governedGit) and the published head branch carried from the Publish section.
  governedPullRequest: {
    titleKey: "window.type.governedPullRequest.title",
    icon: "git",
    accent: true,
    descKey: "window.type.governedPullRequest.desc",
    w: 540,
    h: 680,
    min: { w: 380, h: 440 },
    tiny: { w: 320, h: 260 },
    config: [
      { key: "projectPath", labelKey: "window.field.projectPath", type: "text" },
      { key: "headBranchName", labelKey: "window.field.headBranch", type: "text" },
    ],
  },
  // Epic #470, Issue #478 — Governed merge command center. Reads the active project root from cfg (like
  // governedPullRequest) and the head branch under review carried from the Pull Request section.
  governedMerge: {
    titleKey: "window.type.governedMerge.title",
    icon: "git",
    accent: true,
    descKey: "window.type.governedMerge.desc",
    w: 540,
    h: 680,
    min: { w: 380, h: 440 },
    tiny: { w: 320, h: 260 },
    config: [
      { key: "projectPath", labelKey: "window.field.projectPath", type: "text" },
      { key: "headBranchName", labelKey: "window.field.headBranch", type: "text" },
    ],
  },
};

const RENDER_REGISTRY = new Map<
  WindowType,
  (cfg: WindowCfgRecord, ctx: WindowRenderContext) => ReactNode
>();

export function registerWindowRender<T extends WindowType>(type: T, render: WindowRender<T>): void {
  RENDER_REGISTRY.set(
    type,
    render as (cfg: WindowCfgRecord, ctx: WindowRenderContext) => ReactNode,
  );
}

export function missingWindowRenderTypes(): readonly WindowType[] {
  return (Object.keys(PARTIAL) as WindowType[]).filter((type) => !RENDER_REGISTRY.has(type));
}

export function assertWindowRenderRegistryComplete(): void {
  const missing = missingWindowRenderTypes();
  if (missing.length > 0) {
    throw new Error(`Missing window render registration for: ${missing.join(", ")}`);
  }
}

function buildDef(type: WindowType, partial: PartialDef): WindowTypeDef {
  const render = (cfg: WindowCfgRecord, ctx: WindowRenderContext): ReactNode => {
    const fn = RENDER_REGISTRY.get(type);
    if (fn !== undefined) return fn(cfg, ctx);
    return null;
  };
  const base: Omit<
    WindowTypeDef,
    "accent" | "tool" | "singleton" | "config" | "ctaKey" | "status"
  > = {
    titleKey: partial.titleKey,
    icon: partial.icon,
    descKey: partial.descKey,
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
    ctaKey?: MessageKey;
    status?: WindowStatus;
  } = {};
  if (partial.accent === true) extra.accent = true;
  if (partial.tool === true) extra.tool = true;
  if (partial.singleton === true) extra.singleton = true;
  if (partial.config !== undefined) extra.config = partial.config;
  if (partial.ctaKey !== undefined) extra.ctaKey = partial.ctaKey;
  if (partial.status !== undefined) extra.status = partial.status;
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

/**
 * The ONE place a window type turns into display copy. Every shell surface that shows a window's
 * name (launcher grid, New Window dialog, quick-access commands, window chrome, footer, inspector)
 * routes through these four helpers, so a locale switch moves all of them together instead of
 * leaving the English literal that used to live in `WIN_TYPES[type].title`.
 */
export function localizedWindowTitle(t: I18nTranslate, type: WindowType): string {
  return t(WIN_TYPES[type].titleKey);
}

export function localizedWindowDesc(t: I18nTranslate, type: WindowType): string {
  return t(WIN_TYPES[type].descKey);
}

export function localizedWindowCta(t: I18nTranslate, type: WindowType): string | undefined {
  const key = WIN_TYPES[type].ctaKey;
  return key === undefined ? undefined : t(key);
}

function localizedConfigField(t: I18nTranslate, field: ConfigField): LocalizedConfigField {
  const resolved: LocalizedConfigField = {
    key: field.key,
    label: t(field.labelKey),
    type: field.type,
    def: field.defKey === undefined ? (field.def ?? "") : t(field.defKey),
  };
  return {
    ...resolved,
    ...(field.optional === true ? { optional: true } : {}),
    ...(field.placeholderKey === undefined ? {} : { placeholder: t(field.placeholderKey) }),
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.prefix === undefined ? {} : { prefix: field.prefix }),
  };
}

export function localizedWindowConfigFields(
  t: I18nTranslate,
  type: WindowType,
): readonly LocalizedConfigField[] {
  return (WIN_TYPES[type].config ?? []).map((field) => localizedConfigField(t, field));
}

// Wave 5 palette ordering. Cards first, then tools.
export const TYPE_ORDER: readonly WindowType[] = [
  "chat",
  "chatHistory",
  "memoria",
  "connector",
  "localKnowledge",
  "problems",
  "figma",
  "figmaJson",
  "files",
  "editor",
  "runtime",
  "governedGit",
  "governedPullRequest",
  "governedMerge",
  "quality",
  "promptEnhancer",
  "relationships",
  "automations",
  "mobile",
  "inspector",
  "activity",
  "notifications",
  "resources",
  "settings",
  "workspaceTrust",
];
