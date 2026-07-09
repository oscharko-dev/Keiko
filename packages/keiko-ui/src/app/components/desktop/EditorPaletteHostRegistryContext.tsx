"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { EditorPaletteHost } from "./widgets/cards/editorCommands";

export type RegisterEditorPaletteHost = (windowId: string, host: EditorPaletteHost) => () => void;

const EditorPaletteHostRegistryContext = createContext<RegisterEditorPaletteHost | null>(null);

export function EditorPaletteHostRegistryProvider({
  register,
  children,
}: {
  readonly register: RegisterEditorPaletteHost;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <EditorPaletteHostRegistryContext.Provider value={register}>
      {children}
    </EditorPaletteHostRegistryContext.Provider>
  );
}

export function useRegisterEditorPaletteHost(
  windowId: string | undefined,
  host: EditorPaletteHost,
): void {
  const register = useContext(EditorPaletteHostRegistryContext);
  useEffect(() => {
    if (register === null || windowId === undefined || windowId.length === 0) return undefined;
    return register(windowId, host);
  }, [host, register, windowId]);
}
