"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { ActiveWorkspaceProvider } from "./context/ActiveWorkspaceContext";
import { AnnouncerProvider } from "./context/AnnouncerContext";
import { useActiveWorkspaceState } from "./hooks/useActiveWorkspaceState";
import { TaskWorkspaceSwitcher } from "./TaskWorkspaceSwitcher";
import { TwinProvider, useTwin } from "./context/TwinContext";
import { WsContext, type WsContextValue } from "./context/WsContext";
import { Footer } from "./Footer";
import { Header, type HeaderStatusTone } from "./Header";
import { LeftRail } from "./LeftRail";
import { RightRail } from "./RightRail";
import { Workspace } from "./Workspace";
import { useLinkRevision } from "./hooks/useLinkRevision";
import { useUnhandledRejectionLog } from "./hooks/useUnhandledRejectionLog";
import {
  readWorkspaceCameraSmoothness,
  WORKSPACE_CAMERA_SMOOTHNESS_EVENT,
} from "./workspace-appearance";
import { type Command } from "./modals/CommandPalette";
import { GatewaySetupDialog } from "./modals/GatewaySetupDialog";
import { NewWindowDialog } from "./modals/NewWindowDialog";
import { Palette } from "./modals/Palette";
import { UnifiedQuickAccessPalette } from "./modals/UnifiedQuickAccessPalette";
import { type Cfg } from "./modals/PermControl";
import { useChatSession } from "./hooks/useChatSession";
import { useTheme } from "./hooks/useTheme";
import { useWorkspace } from "./hooks/useWorkspace";
import {
  appendConnectorScope,
  appendConnectedScope,
  effectiveLocalKnowledgeScopes,
  effectiveScopes,
  isConnectorScopeConnected,
  isScopeConnected,
  removeConnectorScope,
  removeConnectedScope,
  boundScopeOf,
  filesChatBindScope,
  totalSourceCap,
} from "./hooks/workspaceActions";
import { fetchConfig, updateChatConnectedScopes, updateChatLocalKnowledgeScopes } from "@/lib/api";
import { I18nProvider, useTranslate } from "@/lib/i18n";
import { DEFAULT_GROUNDING_LIMITS } from "@/lib/types";
import type {
  Chat,
  ChatConnectedScope,
  ChatLocalKnowledgeScope,
  GroundingLimits,
} from "@/lib/types";
import { recordReadsContextRelationship } from "../../relationships/connector-relationship";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";
import { useUndoStack } from "./hooks/useUndoStack";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import type { WorkspaceUiAction, WorkspaceUndoStackApi } from "@oscharko-dev/keiko-contracts";
import { resolveWorkspaceFileIdentifier } from "@oscharko-dev/keiko-contracts";
import { applyShellUndoAction, SHELL_SHORTCUT_BINDINGS } from "./shell-undo-bindings";
import { WORKSPACE_SEARCH_FOCUS_EVENT } from "./widgets/panels/searchPanelEvents";
import { EditorPaletteHostRegistryProvider } from "./EditorPaletteHostRegistryContext";
import { WorkspaceReplaceBufferProvider } from "./WorkspaceReplaceBufferContext";
import type { EditorPaletteHost } from "./widgets/cards/editorCommands";
import {
  QUICK_ACCESS_CARD_TYPES,
  QUICK_ACCESS_TOOL_TYPES,
  buildUnifiedQuickAccessCommands,
  paletteWindowOrder,
} from "./quickAccessRegistry";
import "./widgets";
import { WIN_TYPES, type WindowType } from "./windows/WindowsRegistry";
import type { AppWindow } from "./windows/types";
import { InstallBanner } from "./install/InstallBanner";
import { registerSw } from "./install/registerSw";
import { UpdateStartupNotice } from "./update/UpdateStartupNotice";

const APP_BOOT_RECOVERY_RELOAD_KEY = "keiko.app-boot-recovery-reload-count";

function clearAppBootRecoveryReloadMarker(): void {
  try {
    window.sessionStorage.removeItem(APP_BOOT_RECOVERY_RELOAD_KEY);
  } catch {
    // Session storage can be blocked; successful mount should still proceed.
  }
}

function topWindow(wins: readonly AppWindow[] | null): AppWindow | null {
  if (wins === null || wins.length === 0) return null;
  let best: AppWindow | null = null;
  for (let i = 0; i < wins.length; i++) {
    const next = wins[i] as AppWindow;
    if (next.minimized === true) continue;
    if (best === null) {
      best = next;
      continue;
    }
    if (next.z > best.z) best = next;
  }
  return best;
}

function deriveOpenTools(wins: readonly AppWindow[] | null): ReadonlySet<string> {
  if (wins === null) return new Set<string>();
  const out = new Set<string>();
  for (const w of wins) {
    if (WIN_TYPES[w.type].tool === true) out.add(w.type);
  }
  return out;
}

function dispatchWorkspaceSearchFocus(): void {
  window.requestAnimationFrame(() => window.dispatchEvent(new Event(WORKSPACE_SEARCH_FOCUS_EVENT)));
}

export function openOrFocusSearchWindow(
  api: WorkspaceApi,
  wins: readonly AppWindow[] | null,
): void {
  const existing = wins?.find((w) => w.type === "search");
  if (existing === undefined) {
    api.toggleTool("search");
  } else if (existing.minimized === true) {
    api.restore(existing.id);
  } else {
    api.focus(existing.id);
  }
  dispatchWorkspaceSearchFocus();
}

