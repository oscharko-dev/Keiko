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
import type { EditorDocumentSymbol } from "@oscharko-dev/keiko-editor";

import { Icons } from "../../Icons";
import {
  buildEditorOutlineTree,
  findContainingOutlinePath,
  flattenEditorOutlineTree,
  type EditorOutlineNode,
  type EditorOutlineSnapshot,
} from "./editorOutlineModel";
import styles from "./EditorOutline.module.css";

const TREE_NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"]);

interface TreeNavResult {
  readonly focusId?: string | undefined;
  readonly toggleId?: string | undefined;
}

export interface EditorOutlinePanelProps {
  readonly snapshot: EditorOutlineSnapshot | undefined;
  readonly visible: boolean;
  readonly onToggleVisible: () => void;
  readonly onReveal: (symbol: EditorDocumentSymbol) => void;
}

function collectExpandableIds(
  nodes: readonly EditorOutlineNode[],
  out = new Set<string>(),
): Set<string> {
  for (const node of nodes) {
    if (node.children.length > 0) out.add(node.id);
    collectExpandableIds(node.children, out);
  }
  return out;
}

function collectNodeIds(
  nodes: readonly EditorOutlineNode[],
  out: string[] = [],
): readonly string[] {
  for (const node of nodes) {
    out.push(node.id);
    collectNodeIds(node.children, out);
  }
  return out;
}

function treeNavigation(
  visibleNodes: readonly EditorOutlineNode[],
  index: number,
  key: string,
  expandedIds: ReadonlySet<string>,
): TreeNavResult {
  const node = visibleNodes[index];
  if (node === undefined) return {};
  if (key === "ArrowDown") return { focusId: visibleNodes[index + 1]?.id };
  if (key === "ArrowUp") return { focusId: visibleNodes[index - 1]?.id };
  if (key === "Home") return { focusId: visibleNodes[0]?.id };
  if (key === "End") return { focusId: visibleNodes[visibleNodes.length - 1]?.id };
  if (key === "ArrowRight" && node.children.length > 0) {
    return expandedIds.has(node.id)
      ? { focusId: visibleNodes[index + 1]?.id }
      : { toggleId: node.id };
  }
  if (key === "ArrowLeft") {
    if (node.children.length > 0 && expandedIds.has(node.id)) return { toggleId: node.id };
    return { focusId: node.parentId };
  }
  return {};
}

function kindLabel(kind: EditorDocumentSymbol["kind"]): string {
  return kind.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);
}

export function EditorOutlinePanel(props: EditorOutlinePanelProps): ReactNode {
  const snapshot = props.snapshot;
  const tree = useMemo(() => buildEditorOutlineTree(snapshot?.symbols ?? []), [snapshot?.symbols]);
  const allNodeIds = useMemo(() => collectNodeIds(tree), [tree]);
  const treeKey = useMemo(() => allNodeIds.join("|"), [allNodeIds]);
  const containingPath = useMemo(
    () => findContainingOutlinePath(tree, snapshot?.cursor ?? null),
    [snapshot?.cursor, tree],
  );
  const selectedId = containingPath[containingPath.length - 1]?.id ?? null;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() =>
    collectExpandableIds(tree),
  );
  const [focusId, setFocusId] = useState<string | null>(selectedId);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const visibleNodes = useMemo(
    () => flattenEditorOutlineTree(tree, expandedIds),
    [expandedIds, tree],
  );

  useEffect(() => {
    setExpandedIds(collectExpandableIds(tree));
    setFocusId(selectedId ?? allNodeIds[0] ?? null);
  }, [allNodeIds, selectedId, tree, treeKey]);

  const focusRow = useCallback((id: string | undefined): void => {
    if (id === undefined) return;
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  const toggleNode = useCallback((id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, node: EditorOutlineNode): void => {
      if (!TREE_NAV_KEYS.has(event.key)) return;
      event.preventDefault();
      const index = visibleNodes.findIndex((entry) => entry.id === node.id);
      const result = treeNavigation(visibleNodes, index, event.key, expandedIds);
      if (result.toggleId !== undefined) toggleNode(result.toggleId);
      focusRow(result.focusId ?? result.toggleId);
    },
    [expandedIds, focusRow, toggleNode, visibleNodes],
  );

  const hasSymbols = tree.length > 0;
  const emptyText =
    snapshot?.loading === true
      ? "Loading symbols."
      : snapshot?.enabled === false
        ? "Outline is unavailable for this file."
        : "No symbols found in this file.";

  return (
    <section className={styles.outline} aria-label="Workspace outline">
      <div className={styles.outlineHeader}>
        <span className={styles.outlineTitle} title={snapshot?.filePath ?? "Outline"}>
          Outline
        </span>
        <button
          type="button"
          className={styles.outlineToggle}
          aria-label={props.visible ? "Hide outline panel" : "Show outline panel"}
          aria-expanded={props.visible}
          onClick={props.onToggleVisible}
        >
          <span className={styles.outlineToggleIcon} data-open={props.visible} aria-hidden="true">
            <Icons.chevronR size={14} />
          </span>
        </button>
      </div>
      {props.visible ? (
        <div className={styles.outlineBody}>
          {hasSymbols ? (
            <div className={styles.outlineTree} role="tree" aria-label="Current file symbols">
              {visibleNodes.map((node) => {
                const expandable = node.children.length > 0;
                const rowKind = kindLabel(node.symbol.kind);
                return (
                  <button
                    key={node.id}
                    ref={(element) => {
                      if (element === null) rowRefs.current.delete(node.id);
                      else rowRefs.current.set(node.id, element);
                    }}
                    type="button"
                    className={styles.outlineRow}
                    role="treeitem"
                    aria-label={`${node.symbol.name} ${rowKind}`}
                    aria-level={node.depth}
                    aria-selected={node.id === selectedId}
                    aria-expanded={expandable ? expandedIds.has(node.id) : undefined}
                    tabIndex={focusId === node.id ? 0 : -1}
                    style={{ paddingLeft: 6 + (node.depth - 1) * 14 }}
                    onClick={() => props.onReveal(node.symbol)}
                    onKeyDown={(event) => handleKeyDown(event, node)}
                  >
                    <span
                      className={styles.outlineCaret}
                      data-open={expandable && expandedIds.has(node.id)}
                      aria-hidden="true"
                    >
                      {expandable ? <Icons.chevronR size={11} /> : null}
                    </span>
                    <span className={styles.outlineName}>{node.symbol.name}</span>
                    <span className={styles.outlineKind}>{rowKind}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className={styles.outlineEmpty}>{emptyText}</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
