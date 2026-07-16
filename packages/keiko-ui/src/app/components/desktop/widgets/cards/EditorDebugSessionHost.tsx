"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { DebugVariableNode, SourceBreakpoint } from "@oscharko-dev/keiko-contracts";
import { useDialogTabTrap } from "../../hooks/useDialogTabTrap";
import { resolveDebugLaunchTarget } from "./debugLaunchTarget";
import type { EditorSurfaceProps } from "./EditorSurface";
import { useDebugSession } from "./useDebugSession";
import {
  useDebuggingTranslate as useTranslate,
  type DebuggingTranslate,
} from "../panels/debugging-i18n";

export interface EditorDebugSessionHostProps {
  readonly root: string;
  readonly workspaceId: string | undefined;
  readonly activationRevision: number | undefined;
  readonly enabled: boolean;
  readonly fileId: string | undefined;
  readonly onOpenDebugPanel: (() => void) | undefined;
  readonly onHostChange: (host: EditorSurfaceProps["debug"]) => void;
  readonly onSessionStateChange: (state: DebugSessionState | null) => void;
  /**
   * Reports whether the current pause (if any) was reached via an uncaught exception rather than an
   * ordinary breakpoint/step/explicit pause — the same signal DebugPanel already renders visually as
   * "Exception: ...". Optional and additive so hosts that only need the coarse session state are
   * unaffected; feeds the status bar's distinct exception-pause announcement (status-bar.ts).
   */
  readonly onExceptionPauseChange?: ((isException: boolean) => void) | undefined;
}

export type DebugSessionState =
  "reserved" | "starting" | "running" | "paused" | "stopping" | "stopped" | "failed" | "revoked";

type DebugHost = NonNullable<EditorSurfaceProps["debug"]>;
type BreakpointContext = Parameters<DebugHost["gutter"]["onOpenContextMenu"]>[0];
type BreakpointAction = BreakpointContext["actions"][number];

const MAX_INLINE_SUMMARY_VALUES = 20;
const MAX_INLINE_SUMMARY_CHARS = 320;
const ACTIVE_SESSION_STATES = new Set<DebugSessionState>([
  "reserved",
  "starting",
  "running",
  "paused",
]);

function nextMenuIndex(key: string, current: number, last: number): number {
  if (key === "Home") return 0;
  if (key === "End") return last;
  const delta = key === "ArrowUp" ? -1 : 1;
  return (current + delta + last + 1) % (last + 1);
}

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

export interface TextPromptRequest {
  readonly kind: "condition" | "logpoint";
  readonly line: number;
}

function variableValues(nodes: readonly DebugVariableNode[]): readonly string[] {
  return nodes
    .filter(
      (node): node is Extract<DebugVariableNode, { readonly kind: "variable" }> =>
        node.kind === "variable",
    )
    .slice(0, MAX_INLINE_SUMMARY_VALUES)
    .map((node) => `${node.name.value}: ${node.value.value}`);
}

function boundedInlineSummary(value: string): string {
  if (value.length <= MAX_INLINE_SUMMARY_CHARS) return value;
  return `${value.slice(0, MAX_INLINE_SUMMARY_CHARS - 1)}…`;
}

function pausedValueSummary(
  snapshot: ReturnType<typeof useDebugSession>["snapshot"],
  frameRef: string,
): string | undefined {
  const scopes = snapshot.scopesByFrame.get(frameRef)?.scopes ?? [];
  const values = scopes.flatMap((scope) =>
    variableValues(snapshot.variablesByParent.get(scope.scopeRef)?.nodes ?? []).map(
      (value) => `${scope.name.value}: ${value}`,
    ),
  );
  if (values.length === 0) return undefined;
  return boundedInlineSummary(values.slice(0, MAX_INLINE_SUMMARY_VALUES).join(" · "));
}

export function derivePausedDebugValues(
  snapshot: ReturnType<typeof useDebugSession>["snapshot"],
  fileId: string,
  documentUri: string,
  description = "",
): {
  readonly paused: boolean;
  readonly pauseGeneration: number;
  readonly documentUri: string;
  readonly description: string;
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
      description,
      values: [],
    };
  }
  const summary = pausedValueSummary(snapshot, frame.frameRef);
  return {
    paused: true,
    pauseGeneration: snapshot.session.pauseGeneration,
    documentUri,
    description,
    values:
      summary === undefined ? [] : [{ line: frame.line, column: frame.column, value: summary }],
  };
}