// GEN-PERF-WORKSPACE-008 — cheap signature of exactly the window fields the
// always-mounted chrome renders: LeftRail/RightRail read the tool-membership set
// and Footer reads id/type/minimized/max/z (cfg identity is covered separately by
// useLinkRevision). `ws.wins` gets a fresh array identity on every drag/resize rAF
// frame, so keying the chrome props on it defeated their React.memo for the whole
// gesture; keying on this signature keeps their identities until a field the
// chrome actually shows changes. Exported for tests.
export function chromeWindowsSignatureOf(wins: readonly AppWindow[] | null): string {
  if (wins === null) return "";
  return wins
    .map(
      (w) =>
        `${w.id}:${w.type}:${w.minimized === true ? "1" : "0"}:${w.max ? "1" : "0"}:${String(w.z)}`,
    )
    .join("|");
}

function branchLabelOrFallback(label: string | undefined): string {
  return label !== undefined && label.trim().length > 0 ? label : "No branch selected";
}

function projectNameOrFallback(name: string | undefined, loading: boolean): string {
  // uiux-fix F039 C401 — typographic ellipsis ("…", matching the footer's "You · manual"
  // typography level) instead of three ASCII dots.
  if (loading) return "Loading project…";
  return name !== undefined && name.trim().length > 0 ? name : "No project selected";
}

function shellStatusLabel(args: {
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly hasProject: boolean;
  readonly projectAvailable: boolean;
  readonly noEligibleModels: boolean;
}): string {
  // uiux-fix F039 C401 — "Loading shell…" matches the header tab's "Loading project…" style
  // (both visible at the same moment during boot).
  if (args.loading) return "Loading shell…";
  if (args.error !== undefined) return "Shell error";
  if (!args.hasProject) return "No project selected";
  if (!args.projectAvailable) return "Project unavailable";
  if (args.noEligibleModels) return "Gateway setup required";
  return "Ready";
}

// uiux-fix F008 C043/C118 — derive the header status pill from the real session state instead of
// a hardcoded "connected" literal. Exported for unit tests.
export function headerStatus(args: {
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly hasProject: boolean;
  readonly projectAvailable: boolean;
  readonly noEligibleModels: boolean;
}): { readonly label: string; readonly tone: HeaderStatusTone } {
  if (args.loading) return { label: "Connecting", tone: "warn" };
  if (args.error !== undefined || (args.hasProject && !args.projectAvailable)) {
    return { label: "Disconnected", tone: "danger" };
  }
  if (!args.hasProject || args.noEligibleModels) return { label: "Setup required", tone: "warn" };
  return { label: "Connected", tone: "ok" };
}

function evidenceStatusLabel(wins: readonly AppWindow[] | null): string {
  const reviewWindows = (wins ?? []).filter((win) => win.type === "review");
  // uiux-fix F008 C060 — the idle label was the imperative "Open review", which reads like a
  // control but renders as static text in the footer status strip. Descriptive labels instead,
  // consistent with "No branch selected" / "No model selected".
  if (reviewWindows.length === 0) return "No review open";
  return reviewWindows.some((win) => typeof win.cfg.runId === "string" && win.cfg.runId.length > 0)
    ? "Evidence ready"
    : "Review window open";
}

function connectedScopeKey(scope: ChatConnectedScope | null): string | null {
  if (scope === null || scope.root === undefined) return null;
  return [
    scope.root.replace(/\\/gu, "/").replace(/\/+$/u, ""),
    scope.kind,
    ...scope.relativePaths.map((path) => path.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "")),
  ].join("\u0000");
}

function chatIdFromWindow(win: AppWindow | undefined): string | undefined {
  if (win?.type !== "chat") return undefined;
  const value = win.cfg["chatId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function relationshipPathForScope(scope: ChatConnectedScope): string | null {
  if (scope.root === undefined) return null;
  const relativePath = scope.relativePaths[0]?.replace(/\\/gu, "/").replace(/^\/+/u, "");
  if (relativePath === undefined || relativePath.length === 0) return scope.root;
  const root = scope.root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return `${root}/${relativePath}`;
}

// Root-relative file-identifier contract (Issue #1374). The editor-window cfg-persistence layer is
// single-sourced through @oscharko-dev/keiko-contracts, exactly like the editor open flow
// (EditorWidget / workspaceActions). A persisted cfg file id is resolved to a root-relative
// identifier under the window's `root`; an absolute-inside-root path is stripped, the root itself or
// an empty file maps to "" (no active file), and a path that cannot be relativized under the root
// (absolute-outside or a traversal escape) returns null and is DROPPED — never persisted. This
// closes the divergence where an absolute path could be written into the editor window cfg, which is
// the failure #1374 set out to prevent. Cfg persistence intentionally keeps the window's root rather
// than re-anchoring it, so `resolveWorkspaceFileIdentifier` is used here, not `selectWorkspaceFileTarget`.
function editorCfgRelativePath(root: string, file: string): string | null {
  // Filesystem-root ("/") workspace edge: every absolute path is "under" it, so strip the leading
  // slash. The contract folds a "/" root to empty/outside-root, so this one intentional, tested case
  // (a whole-disk editor root) is handled locally. `^\/+$` is anchored at both ends — linear.
  if (/^\/+$/u.test(root.trim().replace(/\\/gu, "/"))) {
    const comparableFile = file.trim().replace(/\\/gu, "/");
    return comparableFile.length === 0 ? "" : comparableFile.replace(/^\/+/u, "");
  }
  const resolution = resolveWorkspaceFileIdentifier(root, file);
  if (resolution.kind === "relative") return resolution.path;
  if (resolution.kind === "root" || resolution.kind === "empty") return "";
  return null;
}

function normalizeEditorOpenFiles(
  root: string,
  openFiles: unknown,
  activeFile: string,
): readonly string[] {
  const out: string[] = [];
  const add = (path: string): void => {
    const relative = editorCfgRelativePath(root, path);
    if (relative === null || relative.length === 0 || out.includes(relative)) return;
    out.push(relative);
  };
  if (Array.isArray(openFiles)) {
    for (const item of openFiles) {
      if (typeof item === "string") add(item);
    }
  }
  if (activeFile.length > 0) add(activeFile);
  return out;
}

export function normalizeEditorWindowCfg(cfg: Cfg): Cfg {
  const root = typeof cfg.root === "string" ? cfg.root.trim() : "";
  const file = typeof cfg.file === "string" ? cfg.file.trim() : "";
  if (root.length === 0) return cfg;
  const relativeFile = editorCfgRelativePath(root, file);
  const next: Cfg = { ...cfg, root };
  const normalizedOpenFiles = normalizeEditorOpenFiles(root, cfg.openFiles, relativeFile ?? "");
  // A non-relativizable file id (absolute-outside or escaping) is dropped, never persisted (#1374).
  if (relativeFile !== null && relativeFile.length > 0) {
    next.file = relativeFile;
  } else {
    delete next.file;
  }
  if (normalizedOpenFiles.length > 0) {
    next.openFiles = normalizedOpenFiles;
  } else {
    delete next.openFiles;
  }
  return next;
}

const CARD_TYPES: readonly WindowType[] = QUICK_ACCESS_CARD_TYPES;
const TOOL_TYPES: readonly WindowType[] = QUICK_ACCESS_TOOL_TYPES;

export function opensDirectlyFromPalette(type: WindowType): boolean {
  // The documentation browser opens straight into its working surface (empty location input); it has
  // no required pre-creation config, so it skips the New Window dialog like the connector.
  return type === "connector" || type === "docbrowser";
}

function focusCreatedWindow(id: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
    if (el === null) return;
    const target =
      el.querySelector<HTMLElement>("textarea, input, select, button, [tabindex]") ?? el;
    target.focus();
  });
}

