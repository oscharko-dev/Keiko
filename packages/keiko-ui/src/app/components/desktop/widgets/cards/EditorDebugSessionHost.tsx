"use client";

import { useCallback, useEffect, useMemo } from "react";
import type { DebugVariableNode, SourceBreakpoint } from "@oscharko-dev/keiko-contracts";
import type { EditorSurfaceProps } from "./EditorSurface";
import { useDebugSession } from "./useDebugSession";

export interface EditorDebugSessionHostProps {
  readonly workspaceId: string | undefined;
  readonly activationRevision: number | undefined;
  readonly enabled: boolean;
  readonly fileId: string | undefined;
  readonly onOpenDebugPanel: (() => void) | undefined;
  readonly onHostChange: (host: EditorSurfaceProps["debug"]) => void;
  readonly onSessionStateChange: (state: DebugSessionState | null) => void;
}

export type DebugSessionState =
  "reserved" | "starting" | "running" | "paused" | "stopping" | "stopped" | "failed" | "revoked";

function debugBreakpoint(fileId: string, line: number): SourceBreakpoint {
  return {
    id: `line-${String(line)}`,
    fileId,
    line,
    enabled: true,
    kind: "line",
    verification: "pending",
  };
}

function replaceBreakpoint(
  breakpoints: readonly SourceBreakpoint[],
  line: number,
  next: SourceBreakpoint | undefined,
): readonly SourceBreakpoint[] {
  const withoutLine = breakpoints.filter((breakpoint) => breakpoint.line !== line);
  return next === undefined ? withoutLine : [...withoutLine, next];
}

