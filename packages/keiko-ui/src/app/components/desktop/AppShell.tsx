"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { TwinProvider, useTwin } from "./context/TwinContext";
import { WsContext, type WsContextValue } from "./context/WsContext";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { LeftRail } from "./LeftRail";
import { RightRail } from "./RightRail";
import { Workspace } from "./Workspace";
import { CommandPalette, type Command } from "./modals/CommandPalette";
import { GatewaySetupDialog } from "./modals/GatewaySetupDialog";
import { NewWindowDialog } from "./modals/NewWindowDialog";
import { Palette } from "./modals/Palette";
import { type Cfg } from "./modals/PermControl";
import { useChatSession } from "./hooks/useChatSession";
import { useTheme } from "./hooks/useTheme";
import { useWorkspace } from "./hooks/useWorkspace";
import type { WorkspaceApi } from "./hooks/useWorkspace.types";
import { useUndoStack } from "./hooks/useUndoStack";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import type { WorkspaceUiAction, WorkspaceUndoStackApi } from "@oscharko-dev/keiko-contracts";
import { applyShellUndoAction, SHELL_SHORTCUT_BINDINGS } from "./shell-undo-bindings";
import "./widgets";
import { WIN_TYPES, type WindowType } from "./windows/WindowsRegistry";
import type { AppWindow } from "./windows/types";
import { InstallBanner } from "./install/InstallBanner";
import { registerSw } from "./install/registerSw";

function topWindow(wins: readonly AppWindow[] | null): AppWindow | null {
  if (wins === null || wins.length === 0) return null;
  let best = wins[0] as AppWindow;
  for (let i = 1; i < wins.length; i++) {
    const next = wins[i] as AppWindow;
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

function branchLabelOrFallback(label: string | undefined): string {
  return label !== undefined && label.trim().length > 0 ? label : "No branch selected";
}

function projectNameOrFallback(name: string | undefined, loading: boolean): string {
  if (loading) return "Loading project...";
  return name !== undefined && name.trim().length > 0 ? name : "No project selected";
}

function shellStatusLabel(args: {
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly hasProject: boolean;
  readonly projectAvailable: boolean;
  readonly noEligibleModels: boolean;
}): string {
  if (args.loading) return "Loading shell";
  if (args.error !== undefined) return "Shell error";
  if (!args.hasProject) return "No project selected";
  if (!args.projectAvailable) return "Project unavailable";
  if (args.noEligibleModels) return "Gateway setup required";
  return "Ready";
}

function evidenceStatusLabel(wins: readonly AppWindow[] | null): string {
  const reviewWindows = (wins ?? []).filter((win) => win.type === "review");
  if (reviewWindows.length === 0) return "Open review";
  return reviewWindows.some((win) => typeof win.cfg.runId === "string" && win.cfg.runId.length > 0)
    ? "Evidence ready"
    : "Review open";
}

const CARD_TYPES: readonly WindowType[] = [
  "chat",
  "files",
  "editor",
  "browser",
  "terminal",
  "review",
  "agents",
  "integ",
];
const TOOL_TYPES: readonly WindowType[] = [
  "project",
  "search",
  "plugins",
  "automations",
  "mobile",
  "inspector",
  "activity",
  "notifications",
  "resources",
];

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
    run: undoStack.redo,
  });
  return out;
}

function AppShellInner(): ReactNode {
  const { theme, toggle: toggleTheme } = useTheme();
  const twin = useTwin();
  const session = useChatSession();
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef);

  const [palOpen, setPalOpen] = useState(false);
  const [pending, setPending] = useState<WindowType | null>(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);

  const winCount = ws.wins?.length ?? 0;
  const active = topWindow(ws.wins);
  const openTools = useMemo(() => deriveOpenTools(ws.wins), [ws.wins]);
  const wsContextValue: WsContextValue = useMemo(
    () => ({ wins: ws.wins ?? [], active, winCount }),
    [ws.wins, active, winCount],
  );

  const openPalette = useCallback((): void => setPalOpen(true), []);
  const closePalette = useCallback((): void => setPalOpen(false), []);
  const pick = useCallback((type: WindowType): void => {
    setPalOpen(false);
    setPending(type);
  }, []);
  const confirmNew = useCallback(
    (cfg: Cfg): void => {
      setPending((current) => {
        if (current !== null) {
          const { __connectFilesId, ...windowCfg } = cfg;
          const createdId = ws.api.add(current, windowCfg);
          if (
            current === "agents" &&
            createdId !== null &&
            typeof __connectFilesId === "string" &&
            __connectFilesId.length > 0
          ) {
            ws.api.connect(createdId, __connectFilesId);
          }
        }
        return null;
      });
    },
    [ws.api],
  );
  const closeDialog = useCallback((): void => setPending(null), []);
  const closeCmdk = useCallback((): void => setCmdkOpen(false), []);
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

  // Epic #518 / ADR-0028 — undo (Cmd/Ctrl+Z) and redo (Cmd/Ctrl+Shift+Z)
  // routed through useKeyboardShortcuts. The existing Cmd+K palette
  // handler stays inline below to preserve regression-free behaviour.
  const dispatchShortcut = useCallback(
    (commandId: string): void => {
      if (commandId === "undo") undoStack.undo();
      else if (commandId === "redo") undoStack.redo();
      else if (commandId === "focus-status") statusRef.current?.focus();
    },
    [undoStack],
  );
  useKeyboardShortcuts({ bindings: SHELL_SHORTCUT_BINDINGS, dispatch: dispatchShortcut });

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCmdkOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const commands = useMemo(
    () => buildAppShellCommands(ws.api, onTool, pick, theme, toggleTheme, undoStack),
    [ws.api, onTool, pick, theme, toggleTheme, undoStack],
  );
  const needsGatewaySetup = !session.loading && session.models.length === 0;
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

  const paletteNode = palOpen ? (
    <Palette types={WIN_TYPES} order={CARD_TYPES} onAdd={pick} onClose={closePalette} />
  ) : null;

  return (
    <ChatSessionProvider value={session}>
      <WsContext.Provider value={wsContextValue}>
        <div className="app">
          <Header
            mode={twin.mode}
            projectName={projectName}
            onModeChange={twin.setMode}
            openPalette={openPalette}
            onTileAll={ws.api.tileAll}
            onSplitFront={ws.api.splitFront}
            onCascade={ws.api.cascade}
          />
          <div className="mid">
            <LeftRail
              openTools={openTools}
              onTool={onTool}
              onNewChat={onNewChat}
              theme={theme}
              onToggleTheme={toggleTheme}
            />
            <div className="stage">
              <Workspace ws={ws} wsRef={wsRef} openPalette={openPalette} palette={paletteNode} />
            </div>
            <RightRail openTools={openTools} onTool={onTool} />
          </div>
          <Footer
            winCount={winCount}
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
          {cmdkOpen && <CommandPalette commands={commands} onClose={closeCmdk} />}
          {needsGatewaySetup ? <GatewaySetupDialog /> : null}
          <InstallBanner />
        </div>
      </WsContext.Provider>
    </ChatSessionProvider>
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
    setMounted(true);
  }, []);
  // Register the PWA service worker exactly once per client mount (issue #126, ADR-0024 D6).
  // Sitting in the outer mount component means we register on first client render and never
  // again across the inner shell's remount cycle. `registerSw` is a silent no-op on SSR /
  // unsupported browsers / failure, so this effect cannot break the app.
  useEffect(() => {
    registerSw();
  }, []);
  if (!mounted) return <div className="app" aria-hidden="true" />;
  return (
    <TwinProvider>
      <AppShellInner />
    </TwinProvider>
  );
}