export function buildAppShellCommands(
  api: WorkspaceApi,
  toggleTool: (type: WindowType) => void,
  openPalettePick: (type: WindowType) => void,
  theme: "light" | "dark",
  toggleTheme: () => void,
  undoStack: WorkspaceUndoStackApi,
): readonly Command[] {
  const out: Command[] = [];
  for (const tp of CARD_TYPES) {
    const t = WIN_TYPES[tp];
    out.push({
      id: `new-${tp}`,
      label: `New ${t.title}`,
      group: "Create",
      icon: t.icon,
      run: () => openPalettePick(tp),
    });
  }
  for (const tp of TOOL_TYPES) {
    const t = WIN_TYPES[tp];
    out.push({
      id: `open-${tp}`,
      label: `Open ${t.title}`,
      group: "Tools",
      icon: t.icon,
      run: () => toggleTool(tp),
    });
  }
  out.push({
    id: "tile",
    label: "Tile all windows",
    group: "Layout",
    icon: "tile",
    run: api.tileAll,
  });
  out.push({
    id: "split",
    label: "Split front windows",
    group: "Layout",
    icon: "split",
    run: api.splitFront,
  });
  out.push({
    id: "cascade",
    label: "Cascade windows",
    group: "Layout",
    icon: "cascade",
    run: api.cascade,
  });
  out.push({
    id: "theme",
    label: "Toggle light / dark theme",
    group: "View",
    icon: theme === "light" ? "moon" : "sun",
    run: toggleTheme,
  });
  out.push({
    id: "undo",
    label:
      undoStack.undoLabel !== null
        ? `Undo: ${undoStack.undoLabel}`
        : "Undo (window and panel changes only)",
    group: "Edit",
    icon: "back",
    shortcut: "⌘Z",
    run: undoStack.undo,
  });
  out.push({
    id: "redo",
    label:
      undoStack.redoLabel !== null
        ? `Redo: ${undoStack.redoLabel}`
        : "Redo (window and panel changes only)",
    group: "Edit",
    icon: "fwd",
    shortcut: "⇧⌘Z",
    run: undoStack.redo,
  });
  return out;
}