function promptDebugText(message: string): string | undefined {
  const value = window.prompt(message);
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function variableValues(nodes: readonly DebugVariableNode[]): readonly string[] {
  return nodes
    .filter(
      (node): node is Extract<DebugVariableNode, { readonly kind: "variable" }> =>
        node.kind === "variable",
    )
    .slice(0, 20)
    .map((node) => `${node.name.value}: ${node.value.value}`);
}

export function derivePausedDebugValues(
  snapshot: ReturnType<typeof useDebugSession>["snapshot"],
  fileId: string,
  documentUri: string,
): {
  readonly paused: boolean;
  readonly pauseGeneration: number;
  readonly documentUri: string;
  readonly values: readonly {
    readonly line: number;
    readonly column: number;
    readonly value: string;
  }[];
} {
  const frame = snapshot.stack?.frames[0];
  if (snapshot.session?.status !== "paused" || frame?.sourceFileId !== fileId) {
    return {
      paused: false,
      pauseGeneration: snapshot.session?.pauseGeneration ?? 0,
      documentUri,
      values: [],
    };
  }
  const scope = snapshot.scopesByFrame.get(frame.frameRef)?.scopes[0];
  const variables =
    scope === undefined ? [] : (snapshot.variablesByParent.get(scope.scopeRef)?.nodes ?? []);
  return {
    paused: true,
    pauseGeneration: snapshot.session.pauseGeneration,
    documentUri,
    values: variableValues(variables).map((value) => ({
      line: frame.line,
      column: frame.column,
      value,
    })),
  };
}

/**
 * Isolates DAP I/O from the editor's first-load chunk. This component only mounts after the server
 * projects an available activation capability; it never derives workspace authority in the browser.
 */
export function EditorDebugSessionHost({
  workspaceId,
  activationRevision,
  enabled,
  fileId,
  onOpenDebugPanel,
  onHostChange,
  onSessionStateChange,
}: EditorDebugSessionHostProps): null {
  const { snapshot, actions } = useDebugSession(workspaceId, enabled);
  const { loadScopes, loadStack, loadVariables } = actions;
  const pausedSession = snapshot.session?.status === "paused" ? snapshot.session : null;
  const pausedFrame = snapshot.stack?.frames[0];
  const pausedScope =
    pausedFrame === undefined
      ? undefined
      : snapshot.scopesByFrame.get(pausedFrame.frameRef)?.scopes[0];
  useEffect(() => {
    if (pausedSession !== null) void loadStack(pausedSession);
  }, [loadStack, pausedSession]);
  useEffect(() => {
    if (pausedSession !== null && pausedFrame !== undefined) {
      void loadScopes(pausedSession, pausedFrame.frameRef);
    }
  }, [loadScopes, pausedFrame, pausedSession]);
  useEffect(() => {
    if (pausedSession !== null && pausedScope !== undefined) {
      void loadVariables(pausedSession, pausedScope.scopeRef);
    }
  }, [loadVariables, pausedScope, pausedSession]);
  const breakpoints = useMemo(
    () =>
      fileId === undefined
        ? []
        : (snapshot.instrumentation?.breakpoints.filter(
            (breakpoint) => breakpoint.fileId === fileId,
          ) ?? []),
    [fileId, snapshot.instrumentation?.breakpoints],
  );
  const saveBreakpoint = useCallback(
    (line: number, replacement: SourceBreakpoint | undefined): void => {
      if (fileId === undefined) return;
      void actions.saveBreakpoints(fileId, replaceBreakpoint(breakpoints, line, replacement));
    },
    [actions, breakpoints, fileId],
  );
  const host = useMemo<EditorSurfaceProps["debug"]>(() => {
    if (!enabled || fileId === undefined || activationRevision === undefined) return undefined;
    const session = snapshot.session;
    return {
      gutter: {
        ...(pausedFrame?.sourceFileId === fileId ? { pausedLine: pausedFrame.line } : {}),
        resolveBreakpoints: () => breakpoints,
        labels: {
          toggle: "Toggle breakpoint",
          conditional: "Set conditional breakpoint",
          logpoint: "Set logpoint",
          enable: "Enable breakpoint",
          disable: "Disable breakpoint",
        },
        onToggleBreakpoint: (line): void => {
          const existing = breakpoints.find((breakpoint) => breakpoint.line === line);
          saveBreakpoint(line, existing === undefined ? debugBreakpoint(fileId, line) : undefined);
        },
        onToggleConditionalBreakpoint: (line): void => {
          const expression = promptDebugText("Breakpoint condition");
          if (expression === undefined) return;
          saveBreakpoint(line, {
            ...debugBreakpoint(fileId, line),
            kind: "conditional",
            condition: expression,
          });
        },
        onEditLogpoint: (line): void => {
          const message = promptDebugText("Logpoint message");
          if (message === undefined) return;
          saveBreakpoint(line, {
            ...debugBreakpoint(fileId, line),
            kind: "logpoint",
            logMessage: message,
          });
        },
        onToggleBreakpointEnabled: (breakpoint): void => {
          saveBreakpoint(breakpoint.line, { ...breakpoint, enabled: !breakpoint.enabled });
        },
        onOpenContextMenu: (): void => {},
      },
      commands: {
        continue: (): void => {
          if (session === null) {
            onOpenDebugPanel?.();
            void actions.start({ kind: "file", fileId }, activationRevision);
          } else void actions.control(session, "continue");
        },
        pause: (): void => {
          if (session !== null) void actions.control(session, "pause");
        },
        stepOver: (): void => {
          if (session !== null) void actions.control(session, "next");
        },
        stepInto: (): void => {
          if (session !== null) void actions.control(session, "stepIn");
        },
        stepOut: (): void => {
          if (session !== null) void actions.control(session, "stepOut");
        },
        stop: (): void => {
          if (session !== null) void actions.control(session, "stop");
        },
      },
      // The bridge supplies its mounted Monaco URI on every refresh. This keeps the exact URI
      // comparison tied to the model that will receive decorations, while fileId still rejects
      // paused frames from any other workspace file.
      resolvePausedValues: (mountedDocumentUri) =>
        derivePausedDebugValues(snapshot, fileId, mountedDocumentUri),
    };
  }, [
    activationRevision,
    actions,
    breakpoints,
    enabled,
    fileId,
    onOpenDebugPanel,
    pausedFrame,
    saveBreakpoint,
    snapshot,
  ]);

  useEffect(() => {
    onHostChange(host);
  }, [host, onHostChange]);
  useEffect(() => {
    return () => onHostChange(undefined);
  }, [onHostChange]);
  const sessionState = snapshot.session?.status ?? null;
  useEffect(() => {
    onSessionStateChange(sessionState);
    return () => onSessionStateChange(null);
  }, [onSessionStateChange, sessionState]);
  return null;
}