export function debugEditorLabels(t: DebuggingTranslate): {
  readonly gutter: DebugHost["gutter"]["labels"];
  readonly commands: NonNullable<DebugHost["commands"]["labels"]>;
} {
  return {
    gutter: {
      toggle: t("gutterToggle"),
      conditional: t("gutterConditional"),
      logpoint: t("gutterLogpoint"),
      enable: t("gutterEnable"),
      disable: t("gutterDisable"),
      currentLine: t("gutterCurrentLine"),
    },
    commands: {
      continue: t("commandStartContinue"),
      pause: t("commandPause"),
      stepOver: t("commandStepOver"),
      stepInto: t("commandStepInto"),
      stepOut: t("commandStepOut"),
      stop: t("commandStop"),
    },
  };
}

function menuLabel(
  action: BreakpointAction,
  context: BreakpointContext,
  labels: DebugHost["gutter"]["labels"],
): string {
  if (action === "toggle") return labels.toggle;
  if (action === "toggleConditional") return labels.conditional;
  if (action === "editLogpoint") return labels.logpoint;
  return context.breakpoint?.enabled === false ? labels.enable : labels.disable;
}

export function BreakpointContextMenu(props: {
  readonly context: BreakpointContext;
  readonly labels: DebugHost["gutter"]["labels"];
  readonly ariaLabel: string;
  readonly returnFocus: HTMLElement | null;
  readonly onAction: (action: BreakpointAction, context: BreakpointContext) => void;
  readonly onClose: () => void;
}): ReactNode {
  const actions = props.context.actions.filter(
    (action) => action !== "toggleEnabled" || props.context.breakpoint !== undefined,
  );
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const close = (): void => {
    props.onClose();
    props.returnFocus?.focus();
  };
  useEffect(() => refs.current[0]?.focus(), []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, refs.current.indexOf(document.activeElement as HTMLButtonElement));
    const last = actions.length - 1;
    const next = nextMenuIndex(event.key, current, last);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="menu"
      aria-label={props.ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{ position: "absolute", zIndex: 20, insetInlineStart: "12px", top: "12px" }}
    >
      {actions.map((action, index) => (
        <button
          key={action}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="menuitem"
          tabIndex={index === 0 ? 0 : -1}
          onClick={() => {
            props.onAction(action, props.context);
            close();
          }}
        >
          {menuLabel(action, props.context, props.labels)}
        </button>
      ))}
    </div>
  );
}

function textPromptTitle(
  request: TextPromptRequest,
  labels: DebugHost["gutter"]["labels"],
): string {
  return request.kind === "condition" ? labels.conditional : labels.logpoint;
}

// Replaces window.prompt() for conditional-breakpoint conditions and logpoint messages (WCAG 2.2
// AA: a native browser prompt is not reliably keyboard/screen-reader operable, is unstylable, and
// traps focus outside the app's control) — the same rationale, and the same accessible-dialog
// pattern (focus capture/restore, Tab containment via useDialogTabTrap, Escape-to-close), already
// established by EditorSettingsPanel's AiActivationConfirmDialog and EditorWidget's dirty-close
// dialog.
function BreakpointTextDialog(props: {
  readonly request: TextPromptRequest;
  readonly labels: DebugHost["gutter"]["labels"];
  readonly t: DebuggingTranslate;
  readonly returnFocus: HTMLElement | null;
  readonly onCancel: () => void;
  readonly onSave: (value: string) => void;
}): ReactNode {
  const [value, setValue] = useState("");
  const titleId = "keiko-debug-text-prompt-title";
  const inputId = "keiko-debug-text-prompt-input";
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      if (props.returnFocus?.isConnected) props.returnFocus.focus();
    };
  }, [props.returnFocus]);
  useDialogTabTrap(dialogRef);
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [props]);
  const inputLabel =
    props.request.kind === "condition"
      ? props.t("breakpointConditionPrompt")
      : props.t("logpointMessagePrompt");
  return (
    <div style={{ position: "absolute", zIndex: 20, insetInlineStart: "12px", top: "12px" }}>
      <dialog ref={dialogRef} open aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h4 id={titleId}>{textPromptTitle(props.request, props.labels)}</h4>
        <label htmlFor={inputId}>{inputLabel}</label>
        <input id={inputId} value={value} onChange={(event) => setValue(event.target.value)} />
        <button type="button" onClick={() => props.onSave(value)}>
          {props.t("save")}
        </button>
        <button type="button" onClick={props.onCancel}>
          {props.t("cancel")}
        </button>
      </dialog>
    </div>
  );
}