function AppShellInner(): ReactNode {
  const t = useTranslate();
  const { theme, toggle: toggleTheme } = useTheme();
  const twin = useTwin();
  const session = useChatSession({ autoCreate: false });
  // Issue #446 (ADR-0090) — the active task-workspace binding state machine. It is provided to the
  // whole shell so the Header switcher and every window's render context read one source of truth.
  const activeWorkspace = useActiveWorkspaceState();
  const wsRef = useRef<HTMLDivElement>(null);
  const wsWinsForBindingRef = useRef<readonly AppWindow[] | null>(null);
  // Operator-configurable grounding caps — fetched once on mount, fall back to compile-time
  // defaults until /api/config resolves (or if an older server omits effectiveGroundingLimits).
  const [groundingLimits, setGroundingLimits] = useState<GroundingLimits>(DEFAULT_GROUNDING_LIMITS);
  useEffect(() => {
    fetchConfig()
      .then((res) => setGroundingLimits(res.effectiveGroundingLimits))
      .catch(() => undefined);
  }, []);
  // Issue #446 — load the task-workspace inventory + active binding for the launched project, and
  // re-list whenever the active project changes. Best-effort: a server without the binding routes
  // degrades to an empty inventory and an unbound state (the switcher then shows "no active workspace").
  const refreshActiveWorkspace = activeWorkspace.refresh;
  const activeProjectPath = session.activeProject?.path;
  useEffect(() => {
    void refreshActiveWorkspace(activeProjectPath);
  }, [refreshActiveWorkspace, activeProjectPath]);
  // Release 0.2.0 — user-visible feedback when a connect gesture is rejected because the
  // per-chat source limit is reached. Cleared on the next accepted bind and auto-dismissed.
  const [sourceConnectionNotice, setSourceConnectionNotice] = useState<string | null>(null);
  useEffect(() => {
    if (sourceConnectionNotice === null) return undefined;
    const timer = window.setTimeout(() => setSourceConnectionNotice(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [sourceConnectionNotice]);
  const rejectForLimit = useCallback((connectedCount: number, cap: number): false => {
    setSourceConnectionNotice(
      `Source limit reached — this chat already has ${String(connectedCount)} of ${String(cap)} connected sources. Disconnect a source before connecting another.`,
    );
    return false;
  }, []);
  const rejectForConnectionFailure = useCallback((message: string): false => {
    setSourceConnectionNotice(message);
    return false;
  }, []);
  const chatForWindow = useCallback(
    (chatWindowId: string): Chat | undefined => {
      const chatId = chatIdFromWindow(
        wsWinsForBindingRef.current?.find((win) => win.id === chatWindowId),
      );
      if (chatId === undefined) return undefined;
      const chat =
        session.chats.find((chat) => chat.id === chatId) ??
        (session.activeChat?.id === chatId ? session.activeChat : undefined);
      return chat?.status === "closed" ? undefined : chat;
    },
    [session.activeChat, session.chats],
  );
  // Files↔Chat edges bind the Files window's visible scope: repository root, opened folder, or
  // previewed file. The green edge is now the only UI affordance for this binding.
  // Release 0.2.0 — returns whether the bind was accepted: at the source limit the bind is
  // REJECTED (with a visible notice) instead of silently evicting the oldest source, and the
  // caller skips drawing the edge so no dangling ungrounded edge appears.
  const replaceFilesScope = useCallback(
    async (
      chatWindowId: string,
      nextScope: ChatConnectedScope,
      previousScope: ChatConnectedScope | null = null,
    ): Promise<boolean> => {
      const chat = chatForWindow(chatWindowId);
      if (chat === undefined) {
        return rejectForConnectionFailure("Open a ready chat window before connecting a source.");
      }
      const current =
        previousScope === null
          ? effectiveScopes(chat)
          : removeConnectedScope(effectiveScopes(chat), previousScope);
      const lkScopes = effectiveLocalKnowledgeScopes(chat);
      if (isScopeConnected(current, nextScope)) {
        if (previousScope !== null) {
          const res = await updateChatConnectedScopes(chat.id, current.length > 0 ? current : null);
          session.replaceChat(res.chat);
        }
        return true;
      }
      const cap = totalSourceCap(groundingLimits);
      if (current.length + lkScopes.length >= cap) {
        return rejectForLimit(current.length + lkScopes.length, cap);
      }
      const scope = { ...nextScope, connectedAtMs: Date.now() };
      const next = appendConnectedScope(current, scope, groundingLimits.maxConnectedSources);
      if (next === null) {
        return rejectForConnectionFailure("Choose a local folder before connecting it to chat.");
      }
      if (next === current) {
        return rejectForLimit(current.length + lkScopes.length, cap);
      }
      try {
        const res = await updateChatConnectedScopes(chat.id, next);
        session.replaceChat(res.chat);
        setSourceConnectionNotice(null);
        // Epic #532 unification — also record the green edge as a governed reads-context
        // relationship so the connection is validated, audited, and visible in the relationship
        // graph. Best-effort: never blocks or breaks the grounding scope bind above.
        const relationshipPath = relationshipPathForScope(scope);
        if (relationshipPath !== null) recordReadsContextRelationship(chat.id, relationshipPath);
        return true;
      } catch {
        return rejectForConnectionFailure(
          "Keiko could not connect that source. Check that it is still available and try again.",
        );
      }
    },
    // GEN-PERF-RENDER-001 — depend on the stable `session.replaceChat` useCallback (the only member
    // these scope callbacks touch) instead of the whole `session` object, whose identity changes on
    // every session state change (draft/streaming/etc). useWorkspace rebinds `api` when these opts
    // callbacks change, so narrowing here stops per-keystroke api churn from reaching the workspace.
    // GEN-PERF-RENDER-001: intentionally depend on the stable session.replaceChat member rather than
    // the whole session object (see comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      chatForWindow,
      session.replaceChat,
      groundingLimits,
      rejectForLimit,
      rejectForConnectionFailure,
    ],
  );
  const handleScopeBind = useCallback(
    async (chatWindowId: string, scope: ChatConnectedScope): Promise<boolean> =>
      replaceFilesScope(chatWindowId, scope),
    [replaceFilesScope],
  );
  const handleScopeUnbind = useCallback(
    (chatWindowId: string, scope: ChatConnectedScope): void => {
      const chat = chatForWindow(chatWindowId);
      if (chat === undefined) return;
      const next = removeConnectedScope(effectiveScopes(chat), scope);
      void updateChatConnectedScopes(chat.id, next.length > 0 ? next : null)
        .then((res) => {
          session.replaceChat(res.chat);
        })
        .catch((error: unknown) => {
          // uiux-fix F008 C074 — a failed unbind silently left the chat grounded after edge removal.
          console.warn("[keiko] connected-scope unbind failed", error);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- GEN-PERF-RENDER-001 stable-member narrowing
    [chatForWindow, session.replaceChat],
  );
  // Epic #189 Slice 3 M3 — a Connector↔Chat relationship edge binds/unbinds the connector scope
  // on the active chat's localKnowledgeScopes, so the gesture grounds the chat via vector search.
  // Release 0.2.0 — same accepted/veto contract as handleScopeBind: at the source limit the
  // bind is rejected with a visible notice instead of silently evicting the oldest source.
  const handleConnectorBind = useCallback(
    async (chatWindowId: string, scope: ChatLocalKnowledgeScope): Promise<boolean> => {
      const chat = chatForWindow(chatWindowId);
      if (chat === undefined) {
        return rejectForConnectionFailure("Open a ready chat window before connecting a source.");
      }
      const current = effectiveLocalKnowledgeScopes(chat);
      const folderScopes = effectiveScopes(chat);
      if (isConnectorScopeConnected(current, scope)) return true;
      const cap = totalSourceCap(groundingLimits);
      if (folderScopes.length + current.length >= cap) {
        return rejectForLimit(folderScopes.length + current.length, cap);
      }
      const next = appendConnectorScope(current, scope, groundingLimits.maxLocalKnowledgeSources);
      if (next === current) {
        // Not a duplicate (checked above) → the per-list connector cap rejected the append.
        return rejectForLimit(folderScopes.length + current.length, cap);
      }
      try {
        const res = await updateChatLocalKnowledgeScopes(chat.id, next);
        session.replaceChat(res.chat);
        setSourceConnectionNotice(null);
        return true;
      } catch {
        return rejectForConnectionFailure(
          "Keiko could not connect that knowledge source. Check that it is still available and try again.",
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- GEN-PERF-RENDER-001 stable-member narrowing
    [
      chatForWindow,
      session.replaceChat,
      groundingLimits,
      rejectForLimit,
      rejectForConnectionFailure,
    ],
  );
  const handleConnectorUnbind = useCallback(
    (chatWindowId: string, scope: ChatLocalKnowledgeScope): void => {
      const chat = chatForWindow(chatWindowId);
      if (chat === undefined) return;
      const key =
        scope.kind === "capsule" ? `capsule:${scope.capsuleId}` : `set:${scope.capsuleSetId}`;
      const next = removeConnectorScope(effectiveLocalKnowledgeScopes(chat), key);
      void updateChatLocalKnowledgeScopes(chat.id, next.length > 0 ? next : null)
        .then((res) => {
          session.replaceChat(res.chat);
        })
        .catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- GEN-PERF-RENDER-001 stable-member narrowing
    [chatForWindow, session.replaceChat],
  );
  const [cameraSmoothness, setCameraSmoothness] = useState<number>(readWorkspaceCameraSmoothness);

  useEffect(() => {
    const onCameraSmoothness = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      setCameraSmoothness(typeof detail === "number" ? detail : 0);
    };
    window.addEventListener(WORKSPACE_CAMERA_SMOOTHNESS_EVENT, onCameraSmoothness);
    return () => {
      window.removeEventListener(WORKSPACE_CAMERA_SMOOTHNESS_EVENT, onCameraSmoothness);
    };
  }, []);

  const ws = useWorkspace(wsRef, {
    cameraSmoothness,
    onScopeBind: handleScopeBind,
    onScopeUnbind: handleScopeUnbind,
    onConnectorBind: handleConnectorBind,
    onConnectorUnbind: handleConnectorUnbind,
  });
  wsWinsForBindingRef.current = ws.wins;

  // GEN-PERF-WORKSPACE-007 — this rebind scan only depends on the connection set
  // and each endpoint window's type/cfg (filesChatBindScope derives from cfg paths,
  // never geometry), yet keying it on ws.wins/winsById re-ran the O(conns) scan on
  // every drag/resize rAF frame (wins identity churns per geometry commit). Key it
  // on the same linkRevision the WindowFrame memo contract uses: it bumps exactly
  // when conns, the window set, or any window's cfg identity change.
  const workspaceLinkRevision = useLinkRevision(ws.wins, ws.conns);
  useEffect(() => {
    if (ws.wins === null) return;
    for (const conn of ws.conns) {
      const a = ws.winsById.get(conn.a);
      const b = ws.winsById.get(conn.b);
      if (a === undefined || b === undefined) continue;
      const chatWindowId =
        conn.boundChatWindowId ?? (a.type === "chat" ? a.id : b.type === "chat" ? b.id : null);
      if (chatWindowId === null) continue;
      const nextScope = filesChatBindScope(a, b, Date.now());
      if (nextScope === null) continue;
      const previousScope = boundScopeOf(conn);
      if (connectedScopeKey(previousScope) === connectedScopeKey(nextScope)) continue;
      void replaceFilesScope(chatWindowId, nextScope, previousScope).then((accepted) => {
        if (accepted) ws.api.updateConnBoundScope(conn.id, nextScope);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspaceLinkRevision is the cfg/conn-change signal; ws.wins/winsById/conns are read fresh when it bumps (geometry-only frames must not re-run the scan)
  }, [replaceFilesScope, ws.api, workspaceLinkRevision]);

  const [palOpen, setPalOpen] = useState(false);
  const [pending, setPending] = useState<WindowType | null>(null);
  const [quickAccessMode, setQuickAccessMode] = useState<"files" | "commands" | null>(null);
  const [windowPaletteOpen, setWindowPaletteOpen] = useState(false);
  const [editorHosts, setEditorHosts] = useState<ReadonlyMap<string, EditorPaletteHost>>(
    () => new Map(),
  );

  const winCount = ws.wins?.length ?? 0;
  const active = topWindow(ws.wins);
  // GEN-PERF-WORKSPACE-008 — keep the chrome props referentially stable across
  // geometry-only frames (see chromeWindowsSignatureOf): a fresh Set/array per
  // drag frame defeated the LeftRail/RightRail/Footer memos for whole gestures.
  const chromeWindowsSignature = useMemo(() => chromeWindowsSignatureOf(ws.wins), [ws.wins]);
  const openTools = useMemo(
    () => deriveOpenTools(ws.wins),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chromeWindowsSignature covers the type membership deriveOpenTools reads; geometry-only frames must keep the Set identity
    [chromeWindowsSignature],
  );
  const footerWindows = useMemo(
    () => ws.wins ?? [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature covers id/type/minimized/max/z and workspaceLinkRevision covers cfg — every field Footer renders; geometry-only frames must keep the array identity
    [chromeWindowsSignature, workspaceLinkRevision],
  );
  const wsContextValue: WsContextValue = useMemo(() => ({ active, winCount }), [active, winCount]);
  // GEN-PERF-RENDER-002 — Header is memoized, but passing a freshly-constructed <TaskWorkspaceSwitcher/>
  // element inline defeated that memo (new element identity every AppShell render). Memoizing the
  // element keeps Header's props referentially stable so it only re-renders on real input changes.
  const contextControl = useMemo(() => <TaskWorkspaceSwitcher />, []);

  const openPalette = useCallback((): void => setPalOpen(true), []);
  const closePalette = useCallback((): void => setPalOpen(false), []);
  const openQuickAccessFiles = useCallback((): void => setQuickAccessMode("files"), []);
  const openQuickAccessCommands = useCallback((): void => setQuickAccessMode("commands"), []);
  const closeQuickAccess = useCallback((): void => setQuickAccessMode(null), []);
  const registerEditorHost = useCallback(
    (windowId: string, host: EditorPaletteHost): (() => void) => {
      setEditorHosts((current) => {
        const next = new Map(current);
        next.set(windowId, host);
        return next;
      });
      return () => {
        setEditorHosts((current) => {
          const next = new Map(current);
          next.delete(windowId);
          return next;
        });
      };
    },
    [],
  );
  const toggleWindowPalette = useCallback((): void => setWindowPaletteOpen((open) => !open), []);
  const closeWindowPalette = useCallback((): void => setWindowPaletteOpen(false), []);
  const selectFooterWindow = useCallback(
    (id: string): void => {
      ws.api.restore(id);
      setWindowPaletteOpen(false);
    },
    [ws.api],
  );
  const pick = useCallback(
    (type: WindowType): void => {
      setPalOpen(false);
      if (opensDirectlyFromPalette(type)) {
        const createdId = ws.api.add(type);
        if (createdId !== null) focusCreatedWindow(createdId);
        return;
      }
      setPending(type);
    },
    [ws.api],
  );
  const confirmNew = useCallback(
    (cfg: Cfg): void => {
      // Side effects live outside the setPending updater: StrictMode double-invokes updater
      // functions in dev, which would duplicate every window (and chat) created in here. The
      // dialog only renders while `pending` is non-null, so reading it from the closure is safe.
      const current = pending;
      setPending(null);
      if (current === null) return;
      const normalizedCfg = current === "editor" ? normalizeEditorWindowCfg(cfg) : cfg;
      const { __connectFilesId, ...windowCfg } = normalizedCfg;
      const createdId = ws.api.add(current, windowCfg);
      if (
        current === "agents" &&
        createdId !== null &&
        typeof __connectFilesId === "string" &&
        __connectFilesId.length > 0
      ) {
        ws.api.connect(createdId, __connectFilesId);
      }
      // Chat windows create and persist their own conversation id inside the window renderer.
      // Keeping creation scoped there is what makes N+1 chat windows independent.
      // uiux-fix F008 C053 — focus handoff: once the dialog unmounts, move focus into the freshly
      // created window (chat composer / first focusable control) instead of stranding it on
      // <body>. The dialog's unmount cleanup restores the trigger synchronously before this rAF
      // runs, so the handoff wins.
      if (createdId !== null) {
        focusCreatedWindow(createdId);
      }
    },
    [pending, ws.api],
  );
  const closeDialog = useCallback((): void => setPending(null), []);
  const statusRef = useRef<HTMLElement | null>(null);
  const setStatusRef = useCallback((node: HTMLElement | null): void => {
    statusRef.current = node;
  }, []);

  // Epic #518 / ADR-0028 — undo stack wired at the shell. The apply
  // dispatcher lives in shell-undo-bindings.ts so the integration is
  // unit-testable without mounting the whole AppShell tree.
  const applyUndoAction = useCallback(
    (action: WorkspaceUiAction): void => applyShellUndoAction(ws.api, action),
    [ws.api],
  );
  const undoStack = useUndoStack({ apply: applyUndoAction });

  const onTool = useCallback(
    (id: string): void => {
      if (!(id in WIN_TYPES)) return;
      const panel = id as WindowType;
      const before = openTools.has(panel);
      ws.api.toggleTool(panel);
      undoStack.push({
        kind: "ui.panel.toggle",
        panel,
        before,
        after: !before,
      });
    },
    [ws.api, openTools, undoStack],
  );

  const onNewChat = useCallback((): void => pick("chat"), [pick]);

  // uiux-fix F008 C220 — some tool surfaces used to be full pages. Once the workspace is hydrated,
  // open their singleton window via the existing tool seam (idempotent: only when not already open)
  // and normalize the URL back to "/".
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || ws.wins === null) return;
    deepLinkHandled.current = true;
    const path = window.location.pathname.replace(/\/+$/u, "");
    const deepLinkTool =
      path === "/relationships"
        ? "relationships"
        : path === "/local-knowledge"
          ? "localKnowledge"
          : null;
    if (deepLinkTool === null) return;
    if (!ws.wins.some((w) => w.type === deepLinkTool)) onTool(deepLinkTool);
    window.history.replaceState(null, "", "/");
  }, [ws.wins, onTool]);

  // Epic #518 / ADR-0028 — shell chords route through useKeyboardShortcuts so conflict detection
  // and editable-target guards apply to the unified quick-access surface.
  const dispatchShortcut = useCallback(
    (commandId: string): void => {
      if (commandId === "undo") undoStack.undo();
      else if (commandId === "redo") undoStack.redo();
      else if (commandId === "focus-status") statusRef.current?.focus();
      else if (commandId === "focus-workspace-search") openOrFocusSearchWindow(ws.api, ws.wins);
      else if (commandId === "quick-access.files") openQuickAccessFiles();
      else if (commandId === "quick-access.commands") openQuickAccessCommands();
    },
    [openQuickAccessCommands, openQuickAccessFiles, undoStack, ws.api, ws.wins],
  );
  useKeyboardShortcuts({ bindings: SHELL_SHORTCUT_BINDINGS, dispatch: dispatchShortcut });

  useEffect(() => {
    const root = document.documentElement;
    const setPointerModality = (): void => {
      root.setAttribute("data-input-modality", "pointer");
    };
    const setKeyboardModality = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "Tab") return;
      root.setAttribute("data-input-modality", "keyboard");
    };

    root.setAttribute("data-input-modality", "pointer");
    window.addEventListener("pointerdown", setPointerModality, true);
    window.addEventListener("mousedown", setPointerModality, true);
    window.addEventListener("keydown", setKeyboardModality, true);
    return () => {
      window.removeEventListener("pointerdown", setPointerModality, true);
      window.removeEventListener("mousedown", setPointerModality, true);
      window.removeEventListener("keydown", setKeyboardModality, true);
      root.removeAttribute("data-input-modality");
    };
  }, []);

  const commands = useMemo(
    () => buildAppShellCommands(ws.api, onTool, pick, theme, toggleTheme, undoStack),
    [ws.api, onTool, pick, theme, toggleTheme, undoStack],
  );
  const activeEditorHost =
    active?.type === "editor" && active.id.length > 0 ? (editorHosts.get(active.id) ?? null) : null;
  const quickAccessCommands = useMemo(
    () => buildUnifiedQuickAccessCommands(commands, activeEditorHost),
    [activeEditorHost, commands],
  );
  const quickAccessRoot = activeWorkspace.activeRoot ?? session.activeProject?.path ?? undefined;
  const needsGatewaySetup =
    !session.loading && session.error === undefined && session.models.length === 0;
  const projectName = projectNameOrFallback(session.activeProject?.name, session.loading);
  const hasProject = session.activeProject !== undefined;
  const projectAvailable = session.activeProject?.available === true;
  const footerShellStatusLabel = shellStatusLabel({
    loading: session.loading,
    error: session.error,
    hasProject,
    projectAvailable,
    noEligibleModels: session.noEligibleModels,
  });
  const footerEvidenceStatusLabel = evidenceStatusLabel(ws.wins);
  const branchLabel = branchLabelOrFallback(session.activeChat?.branchLabel);
  const updateStartupReady = ws.wins !== null && !session.loading && !needsGatewaySetup;
  const openUpdatesFromStartup = useCallback((): void => {
    const createdId = ws.api.add("updates", { entrypoint: "startup" });
    if (createdId !== null) focusCreatedWindow(createdId);
  }, [ws.api]);

  const paletteNode = palOpen ? (
    <Palette types={WIN_TYPES} order={paletteWindowOrder()} onAdd={pick} onClose={closePalette} />
  ) : null;

  // GEN-UI-A11Y-003 — while a genuinely modal dialog is open, take the background window layer out of
  // the accessibility tree and the tab order. These dialogs (NewWindowDialog / CommandPalette /
  // GatewaySetupDialog) are each aria-modal and render as later siblings OUTSIDE `.stage`, so inerting
  // `.stage` leaves them fully operable while nothing behind them can be tabbed to or read by AT. The
  // non-modal `Palette` (palOpen) deliberately does NOT count here: it renders INSIDE `.stage` and is
  // designed to keep the workspace behind it interactive, so inerting on `palOpen` would disable the
  // Palette itself. `inert` implies aria-hidden in modern engines; the explicit aria-hidden is a
  // fallback for older assistive tech that has not yet adopted inert.
  const modalOpen = pending !== null || quickAccessMode !== null || needsGatewaySetup;
  // GEN-UI-A11Y-003 — React 18's DOM renderer does not whitelist `inert`, so a JSX `inert` prop is
  // dropped (with a warning). Toggle the attribute imperatively on the `.stage` element instead: set
  // it while a modal dialog is open, remove it otherwise. `aria-hidden` is a normal, typed JSX prop
  // that pairs with `inert` for older assistive tech that has not yet adopted inert.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    if (modalOpen) stage.setAttribute("inert", "");
    else stage.removeAttribute("inert");
  }, [modalOpen]);

  return (
    <ActiveWorkspaceProvider value={activeWorkspace}>
      <ChatSessionProvider value={session}>
        <EditorPaletteHostRegistryProvider register={registerEditorHost}>
          <WorkspaceReplaceBufferProvider>
            <WsContext.Provider value={wsContextValue}>
              {/* GEN-UI-A11Y-004 — one always-mounted app-level live-region pair. The AnnouncerProvider
            renders its role="status"/role="alert" regions as siblings of `.app`, OUTSIDE the window
            layer, so they never unmount and any surface can post an outcome via useAnnouncer(). */}
              <AnnouncerProvider>
                <div className="app">
                  {/* WCAG 2.4.1 — bypass blocks: the first focusable element jumps keyboard
              users past the header/rail straight to the workspace (design/accessibility.html §04). */}
                  <a className="skip-link" href="#main">
                    {t("app.skipToContent")}
                  </a>
                  {/* WCAG 2.4.6 — visually-hidden page heading for screen readers */}
                  <h1 className="visually-hidden">{t("app.workspaceHeading")}</h1>
                  <Header
                    openPalette={openPalette}
                    openCommandPalette={openQuickAccessFiles}
                    onTileAll={ws.api.tileAll}
                    onSplitFront={ws.api.splitFront}
                    onCascade={ws.api.cascade}
                    contextControl={contextControl}
                  />
                  <div className="mid">
                    {needsGatewaySetup ? null : (
                      <LeftRail
                        openTools={openTools}
                        onTool={onTool}
                        onNewChat={onNewChat}
                        theme={theme}
                        onToggleTheme={toggleTheme}
                      />
                    )}
                    <div
                      ref={stageRef}
                      className="stage"
                      id="main"
                      tabIndex={-1}
                      // GEN-UI-A11Y-003 — `inert` is toggled imperatively via stageRef (see effect above);
                      // aria-hidden pairs with it for older AT while a modal dialog is open.
                      aria-hidden={modalOpen ? true : undefined}
                    >
                      <Workspace
                        ws={ws}
                        wsRef={wsRef}
                        openPalette={openPalette}
                        palette={paletteNode}
                      >
                        <UpdateStartupNotice
                          ready={updateStartupReady}
                          openUpdates={openUpdatesFromStartup}
                        />
                      </Workspace>
                      {/* Release 0.2.0 — rejected connect gesture (source limit reached). Mirrors the
                  AttachmentStrip rejection-alert pattern: local state + role="alert", inline. */}
                      {sourceConnectionNotice !== null && (
                        <div className="source-limit-alert" role="alert">
                          <span>{sourceConnectionNotice}</span>
                          <button
                            type="button"
                            className="source-limit-alert-dismiss"
                            aria-label="Dismiss source connection notice"
                            onClick={() => setSourceConnectionNotice(null)}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                    {needsGatewaySetup ? null : <RightRail openTools={openTools} onTool={onTool} />}
                  </div>
                  <Footer
                    winCount={winCount}
                    windows={footerWindows}
                    windowPaletteOpen={windowPaletteOpen}
                    onToggleWindowPalette={toggleWindowPalette}
                    onSelectWindow={selectFooterWindow}
                    onCloseWindowPalette={closeWindowPalette}
                    mode={twin.mode}
                    selectedModel={session.selectedModel}
                    projectName={projectName}
                    branchLabel={branchLabel}
                    shellStatusLabel={footerShellStatusLabel}
                    evidenceStatusLabel={footerEvidenceStatusLabel}
                    statusRef={setStatusRef}
                  />

                  {pending !== null && (
                    <NewWindowDialog
                      type={pending}
                      types={WIN_TYPES}
                      filesContext={ws.api.currentFilesContext()}
                      onConfirm={confirmNew}
                      onClose={closeDialog}
                    />
                  )}
                  {quickAccessMode !== null ? (
                    <UnifiedQuickAccessPalette
                      initialMode={quickAccessMode}
                      root={quickAccessRoot}
                      commands={quickAccessCommands}
                      openEditorFile={ws.api.openEditorFile}
                      onClose={closeQuickAccess}
                    />
                  ) : null}
                  {needsGatewaySetup ? <GatewaySetupDialog /> : null}
                  <InstallBanner />
                </div>
              </AnnouncerProvider>
            </WsContext.Provider>
          </WorkspaceReplaceBufferProvider>
        </EditorPaletteHostRegistryProvider>
      </ChatSessionProvider>
    </ActiveWorkspaceProvider>
  );
}

export function AppShell(): ReactNode {
  // Mount gate: the entire shell depends on client-only state (localStorage-backed
  // theme/twin/editor, the WebGL canvas, window dimensions). Under static export the
  // build-time prerender has none of that, so rendering the shell during hydration
  // mismatches the client and trips React #418. Gating on a post-mount flag makes the
  // server prerender and the client's first render byte-identical (an empty .app), then
  // swaps in the live shell after mount — eliminating every hydration mismatch at once.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    clearAppBootRecoveryReloadMarker();
    setMounted(true);
  }, []);
  // Register the PWA service worker exactly once per client mount (issue #126, ADR-0024 D6).
  // Sitting in the outer mount component means we register on first client render and never
  // again across the inner shell's remount cycle. `registerSw` is a silent no-op on SSR /
  // unsupported browsers / failure, so this effect cannot break the app.
  useEffect(() => {
    registerSw();
  }, []);
  // GEN-STAB-WINDOW-002 — surface (bounded) unhandled promise rejections; the shell had
  // no listener, so escaped async failures degraded long sessions with zero signal.
  useUnhandledRejectionLog();
  // uiux-fix F039 C402 — the gate used to be a completely empty .app: from first paint until
  // hydration finished the user saw a bare surface colour with zero loading feedback. A pure-CSS
  // placeholder (pulsing logo, reduced-motion-safe) gives that feedback. The hydration guarantee
  // is untouched: the placeholder is static markup, so the build-time prerender and the client's
  // first render stay byte-identical.
  if (!mounted) {
    return (
      <div className="app" aria-hidden="true">
        <div className="app-boot">
          {/* eslint-disable-next-line @next/next/no-img-element -- design CSS sizes the raw SVG; next/image would inject a wrapper that breaks the centered placeholder */}
          <img className="app-boot-logo" src="/assets/keiko-logo.svg" alt="" />
        </div>
      </div>
    );
  }
  return (
    <I18nProvider>
      <TwinProvider>
        <AppShellInner />
      </TwinProvider>
    </I18nProvider>
  );
}
