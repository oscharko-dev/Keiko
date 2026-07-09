"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Lets the editor's own container-level capturing keydown listener (`EditorWidget.tsx`) open the
 * shell's unified quick-access palette (`UnifiedQuickAccessPalette`) directly, bypassing
 * `useKeyboardShortcuts`' editable-target guard. That guard is correct for the shell-level chord
 * dispatch (ADR-0028): a global Cmd/Ctrl+P must not fire while the user is typing in a plain text
 * field. But the editor's Monaco surface is itself an `<textarea>`, so without this seam Cmd/Ctrl+P
 * would silently do nothing while the cursor is inside a file — a regression against the pre-#2112
 * behavior and against Epic #2090's own closure statement ("Cmd/Ctrl+P finds any file from
 * anywhere").
 */
export interface EditorQuickAccessTrigger {
  readonly openFiles: () => void;
  readonly openCommands: () => void;
}

const EditorQuickAccessTriggerContext = createContext<EditorQuickAccessTrigger | null>(null);

export function EditorQuickAccessTriggerProvider({
  value,
  children,
}: {
  readonly value: EditorQuickAccessTrigger;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <EditorQuickAccessTriggerContext.Provider value={value}>
      {children}
    </EditorQuickAccessTriggerContext.Provider>
  );
}

export function useEditorQuickAccessTrigger(): EditorQuickAccessTrigger | null {
  return useContext(EditorQuickAccessTriggerContext);
}
