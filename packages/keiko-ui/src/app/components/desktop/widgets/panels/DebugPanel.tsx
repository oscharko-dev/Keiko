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
  if (key === "End") return ids[ids.length - 1] ?? current;
  if (key === "ArrowUp") return ids[Math.max(0, index - 1)] ?? current;
  return ids[Math.min(ids.length - 1, index + 1)] ?? current;
}

function nodeRows(
  nodes: readonly DebugVariableNode[],
  level: number,
  expanded: ReadonlySet<string>,
  parentId: string,
): readonly TreeRow[] {
  return nodes.flatMap((node, index): readonly TreeRow[] => {
    const id = `${parentId}.${String(index)}`;
    if (node.kind === "truncated") {
      return [
        {
          id,
          parentId,
          label: `More values omitted (${String(node.omittedCount)})`,
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
      ...(isExpanded ? nodeRows(node.children, level + 1, expanded, id) : []),
    ];
  });
}

function scopeRows(
  scopes: readonly { readonly scopeRef: string; readonly name: { readonly value: string } }[],
  nodesByParent: ReadonlyMap<string, { readonly nodes: readonly DebugVariableNode[] }>,
  expanded: ReadonlySet<string>,
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
      ...(isExpanded ? nodeRows(children, 2, expanded, id) : []),
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
    <div role="tree" aria-label="Variables">
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
          {row.expandable ? `${row.expanded ? "▾" : "▸"} ` : ""}
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
  readonly onSave: (watches: readonly WatchExpression[]) => Promise<void>;
  readonly onEvaluate: (watchId: string) => void;
  readonly canEvaluate: boolean;
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
    await props.onSave(next);
    setEditing(null);
  };
  const beginNew = (): void => {
    draftSequence.current += 1;
    begin();
  };
  return (
    <section aria-labelledby="debug-watch-heading" style={SECTION_STYLE}>
      <h2 id="debug-watch-heading">Watch</h2>
      <p>Watches are explicit local-human expressions and may have debuggee side effects.</p>
      {props.watches.map((watch) => (
        <div key={watch.watchId} style={{ display: "flex", gap: "6px" }}>
          <code>{watch.expression}</code>
          <button
            type="button"
            disabled={!props.canEvaluate}
            onClick={() => props.onEvaluate(watch.watchId)}
          >
            {`Evaluate ${watch.expression}`}
          </button>
          <button type="button" onClick={() => begin(watch)}>
            Edit
          </button>
        </div>
      ))}
      {editing === null ? (
        <button type="button" onClick={beginNew}>
          Add watch
        </button>
      ) : (
        <div role="group" aria-label="Watch expression editor">
          <label htmlFor="debug-watch-expression">Watch expression</label>
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
            Save
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      )}
    </section>
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
  const enabled = debugEnabled && workspaceId !== undefined && workspaceId.length > 0;
  const { snapshot, actions } = useDebugSession(workspaceId, enabled);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedFrameRef, setSelectedFrameRef] = useState<string | null>(null);
  const [editingVariable, setEditingVariable] = useState<{
    readonly reference: string;
    readonly value: string;
  } | null>(null);
  const [watchResults, setWatchResults] = useState<ReadonlyMap<string, WatchEvaluationResult>>(
    new Map(),
  );
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
    () => scopeRows(scopes, snapshot.variablesByParent, expanded),
    [expanded, scopes, snapshot.variablesByParent],
  );
  const loadStack = actions.loadStack;
  const loadScopes = actions.loadScopes;

  useEffect(() => {
    if (session?.status === "paused") void loadStack(session);
  }, [loadStack, session]);

  useEffect(() => {
    if (session?.status === "paused" && selectedFrame !== undefined) {
      void loadScopes(session, selectedFrame.frameRef);
    }
  }, [loadScopes, selectedFrame, session]);

  useEffect(() => {
    setWatchResults(new Map());
  }, [session?.pauseGeneration, session?.sessionId]);

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
    if (session !== null) void actions.loadVariables(session, row.variableRef);
  };

  if (!debugEnabled) {
    return (
      <section aria-label="Debug" style={PANEL_STYLE}>
        <p>Debugging is unavailable until enabled by policy.</p>
      </section>
    );
  }
  if (workspaceId === undefined || workspaceId.length === 0) {
    return (
      <section aria-label="Debug" style={PANEL_STYLE}>
        <p>Debugging is unavailable until the host supplies a canonical workspace identity.</p>
      </section>
    );
  }

  const filters = snapshot.instrumentation?.exceptionFilters ?? [];
  const watches = snapshot.instrumentation?.watches ?? [];
  const start = (): void => {
    if (activeFile === undefined || activeFile.length === 0 || activationRevision === undefined)
      return;
    void actions.start({ kind: "file", fileId: activeFile }, activationRevision);
  };
  const control = (action: "next" | "stepIn" | "stepOut" | "stop"): void => {
    if (session === null) return;
    void actions.control(session, action);
  };
  const evaluateWatch = (watchId: string): void => {
    if (session?.status !== "paused" || selectedFrame === undefined) return;
    void actions.evaluateWatch(session, watchId, selectedFrame.frameRef).then((result) => {
      if (result === null) return;
      setWatchResults((current) => new Map(current).set(result.watchId, result));
    });
  };
  return (
    <section aria-label="Debug" style={PANEL_STYLE}>
      <header>
        <h1>Debug</h1>
        <p>{session === null ? "No active debug session." : `Session is ${session.status}.`}</p>
        {session?.status === "paused" && snapshot.stopDescription !== null ? (
          <p role="status">{`Exception: ${snapshot.stopDescription.value}`}</p>
        ) : null}
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
            Start debugging current file
          </button>
        ) : (
          <div role="group" aria-label="Debug controls">
            <button
              type="button"
              disabled={session.status !== "paused"}
              onClick={() => control("next")}
            >
              Step over
            </button>
            <button
              type="button"
              disabled={session.status !== "paused"}
              onClick={() => control("stepIn")}
            >
              Step into
            </button>
            <button
              type="button"
              disabled={session.status !== "paused"}
              onClick={() => control("stepOut")}
            >
              Step out
            </button>
            <button
              type="button"
              disabled={session.status !== "paused" && session.status !== "running"}
              onClick={() => control("stop")}
            >
              Stop debugging
            </button>
          </div>
        )}
      </header>
      <section aria-labelledby="debug-exception-heading" style={SECTION_STYLE}>
        <h2 id="debug-exception-heading">Exception breakpoints</h2>
        {filters.length === 0 ? (
          <p>No exception filters are available.</p>
        ) : (
          filters.map((filter) => (
            <label key={filter.filterId} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={filter.enabled}
                onChange={() => {
                  void actions.saveExceptionFilters(
                    toggleExceptionFilter(filters, filter.filterId),
                  );
                }}
              />
              {filter.filterId}
            </label>
          ))
        )}
      </section>
      <section aria-labelledby="debug-stack-heading" style={SECTION_STYLE}>
        <h2 id="debug-stack-heading">Call stack</h2>
        {snapshot.stack === null ? (
          <p>Pause a session to inspect its stack.</p>
        ) : (
          <div role="listbox" aria-label="Call stack">
            {snapshot.stack.frames.map((frame) => (
              <button
                key={frame.frameRef}
                type="button"
                role="option"
                aria-selected={frame.frameRef === selectedFrame?.frameRef}
                onClick={() => selectFrame(frame)}
              >
                {frame.name.value}
                {frame.sourceFileId === undefined
                  ? ""
                  : ` — ${frame.sourceFileId}:${String(frame.line)}`}
              </button>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="debug-variables-heading" style={SECTION_STYLE}>
        <h2 id="debug-variables-heading">Variables</h2>
        {selectedFrame === undefined ? (
          <p>No paused frame is selected.</p>
        ) : (
          <Tree
            rows={rows}
            onExpand={expand}
            onEdit={(row) =>
              setEditingVariable(
                row.variableRef === undefined
                  ? null
                  : {
                      reference: row.variableRef,
                      value: row.node?.kind === "variable" ? row.node.value.value : "",
                    },
              )
            }
          />
        )}
        {editingVariable === null ? null : (
          <div role="group" aria-label="Paused variable editor">
            <label htmlFor="debug-variable-value">New variable value</label>
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
                  void actions.setVariable(
                    session,
                    editingVariable.reference,
                    editingVariable.value,
                  );
                setEditingVariable(null);
              }}
            >
              Save
            </button>
            <button type="button" onClick={() => setEditingVariable(null)}>
              Cancel
            </button>
          </div>
        )}
      </section>
      <WatchEditor
        watches={watches}
        onSave={actions.saveWatches}
        onEvaluate={evaluateWatch}
        canEvaluate={session?.status === "paused" && selectedFrame !== undefined}
      />
      <section aria-labelledby="debug-console-heading" style={SECTION_STYLE}>
        <h2 id="debug-console-heading">Debug console output</h2>
        <p>Output and registered-watch results only. This console never evaluates typed input.</p>
        <pre aria-label="Debug output" style={OUTPUT_STYLE}>
          {snapshot.console.entries.map((entry) => `[${entry.category}] ${entry.text}`).join("\n")}
        </pre>
        <ul aria-label="Registered watch results">
          {watches.map((watch) => {
            const result =
              watchResults.get(watch.watchId) ?? snapshot.watchResults.get(watch.watchId);
            return (
              <li key={watch.watchId}>
                <code>{watch.expression}</code>: {result?.value?.value ?? "Not evaluated"}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
