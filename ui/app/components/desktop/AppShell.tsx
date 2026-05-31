"use client";

import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { Header } from "./Header";
import { Footer } from "./Footer";
import { LeftRail } from "./LeftRail";
import { RightRail } from "./RightRail";
import { Workspace } from "./Workspace";
import { useTheme } from "./hooks/useTheme";
import { useTwinMode } from "./hooks/useTwinMode";
import { useChatSession } from "./hooks/useChatSession";

export function AppShell(): ReactNode {
  const { theme, toggle: toggleTheme } = useTheme();
  const { mode, setMode } = useTwinMode();
  const session = useChatSession();
  const [openTools, setOpenTools] = useState<ReadonlySet<string>>(new Set<string>());

  const toggleTool = useCallback((id: string) => {
    setOpenTools((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Welle-2-TODO: replace this static count with useWorkspace().wins.length.
  const winCount = 1;
  // Welle-5-TODO: open the Command Palette / NewWindowDialog.
  const noop = useCallback((): void => {
    /* placeholder until later waves wire palette and window layout */
  }, []);

  return (
    <div className="app">
      <Header
        mode={mode}
        onModeChange={setMode}
        openPalette={noop}
        onTileAll={noop}
        onSplitFront={noop}
        onCascade={noop}
      />
      <div className="mid">
        <LeftRail
          openTools={openTools}
          onTool={toggleTool}
          onNewChat={() => void session.openNewChat()}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <div className="stage">
          <Workspace session={session} openPalette={noop} />
        </div>
        <RightRail openTools={openTools} onTool={toggleTool} />
      </div>
      <Footer winCount={winCount} mode={mode} />
    </div>
  );
}
