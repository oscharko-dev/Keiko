"use client";

import { useCallback, useMemo } from "react";

import type { DebugActivationSummary } from "@oscharko-dev/keiko-contracts";
import { settingById, useEditorSettings } from "../cards/useEditorSettings";

export type DebuggingSettingsIssue = "load" | "mutation" | "conflict";

export interface DebuggingSettingsView {
  readonly summary: DebugActivationSummary | undefined;
  readonly enabled: boolean;
  readonly canEnable: boolean;
  readonly canDisable: boolean;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: DebuggingSettingsIssue | undefined;
  readonly announcement: string;
  readonly refresh: () => Promise<void>;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
}

function isDebuggingEnabled(value: unknown): boolean {
  return value === true;
}

function canEnableSummary(summary: DebugActivationSummary | undefined): boolean {
  return summary?.state === "disabled" && summary.reasonCode.startsWith("WORKSPACE_");
}

export function useDebuggingSettings(root: string | undefined): DebuggingSettingsView {
  const editor = useEditorSettings(root);
  const setting = settingById(editor.snapshot, "debuggingEnabled");
  const enabled = isDebuggingEnabled(setting?.value);
  const summary = editor.snapshot?.debugging;
  const canEnable = root !== undefined && !enabled && !editor.mutating && canEnableSummary(summary);
  const canDisable = root !== undefined && enabled && !editor.mutating;
  const setEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      if (next && !canEnable) return;
      if (!next && !canDisable) return;
      await editor.setValue("workspace", "debuggingEnabled", next);
    },
    [canDisable, canEnable, editor],
  );
  return useMemo(
    () => ({
      summary,
      enabled,
      canEnable,
      canDisable,
      loading: editor.loading,
      mutating: editor.mutating,
      issue: editor.issue,
      announcement: editor.announcement,
      refresh: editor.refresh,
      setEnabled,
    }),
    [canDisable, canEnable, editor, enabled, setEnabled, summary],
  );
}