/**
 * Isolates DAP I/O from the editor's first-load chunk. This component only mounts after the server
 * projects an available activation capability; it never derives workspace authority in the browser.
 */
export function EditorDebugSessionHost({
  root,
  workspaceId,
  activationRevision,
  enabled,
  fileId,
  onOpenDebugPanel,
  onHostChange,
  onSessionStateChange,
  onExceptionPauseChange,
}: EditorDebugSessionHostProps): ReactNode {
  const t = useTranslate();
  const { snapshot, actions } = useDebugSession(workspaceId, enabled);
  const [contextMenu, setContextMenu] = useState<BreakpointContext | null>(null);
  const [textPrompt, setTextPrompt] = useState<TextPromptRequest | null>(null);
  const [actionError, setActionError] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const beginTextPrompt = useCallback((kind: TextPromptRequest["kind"], line: number): void => {
    setTextPrompt({ kind, line });
  }, []);
  const { loadScopes, loadStack, loadVariables } = actions;
  const pausedSession = snapshot.session?.status === "paused" ? snapshot.session : null;
  const pausedFrame = snapshot.stack?.frames[0];
  const pausedScopes = useMemo(
    () =>
      pausedFrame === undefined
        ? []
        : (snapshot.scopesByFrame.get(pausedFrame.frameRef)?.scopes ?? []),
    [pausedFrame, snapshot.scopesByFrame],
  );
  useEffect(() => {
    if (pausedSession !== null) void loadStack(pausedSession).catch(() => setActionError(true));
  }, [loadStack, pausedSession]);
  useEffect(() => {
    if (pausedSession !== null && pausedFrame !== undefined) {
      void loadScopes(pausedSession, pausedFrame.frameRef).catch(() => setActionError(true));
    }
  }, [loadScopes, pausedFrame, pausedSession]);
  useEffect(() => {
    if (pausedSession === null) return;
    for (const scope of pausedScopes)
      void loadVariables(pausedSession, scope.scopeRef).catch(() => setActionError(true));
  }, [loadVariables, pausedScopes, pausedSession]);
  const breakpoints = useMemo(
    () =>
      fileId === undefined
        ? []
        : (snapshot.instrumentation?.breakpoints.filter(
            (breakpoint) => breakpoint.fileId === fileId,
          ) ?? []),
    [fileId, snapshot.instrumentation?.breakpoints],
  );
  const perform = useCallback((operation: Promise<unknown>): void => {
    setActionError(false);
    void operation.catch(() => setActionError(true));
  }, []);
  const saveBreakpoint = useCallback(
    (line: number, replacement: SourceBreakpoint | undefined): void => {
      if (fileId === undefined) return;
      perform(actions.saveBreakpoints(fileId, replaceBreakpoint(breakpoints, line, replacement)));
    },
    [actions, breakpoints, fileId, perform],
  );
  const labels = useMemo(() => debugEditorLabels(t), [t]);
  const runBreakpointAction = useCallback(
    (action: BreakpointAction, context: BreakpointContext): void => {
      const existing = context.breakpoint;
      if (fileId === undefined) return;
      if (action === "toggle") {
        saveBreakpoint(
          context.line,
          existing === undefined ? debugBreakpoint(fileId, context.line) : undefined,
        );
      } else if (action === "toggleConditional") {
        beginTextPrompt("condition", context.line);
      } else if (action === "editLogpoint") {
        beginTextPrompt("logpoint", context.line);
      } else if (existing !== undefined) {
        saveBreakpoint(existing.line, { ...existing, enabled: !existing.enabled });
      }
    },
    [beginTextPrompt, fileId, saveBreakpoint],
  );
  const host = useMemo<EditorSurfaceProps["debug"]>(() => {
    if (!enabled || fileId === undefined || activationRevision === undefined) return undefined;
    const session = snapshot.session;
    return {
      gutter: {
        ...(pausedFrame?.sourceFileId === fileId ? { pausedLine: pausedFrame.line } : {}),
        resolveBreakpoints: () => breakpoints,
        labels: labels.gutter,
        onToggleBreakpoint: (line): void => {
          const existing = breakpoints.find((breakpoint) => breakpoint.line === line);
          saveBreakpoint(line, existing === undefined ? debugBreakpoint(fileId, line) : undefined);
        },
        onToggleConditionalBreakpoint: (line): void => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          beginTextPrompt("condition", line);
        },
        onEditLogpoint: (line): void => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          beginTextPrompt("logpoint", line);
        },
        onToggleBreakpointEnabled: (breakpoint): void => {
          saveBreakpoint(breakpoint.line, { ...breakpoint, enabled: !breakpoint.enabled });
        },
        onOpenContextMenu: (context): void => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setContextMenu(context);
        },
      },
      commands: {
        labels: labels.commands,
        isAvailable: (action): boolean => {
          if (action === "continue") return session === null || session.status === "paused";
          if (action === "pause") return session?.status === "running";
          if (action === "stop")
            return session !== null && ACTIVE_SESSION_STATES.has(session.status);
          return session?.status === "paused";
        },
        continue: (): void => {
          if (session === null) {
            onOpenDebugPanel?.();
            perform(
              resolveDebugLaunchTarget(root, fileId).then((target) =>
                actions.start(target, activationRevision),
              ),
            );
          } else if (session.status === "paused") perform(actions.control(session, "continue"));
        },
        pause: (): void => {
          if (session?.status === "running") perform(actions.control(session, "pause"));
        },
        stepOver: (): void => {
          if (session?.status === "paused") perform(actions.control(session, "next"));
        },
        stepInto: (): void => {
          if (session?.status === "paused") perform(actions.control(session, "stepIn"));
        },
        stepOut: (): void => {
          if (session?.status === "paused") perform(actions.control(session, "stepOut"));
        },
        stop: (): void => {
          if (session !== null && ACTIVE_SESSION_STATES.has(session.status))
            perform(actions.control(session, "stop"));
        },
      },
      // The bridge supplies its mounted Monaco URI on every refresh. This keeps the exact URI
      // comparison tied to the model that will receive decorations, while fileId still rejects
      // paused frames from any other workspace file.
      resolvePausedValues: (mountedDocumentUri) =>
        derivePausedDebugValues(snapshot, fileId, mountedDocumentUri, t("pausedValues")),
    };
  }, [
    activationRevision,
    actions,
    beginTextPrompt,
    breakpoints,
    enabled,
    fileId,
    labels,
    onOpenDebugPanel,
    pausedFrame,
    perform,
    root,
    saveBreakpoint,
    snapshot,
    t,
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
  const isExceptionPause = pausedSession !== null && snapshot.stopDescription !== null;
  useEffect(() => {
    onExceptionPauseChange?.(isExceptionPause);
    return () => onExceptionPauseChange?.(false);
  }, [isExceptionPause, onExceptionPauseChange]);
  if (textPrompt !== null) {
    return (
      <BreakpointTextDialog
        request={textPrompt}
        labels={labels.gutter}
        t={t}
        returnFocus={returnFocus.current}
        onCancel={() => setTextPrompt(null)}
        onSave={(value) => {
          const trimmed = value.trim();
          const request = textPrompt;
          setTextPrompt(null);
          if (trimmed.length === 0 || fileId === undefined) return;
          const patch =
            request.kind === "condition"
              ? { kind: "conditional" as const, condition: trimmed }
              : { kind: "logpoint" as const, logMessage: trimmed };
          saveBreakpoint(request.line, { ...debugBreakpoint(fileId, request.line), ...patch });
        }}
      />
    );
  }
  if (contextMenu !== null) {
    return (
      <BreakpointContextMenu
        context={contextMenu}
        labels={labels.gutter}
        ariaLabel={t("breakpointMenu", { line: contextMenu.line })}
        returnFocus={returnFocus.current}
        onAction={runBreakpointAction}
        onClose={() => setContextMenu(null)}
      />
    );
  }
  // Deliberately NOT role="alert" (or any other implicit aria-live region): the editor's
  // EditorStatusBar already owns the single polite/assertive live-announcement split for debug
  // state (status-bar.ts's liveSummary/alertSummary). A second, independently-live surface here
  // could fire an assertive announcement at the same moment the status bar announces a
  // session-state transition, competing for the screen reader's attention. The failure is still
  // visibly rendered and reachable on the accessibility tree; it is simply not announced twice.
  return actionError ? (
    <p style={{ position: "absolute", insetInlineStart: "12px", top: "12px" }}>
      {t("actionFailed")}
    </p>
  ) : null;
}
