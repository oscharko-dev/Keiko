"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  DebugSession,
  DebugVariableNode,
  ExceptionBreakpointFilter,
  StackFrame,
  WatchEvaluationResult,
  WatchExpression,
} from "@oscharko-dev/keiko-contracts";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../../hooks/useWorkspace.types";
import { useDebugSession } from "../cards/useDebugSession";
import {
  debugSessionStatus,
  useDebuggingTranslate as useTranslate,
  type DebuggingTranslate,
} from "./debugging-i18n";

export interface DebugPanelProps {
  readonly root: string;
  /** Current editor file selected by the workspace host; never a browser-supplied launch command. */
  readonly activeFile?: string | undefined;
  /** Canonical server-projected identity. Never derive this from the browser-visible root path. */
  readonly workspaceId?: string | undefined;
  /** Server-resolved capability revision; required by the start route's stale-activation guard. */
  readonly activationRevision?: number | undefined;
  /**
   * This consumption seam deliberately defaults to false. #2347 replaces the caller with its
   * deployment-ceilinged capability resolution; this panel never computes policy.
   */
  readonly debugEnabled?: boolean | undefined;
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
  readonly onRevealFrame?: ((frame: StackFrame) => void) | undefined;
}

interface TreeRow {
  readonly id: string;
  readonly parentId?: string | undefined;
  readonly label: string;
  readonly level: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly variableRef?: string | undefined;
  readonly node?: DebugVariableNode | undefined;
}

interface EditingVariable {
  readonly reference: string;
  readonly value: string;
}

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  height: "100%",
  overflow: "auto",
  padding: "12px",
};
const SECTION_STYLE: CSSProperties = {
  border: "1px solid var(--border-subtle, var(--border))",
  borderRadius: "6px",
  padding: "8px",
};
const TREE_ROW_STYLE: CSSProperties = { display: "block", width: "100%", textAlign: "left" };
const GROUP_STYLE: CSSProperties = { border: 0, margin: 0, padding: 0 };
const OUTPUT_STYLE: CSSProperties = {
  background: "var(--surface-raised, var(--surface))",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "0.85em",
  margin: 0,
  maxHeight: "180px",
  overflow: "auto",
  padding: "8px",
  whiteSpace: "pre-wrap",
};

function nextTreeId(key: string, ids: readonly string[], current: string): string {
  const index = Math.max(0, ids.indexOf(current));
  if (key === "Home") return ids[0] ?? current;
  if (key === "End") return ids.at(-1) ?? current;
  if (key === "ArrowUp") return ids[Math.max(0, index - 1)] ?? current;
  return ids[Math.min(ids.length - 1, index + 1)] ?? current;
}

function nodeRows(
  nodes: readonly DebugVariableNode[],
  level: number,
  expanded: ReadonlySet<string>,
  parentId: string,
  t: DebuggingTranslate,
): readonly TreeRow[] {
  return nodes.flatMap((node, index): readonly TreeRow[] => {
    const id = `${parentId}.${String(index)}`;
    if (node.kind === "truncated") {
      return [
        {
          id,
          parentId,
          label: t("omittedVariables", { count: node.omittedCount }),
          level,
          expandable: false,
          expanded: false,
          node,
        },
      ];
    }
    const expandable = node.variableRef !== undefined;
    const isExpanded = expanded.has(id);
    return [
      {
        id,
        parentId,
        label: `${node.name.value}: ${node.value.value}`,
        level,
        expandable,
        expanded: isExpanded,
        ...(node.variableRef === undefined ? {} : { variableRef: node.variableRef }),
        node,
      },
      ...(isExpanded ? nodeRows(node.children, level + 1, expanded, id, t) : []),
    ];
  });
}

function treeRowMarker(row: TreeRow): string {
  if (!row.expandable) return "";
  return row.expanded ? "▾ " : "▸ ";
}

function scopeRows(
  scopes: readonly { readonly scopeRef: string; readonly name: { readonly value: string } }[],
  nodesByParent: ReadonlyMap<string, { readonly nodes: readonly DebugVariableNode[] }>,
  expanded: ReadonlySet<string>,
  t: DebuggingTranslate,
): readonly TreeRow[] {
  return scopes.flatMap((scope) => {
    const id = `scope:${scope.scopeRef}`;
    const isExpanded = expanded.has(id);
    const children = nodesByParent.get(scope.scopeRef)?.nodes ?? [];
    return [
      {
        id,
        label: scope.name.value,
        level: 1,
        expandable: true,
        expanded: isExpanded,
        variableRef: scope.scopeRef,
      },
      ...(isExpanded ? nodeRows(children, 2, expanded, id, t) : []),
    ];
  });
}

