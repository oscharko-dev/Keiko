"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { DebugActivationSummary } from "@oscharko-dev/keiko-contracts";
import { ApiError, mutateDebugActivation } from "../../../../../lib/api";
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

let fallbackId = 0;

function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  fallbackId += 1;
  return `debug-activation-ui-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isDebuggingEnabled(value: unknown): boolean {
  return value === true;
}

function canEnableSummary(summary: DebugActivationSummary | undefined): boolean {
  return summary?.state === "disabled" && summary.reasonCode.startsWith("WORKSPACE_");
}

function isMutationBlocked(next: boolean, canEnable: boolean, canDisable: boolean): boolean {
  return (next && !canEnable) || (!next && !canDisable);
}

function mutationIssue(error: unknown): DebuggingSettingsIssue {
  return error instanceof ApiError && error.code === "STALE_REVISION" ? "conflict" : "mutation";
}

export function useDebuggingSettings(root: string | undefined): DebuggingSettingsView {
  const editor = useEditorSettings(root);
  const setting = settingById(editor.snapshot, "debuggingEnabled");
  const enabled = isDebuggingEnabled(setting?.value);
  const summary = editor.snapshot?.debugging;
  const canEnable = root !== undefined && !enabled && !editor.mutating && canEnableSummary(summary);
  const canDisable = root !== undefined && enabled && !editor.mutating;
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<DebuggingSettingsIssue | undefined>(undefined);
  const setEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      if (isMutationBlocked(next, canEnable, canDisable)) return;
      const snapshot = editor.snapshot;
      if (root === undefined) return;
      if (snapshot === undefined) return;
      mutationAbort.current?.abort();
      const controller = new AbortController();
      mutationAbort.current = controller;
      setMutating(true);
      setIssue(undefined);
      try {
        await mutateDebugActivation(
          next ? "activate" : "deactivate",
          { root, expectedRevision: snapshot.workspaceRevision },
          snapshot.etag,
          idempotencyKey(),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        await editor.refresh();
      } catch (error: unknown) {
        if (aborted(error)) return;
        setIssue(mutationIssue(error));
      } finally {
        if (!controller.signal.aborted) setMutating(false);
      }
    },
    [canDisable, canEnable, editor, root],
  );
  const refresh = useCallback(async (): Promise<void> => {
    setIssue(undefined);
    await editor.refresh();
  }, [editor]);
  return useMemo(
    () => ({
      summary,
      enabled,
      canEnable,
      canDisable,
      loading: editor.loading,
      mutating: editor.mutating || mutating,
      issue: issue ?? editor.issue,
      announcement: editor.announcement,
      refresh,
      setEnabled,
    }),
    [canDisable, canEnable, editor, enabled, issue, mutating, refresh, setEnabled, summary],
  );
}
