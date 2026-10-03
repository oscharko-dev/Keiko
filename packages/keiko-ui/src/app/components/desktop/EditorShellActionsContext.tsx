"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface EditorShellActions {
  readonly openCommands: () => void;
  readonly openEditorSettings: () => void;
}

const EditorShellActionsContext = createContext<EditorShellActions | null>(null);

export function EditorShellActionsProvider({
  value,
  children,
}: {
  readonly value: EditorShellActions;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <EditorShellActionsContext.Provider value={value}>
      {children}
    </EditorShellActionsContext.Provider>
  );
}

export function useEditorShellActions(): EditorShellActions | null {
  return useContext(EditorShellActionsContext);
}