function frameRequest(root: string, frame: StackFrame): OpenEditorFileRequest | null {
  if (frame.sourceFileId === undefined) return null;
  return {
    root,
    path: frame.sourceFileId,
    lineStart: frame.line,
    lineEnd: frame.line,
  };
}

function toggleExceptionFilter(
  filters: readonly ExceptionBreakpointFilter[],
  filterId: string,
): readonly ExceptionBreakpointFilter[] {
  return filters.map((filter) =>
    filter.filterId === filterId ? { ...filter, enabled: !filter.enabled } : filter,
  );
}

function Tree(props: {
  readonly rows: readonly TreeRow[];
  readonly onExpand: (row: TreeRow) => void;
  readonly onEdit: (row: TreeRow) => void;
  readonly t: DebuggingTranslate;
}): ReactNode {
  const [focusId, setFocusId] = useState(props.rows[0]?.id ?? "");
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const ids = useMemo(() => props.rows.map((row) => row.id), [props.rows]);
  useEffect(() => {
    if (!ids.includes(focusId)) setFocusId(ids[0] ?? "");
  }, [focusId, ids]);
  const focus = (id: string): void => {
    setFocusId(id);
    refs.current.get(id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, row: TreeRow): void => {
    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      focus(nextTreeId(event.key, ids, row.id));
    } else if (event.key === "ArrowRight" && row.expandable) {
      event.preventDefault();
      const child = props.rows.find((candidate) => candidate.parentId === row.id);
      if (row.expanded && child !== undefined) focus(child.id);
      else if (!row.expanded) props.onExpand(row);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.expandable && row.expanded) props.onExpand(row);
      else if (row.parentId !== undefined) focus(row.parentId);
    } else if (
      event.key === "Enter" &&
      row.node?.kind === "variable" &&
      row.variableRef !== undefined
    ) {
      event.preventDefault();
      props.onEdit(row);
    }
  };
  return (
    <div role="tree" aria-label={props.t("variables")}>
      {props.rows.map((row) => (
        <button
          key={row.id}
          ref={(element) => {
            if (element === null) refs.current.delete(row.id);
            else refs.current.set(row.id, element);
          }}
          type="button"
          role="treeitem"
          aria-level={row.level}
          aria-selected={focusId === row.id}
          aria-expanded={row.expandable ? row.expanded : undefined}
          tabIndex={focusId === row.id ? 0 : -1}
          style={{ ...TREE_ROW_STYLE, padding: `4px 4px 4px ${String(8 + row.level * 14)}px` }}
          onFocus={() => setFocusId(row.id)}
          onKeyDown={(event) => onKeyDown(event, row)}
          onClick={() => {
            if (row.expandable) props.onExpand(row);
          }}
        >
          {treeRowMarker(row)}
          {row.label}
        </button>
      ))}
    </div>
  );
}

export function draftWatchId(sequence: number): string {
  return `draft-watch-${String(sequence)}`;
}

