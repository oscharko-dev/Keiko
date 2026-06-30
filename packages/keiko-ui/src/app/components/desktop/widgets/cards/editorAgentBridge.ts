"use client";

/**
 * Browser-side editor-agent bridge (Issue #1393, ADR-0061).
 *
 * Splits the per-pane agent wiring into a pure, React-free action dispatcher
 * ({@link dispatchEditorAgentAction}) and a thin React hook ({@link useEditorAgentBridge}) that
 * owns the session id, the snapshot-register effect, the SSE connection, and result posting.
 *
 * The pure dispatcher maps a validated {@link EditorAgentAction} to a controller call and returns a
 * synchronous {@link EditorAgentActionDescriptor} — or a Promise of one (`save`) — without touching
 * React or the DOM, so the full nine-action protocol is unit-testable in isolation. The two write
 * actions (`applyTextEdits`/`applyPatch`) need React setters, so they return a `"deferred"` marker
 * and self-report from inside their component callbacks via the shared result-posting helper.
 *
 * The three layout-controller actions (`moveTab`, `splitPane`, `setSelection`) are completed here:
 * `moveTab`/`splitPane` delegate to the layout controllers injected by `EditorWidget`; `setSelection`
 * sets a one-shot `revealRequest` payload the host merges into the editor surface.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { postEditorAgentActionResult } from "../../../../../lib/api";
import type {
  EditorAgentAction,
  EditorAgentActionResult,
  EditorAgentActionResultRequest,
  EditorAgentConflictCode,
} from "../../../../../lib/types";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isContainedAgentPath,
  isEditorAgentEvent,
} from "../../../../../lib/types";

/** A content-free agent selection-reveal request the host merges into the editor surface. */
export interface EditorAgentSelectionRequest {
  readonly actionId: string;
  readonly selection: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

/**
 * The execution dependencies the pure dispatcher needs, grouped so {@link dispatchEditorAgentAction}
 * takes a single argument. Every dependency is a plain function or value — no React types leak in.
 */
export interface EditorAgentActionControllers {
  /** The pane this bridge serves; used as the default pane target for layout actions. */
  readonly paneId: string | undefined;
  /** Open/focus a file tab in this pane. */
  readonly onSelectOpenFile: ((file: string) => void) | undefined;
  /** Whether the host's deterministic formatter is available for the active language. */
  readonly formattingEnabled: boolean;
  /** Bump the host's format-request nonce to trigger a Monaco format pass. */
  readonly formatRequest: { readonly increment: () => void };
  /** Persist the current buffer; resolves true on success. */
  readonly persist: (text: string) => Promise<boolean>;
  /** The current buffer text (read from a ref so it is always live). */
  readonly currentText: () => string;
  /** Apply agent text edits in place; self-reports via the shared helper. */
  readonly applyTextEdits: (action: EditorAgentAction) => void;
  /** Stage an agent patch for explicit review; self-reports via the shared helper. */
  readonly applyPatch: (action: EditorAgentAction) => void;
  /** Split the given pane; injected by EditorWidget. Undefined when rendered standalone. */
  readonly onSplitPane: ((paneId: string, direction: "row" | "column") => void) | undefined;
  /** Move a file tab across panes; injected by EditorWidget. Undefined when rendered standalone. */
  readonly onMoveTab: ((fromPaneId: string, file: string, toPaneId: string) => void) | undefined;
  /** Request a selection reveal on the editor surface (one-shot, host-consumed). */
  readonly onRequestSelectionReveal: ((request: EditorAgentSelectionRequest) => void) | undefined;
}

/** The result of executing a single agent action. */
export type EditorAgentActionDescriptor =
  | {
      readonly status: "succeeded" | "failed" | "conflict";
      readonly message?: string;
      readonly conflictCode?: EditorAgentConflictCode;
    }
  | { readonly status: "deferred" }
  | { readonly status: "async"; readonly promise: Promise<EditorAgentActionDescriptor> };

const DEFERRED: EditorAgentActionDescriptor = { status: "deferred" };

function dispatchOpenOrFocus(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const file = action.target?.file;
  if (file === undefined) return { status: "failed", message: "Missing target file." };
  controllers.onSelectOpenFile?.(file);
  return { status: "succeeded" };
}

function dispatchFormat(controllers: EditorAgentActionControllers): EditorAgentActionDescriptor {
  if (!controllers.formattingEnabled) {
    return { status: "failed", message: "Formatting is unavailable for this language." };
  }
  controllers.formatRequest.increment();
  return { status: "succeeded" };
}

function dispatchSave(controllers: EditorAgentActionControllers): EditorAgentActionDescriptor {
  const promise = controllers
    .persist(controllers.currentText())
    .then((ok): EditorAgentActionDescriptor =>
      ok ? { status: "succeeded" } : { status: "failed", message: "Save failed." },
    );
  return { status: "async", promise };
}

function dispatchSplitPane(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  if (controllers.onSplitPane === undefined) {
    return { status: "failed", message: "Provider unavailable." };
  }
  const direction = action.target?.splitDirection ?? "row";
  const targetPaneId = action.target?.paneId ?? controllers.paneId;
  if (targetPaneId === undefined) return { status: "failed", message: "Missing target pane." };
  controllers.onSplitPane(targetPaneId, direction);
  return { status: "succeeded" };
}

function dispatchMoveTab(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const file = action.target?.file;
  if (file === undefined) return { status: "failed", message: "Missing target file." };
  if (!isContainedAgentPath(file)) {
    return {
      status: "conflict",
      conflictCode: "OUT_OF_SCOPE",
      message: "File target is outside the workspace root.",
    };
  }
  if (controllers.onMoveTab === undefined) {
    return { status: "failed", message: "Provider unavailable." };
  }
  const fromPaneId = action.target?.paneId ?? controllers.paneId;
  const toPaneId = action.target?.toPaneId;
  if (fromPaneId === undefined || toPaneId === undefined) {
    return { status: "failed", message: "Missing pane target." };
  }
  controllers.onMoveTab(fromPaneId, file, toPaneId);
  return { status: "succeeded" };
}

function dispatchSetSelection(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  const selection = action.target?.selection;
  if (selection === undefined) {
    return { status: "failed", message: "Missing selection target." };
  }
  if (controllers.onRequestSelectionReveal === undefined) {
    return { status: "failed", message: "Provider unavailable." };
  }
  controllers.onRequestSelectionReveal({ actionId: action.actionId, selection });
  return { status: "succeeded" };
}

/**
 * Pure, React-free dispatcher: map a validated agent action to a controller call and return a
 * descriptor. `applyTextEdits`/`applyPatch` return `"deferred"` (they self-report inside the
 * component); `save` returns `"async"` with a Promise of the final descriptor.
 */
export function dispatchEditorAgentAction(
  action: EditorAgentAction,
  controllers: EditorAgentActionControllers,
): EditorAgentActionDescriptor {
  switch (action.type) {
    case "openFile":
    case "focusTab":
      return dispatchOpenOrFocus(action, controllers);
    case "format":
      return dispatchFormat(controllers);
    case "save":
      return dispatchSave(controllers);
    case "applyTextEdits":
      controllers.applyTextEdits(action);
      return DEFERRED;
    case "applyPatch":
      controllers.applyPatch(action);
      return DEFERRED;
    case "splitPane":
      return dispatchSplitPane(action, controllers);
    case "moveTab":
      return dispatchMoveTab(action, controllers);
    case "setSelection":
      return dispatchSetSelection(action, controllers);
  }
}

/**
 * Build an {@link EditorAgentActionResultRequest} and post it best-effort. Shared by the hook (for
 * synchronously resolved descriptors) and the component's applyText/applyPatch callbacks, so the
 * result envelope is built in exactly one place.
 */
export function postEditorAgentResult(
  action: EditorAgentAction,
  status: "succeeded" | "failed" | "conflict",
  message?: string,
  conflictCode?: EditorAgentConflictCode,
): void {
  const conflict: EditorAgentActionResult["conflict"] =
    conflictCode !== undefined ? { code: conflictCode, message: message ?? "" } : undefined;
  const body: EditorAgentActionResultRequest = {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    kind: "result",
    result: {
      schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
      actionId: action.actionId,
      sessionId: action.sessionId,
      status,
      ...(message === undefined ? {} : { message }),
      ...(conflict === undefined ? {} : { conflict }),
    },
  };
  void postEditorAgentActionResult(body).catch(() => {
    // Best-effort action reporting; the local UI action already happened or was rejected.
  });
}

function reportDescriptor(
  action: EditorAgentAction,
  descriptor: EditorAgentActionDescriptor,
): void {
  if (descriptor.status === "deferred") return;
  if (descriptor.status === "async") {
    void descriptor.promise.then((resolved) => reportDescriptor(action, resolved));
    return;
  }
  postEditorAgentResult(action, descriptor.status, descriptor.message, descriptor.conflictCode);
}

export interface UseEditorAgentBridgeParams {
  readonly agentSessionId: string;
  readonly controllers: EditorAgentActionControllers;
  readonly enabled?: boolean | undefined;
  /**
   * Posts the current pane snapshot to the BFF. The host wraps this in `useCallback` with its full
   * snapshot dependency list, so its identity changes exactly when a snapshot dimension changes and
   * the hook re-fires the register effect.
   */
  readonly registerSnapshot: () => void;
  readonly onConflict: (conflict: {
    readonly code: EditorAgentConflictCode;
    readonly message: string;
  }) => void;
  /**
   * Issue #1395 — fired whenever the bridge observes agent activity for this session (an action
   * dispatch or a result). The recent-actions audit panel uses it to re-fetch the bounded audit feed
   * so the governance surface stays live without widening the frozen `EditorAgentEvent` union.
   */
  readonly onAgentActivity?: (() => void) | undefined;
}

export interface UseEditorAgentBridgeResult {
  readonly agentSelectionRequest: EditorAgentSelectionRequest | null;
  readonly consumeSelectionRequest: () => void;
}

/**
 * The single React artifact of the bridge: owns the snapshot-register effect, the SSE connection
 * (action + result listeners, both validated with `isEditorAgentEvent`), result posting, conflict
 * surfacing, and the one-shot `setSelection` reveal state.
 */
export function useEditorAgentBridge(
  params: UseEditorAgentBridgeParams,
): UseEditorAgentBridgeResult {
  const {
    agentSessionId,
    controllers,
    enabled = true,
    registerSnapshot,
    onConflict,
    onAgentActivity,
  } = params;
  const [agentSelectionRequest, setAgentSelectionRequest] =
    useState<EditorAgentSelectionRequest | null>(null);

  // Refs keep the SSE effect stable across re-renders so the live onConflictRef and
  // dispatchControllersRef are used without tearing down and re-opening the EventSource on every keystroke.
  const onConflictRef = useRef(onConflict);
  onConflictRef.current = onConflict;
  const onAgentActivityRef = useRef(onAgentActivity);
  onAgentActivityRef.current = onAgentActivity;

  const requestSelectionReveal = useCallback((request: EditorAgentSelectionRequest): void => {
    setAgentSelectionRequest(request);
  }, []);

  const consumeSelectionRequest = useCallback((): void => {
    setAgentSelectionRequest(null);
  }, []);

  // The `setSelection` controller is owned by the hook (it drives hook state); merge it onto the
  // host-provided controllers so the dispatcher sees a complete set.
  const dispatchControllers = useMemo<EditorAgentActionControllers>(
    () => ({ ...controllers, onRequestSelectionReveal: requestSelectionReveal }),
    [controllers, requestSelectionReveal],
  );
  const dispatchControllersRef = useRef(dispatchControllers);
  dispatchControllersRef.current = dispatchControllers;

  useEffect(() => {
    registerSnapshot();
  }, [registerSnapshot]);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    if (!enabled) return;
    // Issue #1392 — carry the session id so the BFF registers this connection as the session's live
    // browser bridge. The client-side session filter below remains as defense in depth.
    const source = new EventSource(
      `/api/editor/agent/events?sessionId=${encodeURIComponent(agentSessionId)}`,
    );
    const onAction = (event: MessageEvent<string>): void => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        // Validate at the trust boundary with the public contract guard (#1391).
        if (!isEditorAgentEvent(parsed) || parsed.type !== "action") return;
        const action = parsed.action;
        if (action.sessionId !== agentSessionId) return;
        const descriptor = dispatchEditorAgentAction(action, dispatchControllersRef.current);
        reportDescriptor(action, descriptor);
        // Issue #1395 — an action for this session was dispatched; refresh the audit panel.
        onAgentActivityRef.current?.();
      } catch {
        // Ignore malformed SSE frames; the server owns validation before enqueueing.
      }
    };
    const onResult = (event: MessageEvent<string>): void => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!isEditorAgentEvent(parsed)) return;
        if (parsed.type !== "result") return;
        // F6: filter by sessionId so a result for another pane does not pop this banner.
        if (parsed.result.sessionId !== agentSessionId) return;
        // Issue #1395 — any result for this session is audit-relevant; refresh the audit panel.
        onAgentActivityRef.current?.();
        if (parsed.result.status !== "conflict") return;
        const { conflict } = parsed.result;
        if (conflict === undefined) return;
        onConflictRef.current({ code: conflict.code, message: conflict.message });
      } catch {
        // Ignore malformed SSE frames.
      }
    };
    source.addEventListener("editor-agent:action", onAction);
    source.addEventListener("editor-agent:result", onResult);
    return () => {
      source.removeEventListener("editor-agent:action", onAction);
      source.removeEventListener("editor-agent:result", onResult);
      source.close();
    };
  }, [agentSessionId, enabled]);

  return { agentSelectionRequest, consumeSelectionRequest };
}
