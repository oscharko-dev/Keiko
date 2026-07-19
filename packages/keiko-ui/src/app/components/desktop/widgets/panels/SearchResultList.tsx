"use client";

import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { WorkspaceSearchResultMatch } from "@oscharko-dev/keiko-contracts";
import styles from "./SearchPanel.module.css";

export interface RootAwareSearchResult extends WorkspaceSearchResultMatch {
  readonly root: string;
  readonly rootLabel: string;
}

export interface SearchResultGroup {
  readonly root: string;
  readonly rootLabel: string;
  readonly path: string;
  readonly matches: readonly RootAwareSearchResult[];
}

interface SearchResultEntry {
  readonly match: RootAwareSearchResult;
  readonly index: number;
}

interface SearchResultListProps {
  readonly groups: readonly SearchResultGroup[];
  readonly showRootLabels: boolean;
  readonly activeIndex: number;
  readonly onActiveIndexChange: (index: number) => void;
  readonly onOpen: (match: RootAwareSearchResult) => void;
}

function lineLabel(match: WorkspaceSearchResultMatch): string {
  const { startLine, endLine } = match.lineRange;
  return startLine === endLine
    ? `L${String(startLine)}`
    : `L${String(startLine)}-${String(endLine)}`;
}

function entriesFromGroups(groups: readonly SearchResultGroup[]): readonly SearchResultEntry[] {
  return groups.flatMap((group) => group.matches).map((match, index) => ({ match, index }));
}

export function groupSearchResults(
  results: readonly RootAwareSearchResult[],
): readonly SearchResultGroup[] {
  const groups = new Map<string, RootAwareSearchResult[]>();
  for (const result of results) {
    const key = `${result.root}\n${result.path}`;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  return [...groups.values()].map((matches) => ({
    root: matches[0]?.root ?? "",
    rootLabel: matches[0]?.rootLabel ?? "",
    path: matches[0]?.path ?? "",
    matches,
  }));
}

export function SearchResultList({
  groups,
  showRootLabels,
  activeIndex,
  onActiveIndexChange,
  onOpen,
}: SearchResultListProps): ReactNode {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const entries = useMemo(() => entriesFromGroups(groups), [groups]);

  const focusIndex = (index: number): void => {
    onActiveIndexChange(index);
    window.requestAnimationFrame(() => itemRefs.current[index]?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (entries.length === 0) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = entries[activeIndex] ?? entries[0];
      if (entry !== undefined) onOpen(entry.match);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusIndex(Math.min(activeIndex + 1, entries.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusIndex(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusIndex(entries.length - 1);
    }
  };

  return (
    <div
      className={styles.results}
      role="listbox"
      aria-label="Workspace search results"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {groups.map((group) => (
        <section
          className={styles.fileGroup}
          key={`${group.root}:${group.path}`}
          role="group"
          aria-label={showRootLabels ? `${group.rootLabel}: ${group.path}` : group.path}
        >
          <div className={`${styles.fileHeader} mono`}>
            {showRootLabels ? <span className={styles.rootLabel}>{group.rootLabel}</span> : null}
            {group.path}
          </div>
          {group.matches.map((match) => {
            const entry = entries.find((candidate) => candidate.match === match);
            const index = entry?.index ?? 0;
            return (
              <button
                className={styles.match}
                key={`${match.path}:${match.lineRange.startLine}:${match.lineRange.endLine}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                tabIndex={index === activeIndex ? 0 : -1}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                onFocus={() => onActiveIndexChange(index)}
                onClick={() => onOpen(match)}
              >
                <span className={`${styles.lineBadge} mono`}>{lineLabel(match)}</span>
                <pre className={styles.snippet}>{match.snippet}</pre>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