function WatchEditor(props: {
  readonly watches: readonly WatchExpression[];
  readonly onSave: (watches: readonly WatchExpression[]) => Promise<boolean>;
  readonly onEvaluate: (watchId: string) => void;
  readonly canEvaluate: boolean;
  readonly t: DebuggingTranslate;
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const draftSequence = useRef(0);
  const begin = (watch?: WatchExpression): void => {
    setEditing(watch?.watchId ?? "new");
    setDraft(watch?.expression ?? "");
  };
  const save = async (): Promise<void> => {
    const next =
      editing === "new"
        ? [
            ...props.watches,
            { watchId: draftWatchId(draftSequence.current), expression: draft, enabled: true },
          ]
        : props.watches.map((watch) =>
            watch.watchId === editing ? { ...watch, expression: draft } : watch,
          );
    if (await props.onSave(next)) setEditing(null);
  };
  const beginNew = (): void => {
    draftSequence.current += 1;
    begin();
  };
  return (
    <section aria-labelledby="debug-watch-heading" style={SECTION_STYLE}>
      <h2 id="debug-watch-heading">{props.t("watch")}</h2>
      <p>{props.t("watchHelp")}</p>
      {props.watches.map((watch) => (
        <div key={watch.watchId} style={{ display: "flex", gap: "6px" }}>
          <code>{watch.expression}</code>
          <button
            type="button"
            disabled={!props.canEvaluate}
            onClick={() => props.onEvaluate(watch.watchId)}
          >
            {props.t("evaluateWatch", { expression: watch.expression })}
          </button>
          <button type="button" onClick={() => begin(watch)}>
            {props.t("edit")}
          </button>
        </div>
      ))}
      {editing === null ? (
        <button type="button" onClick={beginNew}>
          {props.t("addWatch")}
        </button>
      ) : (
        <fieldset aria-label={props.t("watchEditor")} style={GROUP_STYLE}>
          <label htmlFor="debug-watch-expression">{props.t("watchExpression")}</label>
          <input
            id="debug-watch-expression"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              void save();
            }}
          >
            {props.t("save")}
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            {props.t("cancel")}
          </button>
        </fieldset>
      )}
    </section>
  );
}

type DebugControlAction = "continue" | "pause" | "next" | "stepIn" | "stepOut" | "stop";

function canControl(session: DebugSession, action: DebugControlAction): boolean {
  if (action === "continue" || action === "next" || action === "stepIn" || action === "stepOut")
    return session.status === "paused";
  if (action === "pause") return session.status === "running";
  return ["reserved", "starting", "running", "paused"].includes(session.status);
}

function exceptionFilterLabel(t: DebuggingTranslate, filterId: string): string {
  if (filterId === "caught") return t("filterCaught");
  if (filterId === "uncaught") return t("filterUncaught");
  return filterId;
}

function CallStack(props: {
  readonly frames: readonly StackFrame[];
  readonly selectedFrameRef: string | undefined;
  readonly onSelect: (frame: StackFrame) => void;
  readonly label: string;
}): ReactNode {
  const selectedIndex = Math.max(
    0,
    props.frames.findIndex((frame) => frame.frameRef === props.selectedFrameRef),
  );
  const [focusIndex, setFocusIndex] = useState(selectedIndex);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => setFocusIndex(selectedIndex), [selectedIndex]);
  const nextFrameIndex = (key: string, index: number): number => {
    if (key === "Home") return 0;
    if (key === "End") return props.frames.length - 1;
    const delta = key === "ArrowUp" ? -1 : 1;
    return Math.max(0, Math.min(props.frames.length - 1, index + delta));
  };
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = nextFrameIndex(event.key, index);
    setFocusIndex(next);
    refs.current[next]?.focus();
    const frame = props.frames[next];
    if (frame !== undefined) props.onSelect(frame);
  };
  return (
    <div role="list" aria-label={props.label}>
      {props.frames.map((frame, index) => (
        <div key={frame.frameRef} role="listitem">
          <button
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            aria-pressed={frame.frameRef === props.selectedFrameRef}
            tabIndex={focusIndex === index ? 0 : -1}
            onFocus={() => setFocusIndex(index)}
            onKeyDown={(event) => move(event, index)}
            onClick={() => props.onSelect(frame)}
          >
            {frame.name.value}
            {frame.sourceFileId === undefined
              ? ""
              : ` — ${frame.sourceFileId}:${String(frame.line)}`}
          </button>
        </div>
      ))}
    </div>
  );
}

