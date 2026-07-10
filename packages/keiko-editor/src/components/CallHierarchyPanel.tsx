"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactElement,
} from "react";
import type { EditorLocation } from "../types.js";
import type { EditorCallHierarchyResponse } from "./call-hierarchy-bridge.js";

export interface CallHierarchyPanelLabels {
  readonly title: string;
  readonly incoming: string;
  readonly outgoing: string;
  readonly callSite: string;
  readonly empty: string;
  readonly close: string;
  readonly command: string;
}

interface TreeRow {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly location: EditorLocation;
}

const TREE_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

function callRows(
  rootIndex: number,
  direction: "incoming" | "outgoing",
  response: EditorCallHierarchyResponse,
  labels: CallHierarchyPanelLabels,
): readonly TreeRow[] {
  const root = response.roots[rootIndex];
  if (root === undefined) return [];
  const calls = direction === "incoming" ? root.incomingCalls : root.outgoingCalls;
  return calls.flatMap((call, callIndex): readonly TreeRow[] => {
    const itemRow: TreeRow = {
      id: `${String(rootIndex)}:${direction}:${String(callIndex)}`,
      label: `${direction === "incoming" ? labels.incoming : labels.outgoing}: ${call.item.name}`,
      level: 2,
      location: { path: call.item.path, range: call.item.selectionRange },
    };
    const sitePath = direction === "incoming" ? call.item.path : root.item.path;
    const sites = call.fromRanges.map((range, siteIndex): TreeRow => ({
      id: `${itemRow.id}:site:${String(siteIndex)}`,
      label: `${labels.callSite} ${String(siteIndex + 1)}`,
      level: 3,
      location: { path: sitePath, range },
    }));
    return [itemRow, ...sites];
  });
}

function treeRows(
  response: EditorCallHierarchyResponse,
  labels: CallHierarchyPanelLabels,
): readonly TreeRow[] {
  return response.roots.flatMap((root, rootIndex): readonly TreeRow[] => [
    {
      id: `root:${String(rootIndex)}`,
      label: root.item.name,
      level: 1,
      location: { path: root.item.path, range: root.item.selectionRange },
    },
    ...callRows(rootIndex, "incoming", response, labels),
    ...callRows(rootIndex, "outgoing", response, labels),
  ]);
}

function useTreeNavigation(rows: readonly TreeRow[]): {
  readonly focusId: string;
  readonly refs: MutableRefObject<Map<string, HTMLButtonElement>>;
  readonly onFocus: (id: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
} {
  const [focusId, setFocusId] = useState(rows[0]?.id ?? "");
  const refs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (rows.length > 0 && !rows.some((row) => row.id === focusId)) {
      setFocusId(rows[0]?.id ?? "");
    }
  }, [focusId, rows]);
  const moveFocus = (index: number): void => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (row === undefined) return;
    setFocusId(row.id);
    refs.current.get(row.id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!TREE_NAV_KEYS.has(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") moveFocus(0);
    else if (event.key === "End") moveFocus(rows.length - 1);
    else moveFocus(index + (event.key === "ArrowDown" ? 1 : -1));
  };
  return { focusId, refs, onFocus: setFocusId, onKeyDown };
}

function HierarchyTree(props: {
  readonly rows: readonly TreeRow[];
  readonly label: string;
  readonly onReveal: (location: EditorLocation) => void;
}): ReactElement {
  const { focusId, refs, onFocus, onKeyDown } = useTreeNavigation(props.rows);
  return (
    <div role="tree" aria-label={props.label}>
      {props.rows.map((row, index) => (
        <button
          key={row.id}
          ref={(element) => {
            if (element === null) refs.current.delete(row.id);
            else refs.current.set(row.id, element);
          }}
          type="button"
          role="treeitem"
          aria-level={row.level}
          tabIndex={focusId === row.id ? 0 : -1}
          style={{
            display: "block",
            width: "100%",
            padding: `4px 8px 4px ${String(8 + row.level * 14)}px`,
            textAlign: "left",
          }}
          onClick={() => {
            props.onReveal(row.location);
          }}
          onFocus={() => {
            onFocus(row.id);
          }}
          onKeyDown={(event) => {
            onKeyDown(event, index);
          }}
        >
          {row.label}
        </button>
      ))}
    </div>
  );
}

export function CallHierarchyPanel(props: {
  readonly response: EditorCallHierarchyResponse;
  readonly labels: CallHierarchyPanelLabels;
  readonly onClose: () => void;
  readonly onReveal: (location: EditorLocation) => void;
}): ReactElement {
  const rows = useMemo(
    () => treeRows(props.response, props.labels),
    [props.labels, props.response],
  );
  return (
    <section
      aria-label={props.labels.title}
      style={{ borderTop: "1px solid var(--ed-border)", maxHeight: "42%", overflow: "auto" }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", padding: "6px 8px" }}>
        <strong>{props.labels.title}</strong>
        <button type="button" aria-label={props.labels.close} onClick={props.onClose}>
          ×
        </button>
      </header>
      {rows.length === 0 ? (
        <p style={{ padding: "0 8px 8px" }}>{props.labels.empty}</p>
      ) : (
        <HierarchyTree rows={rows} label={props.labels.title} onReveal={props.onReveal} />
      )}
    </section>
  );
}
