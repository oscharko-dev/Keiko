"use client";

import { useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { ChatSessionProvider } from "./context/ChatSessionContext";
import { WsContext, type WsContextValue } from "./context/WsContext";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { LeftRail } from "./LeftRail";
import { RightRail } from "./RightRail";
import { Workspace } from "./Workspace";
import { useChatSession } from "./hooks/useChatSession";
import { useTheme } from "./hooks/useTheme";
import { useTwinMode } from "./hooks/useTwinMode";
import { useWorkspace } from "./hooks/useWorkspace";
import "./widgets";
import { WIN_TYPES, type WindowType } from "./windows/WindowsRegistry";
import type { AppWindow } from "./windows/types";

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

export function AppShell(): ReactNode {
  const { theme, toggle: toggleTheme } = useTheme();
  const { mode, setMode } = useTwinMode();
  const session = useChatSession();
  const wsRef = useRef<HTMLDivElement>(null);
  const ws = useWorkspace(wsRef);

  const winCount = ws.wins?.length ?? 0;
  const active = topWindow(ws.wins);
  const openTools = useMemo(() => deriveOpenTools(ws.wins), [ws.wins]);
  const wsContextValue: WsContextValue = useMemo(
    () => ({ wins: ws.wins ?? [], active, winCount }),
    [ws.wins, active, winCount],
  );

  const onTool = useCallback(
    (id: string): void => {
      if (id in WIN_TYPES) ws.api.toggleTool(id as WindowType);
    },
    [ws.api],
  );

  const onNewChat = useCallback((): void => {
    ws.api.add("chat", {});
  }, [ws.api]);

  // Welle-5-TODO: open the Command Palette / NewWindowDialog from this hook.
  const noop = useCallback((): void => {
    /* placeholder until later waves wire the palette */
  }, []);

  return (
    <ChatSessionProvider value={session}>
      <WsContext.Provider value={wsContextValue}>
        <div className="app">
          <Header
            mode={mode}
            onModeChange={setMode}
            openPalette={noop}
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
              <Workspace ws={ws} wsRef={wsRef} openPalette={noop} />
            </div>
            <RightRail openTools={openTools} onTool={onTool} />
          </div>
          <Footer winCount={winCount} mode={mode} />
        </div>
      </WsContext.Provider>
    </ChatSessionProvider>
  );
}