export function DebugPanel({
  root,
  workspaceId,
  debugEnabled = false,
  activationRevision,
  activeFile,
  openEditorFile,
  onRevealFrame,
}: DebugPanelProps): ReactNode {
  const t = useTranslate();
  const enabled = debugEnabled && workspaceId !== undefined && workspaceId.length > 0;
  const { snapshot, actions } = useDebugSession(workspaceId, enabled);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedFrameRef, setSelectedFrameRef] = useState<string | null>(null);
  const [editingVariable, setEditingVariable] = useState<EditingVariable | null>(null);
  const [watchResults, setWatchResults] = useState<ReadonlyMap<string, WatchEvaluationResult>>(
    new Map(),
  );
  const [actionError, setActionError] = useState(false);
  const session = snapshot.session;
  const selectedFrame =
    snapshot.stack?.frames.find((frame) => frame.frameRef === selectedFrameRef) ??
    snapshot.stack?.frames[0];
  const scopes = useMemo(
    () =>
      selectedFrame === undefined
        ? []
        : (snapshot.scopesByFrame.get(selectedFrame.frameRef)?.scopes ?? []),
    [selectedFrame, snapshot.scopesByFrame],
  );
  const rows = useMemo(
    () => scopeRows(scopes, snapshot.variablesByParent, expanded, t),
    [expanded, scopes, snapshot.variablesByParent, t],
  );
  const loadStack = actions.loadStack;
  const loadScopes = actions.loadScopes;

  useEffect(() => {
    if (session?.status === "paused") void loadStack(session).catch(() => setActionError(true));
  }, [loadStack, session]);

  useEffect(() => {
    if (session?.status === "paused" && selectedFrame !== undefined) {
      void loadScopes(session, selectedFrame.frameRef).catch(() => setActionError(true));
    }
  }, [loadScopes, selectedFrame, session]);

  useEffect(() => {
    setWatchResults(new Map());
  }, [session?.pauseGeneration, session?.sessionId]);

  const perform = (operation: Promise<unknown>, onSuccess?: () => void): void => {
    setActionError(false);
    void operation.then(onSuccess).catch(() => setActionError(true));
  };

  const selectFrame = (frame: StackFrame): void => {
    setSelectedFrameRef(frame.frameRef);
    onRevealFrame?.(frame);
    const request = frameRequest(root, frame);
    if (request !== null) openEditorFile?.(request);
  };

  const expand = (row: TreeRow): void => {
    if (row.variableRef === undefined) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
    if (session !== null) perform(actions.loadVariables(session, row.variableRef));
  };

  if (!debugEnabled) {
    return (
      <section aria-label={t("panelLabel")} style={PANEL_STYLE}>
        <p>{t("unavailableByPolicy")}</p>
      </section>
    );
  }
  if (workspaceId === undefined || workspaceId.length === 0) {
    return (
      <section aria-label={t("panelLabel")} style={PANEL_STYLE}>
        <p>{t("unavailableWithoutWorkspace")}</p>
      </section>
    );
  }

  const filters = snapshot.instrumentation?.exceptionFilters ?? [];
  const watches = snapshot.instrumentation?.watches ?? [];
  const start = (): void => {
    if (
      session !== null ||
      activeFile === undefined ||
      activeFile.length === 0 ||
      activationRevision === undefined
    )
      return;
    perform(actions.start({ kind: "file", fileId: activeFile }, activationRevision));
  };
  const control = (action: DebugControlAction): void => {
    if (session === null || !canControl(session, action)) return;
    perform(actions.control(session, action));
  };
  const evaluateWatch = (watchId: string): void => {
    if (session?.status !== "paused" || selectedFrame === undefined) return;
    setActionError(false);
    void actions
      .evaluateWatch(session, watchId, selectedFrame.frameRef)
      .then((result) => {
        if (result === null) return;
        setWatchResults((current) => new Map(current).set(result.watchId, result));
      })
      .catch(() => setActionError(true));
  };
  return (
    <section aria-label={t("panelLabel")} style={PANEL_STYLE}>
      <header>
        <h1>{t("panelLabel")}</h1>
        <p>
          {session === null
            ? t("noActiveSession")
            : t("sessionStatus", { status: debugSessionStatus(t, session.status) })}
        </p>
        {session?.status === "paused" && snapshot.stopDescription !== null ? (
          <p>{t("exceptionDescription", { description: snapshot.stopDescription.value })}</p>
        ) : null}
        {actionError ? <p role="alert">{t("actionFailed")}</p> : null}
        {session === null ? (
          <button
            type="button"
            disabled={
              activeFile === undefined ||
              activeFile.length === 0 ||
              activationRevision === undefined
            }
            onClick={start}
          >
            {t("startCurrentFile")}
          </button>
        ) : (
          <fieldset aria-label={t("controlsLabel")} style={GROUP_STYLE}>
            <button
              type="button"
              disabled={!canControl(session, "continue")}
              onClick={() => control("continue")}
            >
              {t("continue")}
            </button>
            <button
              type="button"
              disabled={!canControl(session, "pause")}
              onClick={() => control("pause")}
            >
              {t("pause")}
            </button>
            <button
              type="button"
              disabled={!canControl(session, "next")}
              onClick={() => control("next")}
            >
              {t("stepOver")}
            </button>
            <button
              type="button"
              disabled={!canControl(session, "stepIn")}
              onClick={() => control("stepIn")}
            >
              {t("stepInto")}
            </button>
            <button
              type="button"
              disabled={!canControl(session, "stepOut")}
              onClick={() => control("stepOut")}
            >
              {t("stepOut")}
            </button>
            <button
              type="button"
              disabled={!canControl(session, "stop")}
              onClick={() => control("stop")}
            >
              {t("stop")}
            </button>
          </fieldset>
        )}
      </header>
      <section aria-labelledby="debug-exception-heading" style={SECTION_STYLE}>
        <h2 id="debug-exception-heading">{t("exceptionBreakpoints")}</h2>
        {filters.length === 0 ? (
          <p>{t("noExceptionFilters")}</p>
        ) : (
          filters.map((filter) => (
            <label key={filter.filterId} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={filter.enabled}
                onChange={() => {
                  perform(
                    actions.saveExceptionFilters(toggleExceptionFilter(filters, filter.filterId)),
                  );
                }}
              />
              {exceptionFilterLabel(t, filter.filterId)}
            </label>
          ))
        )}
      </section>
      <section aria-labelledby="debug-stack-heading" style={SECTION_STYLE}>
        <h2 id="debug-stack-heading">{t("callStack")}</h2>
        {snapshot.stack === null ? (
          <p>{t("pauseForStack")}</p>
        ) : (
          <CallStack
            frames={snapshot.stack.frames}
            selectedFrameRef={selectedFrame?.frameRef}
            onSelect={selectFrame}
            label={t("callStack")}
          />
        )}
      </section>
      <section aria-labelledby="debug-variables-heading" style={SECTION_STYLE}>
        <h2 id="debug-variables-heading">{t("variables")}</h2>
        {selectedFrame === undefined ? (
          <p>{t("noPausedFrame")}</p>
        ) : (
          <Tree
            rows={rows}
            t={t}
            onExpand={expand}
            onEdit={(row) => {
              if (row.variableRef === undefined) setEditingVariable(null);
              else {
                const value = row.node?.kind === "variable" ? row.node.value.value : "";
                setEditingVariable({ reference: row.variableRef, value });
              }
            }}
          />
        )}
        {editingVariable === null ? null : (
          <fieldset aria-label={t("pausedVariableEditor")} style={GROUP_STYLE}>
            <label htmlFor="debug-variable-value">{t("newVariableValue")}</label>
            <input
              id="debug-variable-value"
              value={editingVariable.value}
              onChange={(event) =>
                setEditingVariable({ ...editingVariable, value: event.target.value })
              }
            />
            <button
              type="button"
              onClick={() => {
                if (session !== null)
                  perform(
                    actions.setVariable(session, editingVariable.reference, editingVariable.value),
                    () => setEditingVariable(null),
                  );
              }}
            >
              {t("save")}
            </button>
            <button type="button" onClick={() => setEditingVariable(null)}>
              {t("cancel")}
            </button>
          </fieldset>
        )}
      </section>
      <WatchEditor
        watches={watches}
        onSave={async (nextWatches) => {
          setActionError(false);
          try {
            await actions.saveWatches(nextWatches);
            return true;
          } catch {
            setActionError(true);
            return false;
          }
        }}
        onEvaluate={evaluateWatch}
        canEvaluate={session?.status === "paused" && selectedFrame !== undefined}
        t={t}
      />
      <section aria-labelledby="debug-console-heading" style={SECTION_STYLE}>
        <h2 id="debug-console-heading">{t("consoleHeading")}</h2>
        <p>{t("consoleHelp")}</p>
        <pre aria-label={t("debugOutput")} style={OUTPUT_STYLE}>
          {snapshot.console.entries.map((entry) => `[${entry.category}] ${entry.text}`).join("\n")}
        </pre>
        <ul aria-label={t("watchResults")}>
          {watches.map((watch) => {
            const result =
              watchResults.get(watch.watchId) ?? snapshot.watchResults.get(watch.watchId);
            return (
              <li key={watch.watchId}>
                <code>{watch.expression}</code>: {result?.value?.value ?? t("notEvaluated")}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
