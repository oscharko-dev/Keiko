"use client";

import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ProjectWithAvailability } from "@/lib/types";
import { Icons } from "../../../Icons";
import {
  EMPTY_STATE_STYLE,
  INPUT_STYLE,
  LIST_STYLE,
  MONO_PATH_STYLE,
  REPO_OPTION_SELECTED_STYLE,
  REPO_OPTION_STYLE,
  SEARCH_ROW_STYLE,
  SECONDARY_BTN,
  SUBTLE_TEXT_STYLE,
} from "./git-client-styles";

interface RepositoryListSearchProps {
  readonly repositories: readonly ProjectWithAvailability[];
  readonly selectedPath: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onSelect: (path: string) => void;
  readonly onAddRepository: () => void;
}

function matches(repo: ProjectWithAvailability, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return repo.name.toLowerCase().includes(needle) || repo.path.toLowerCase().includes(needle);
}

export function RepositoryListSearch({
  repositories,
  selectedPath,
  loading,
  error,
  onSelect,
  onAddRepository,
}: RepositoryListSearchProps): ReactNode {
  const [query, setQuery] = useState("");
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const filtered = useMemo(
    () => repositories.filter((repo) => matches(repo, query)),
    [repositories, query],
  );
  const activeIndex = filtered.findIndex((repo) => repo.path === selectedPath);

  const focusOption = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, filtered.length - 1));
    optionRefs.current[clamped]?.focus();
  };

  const onOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusOption(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusOption(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusOption(filtered.length - 1);
    }
  };

  return (
    <>
      <div style={SEARCH_ROW_STYLE}>
        <input
          style={INPUT_STYLE}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search repositories"
          placeholder="Search repositories"
        />
        <button
          type="button"
          style={SECONDARY_BTN}
          onClick={onAddRepository}
          aria-label="Add repository"
          title="Add repository"
        >
          <Icons.plus size={13} />
        </button>
      </div>
      {error !== null ? (
        <p role="alert" style={{ ...SUBTLE_TEXT_STYLE, padding: "var(--space-4)" }}>
          {error}
        </p>
      ) : null}
      {loading && repositories.length === 0 ? (
        <p role="status" style={{ ...SUBTLE_TEXT_STYLE, padding: "var(--space-4)" }}>
          Loading repositories…
        </p>
      ) : null}
      {!loading && repositories.length === 0 && error === null ? (
        <div style={EMPTY_STATE_STYLE}>
          <Icons.git size={20} />
          <p style={SUBTLE_TEXT_STYLE}>No repositories yet. Add a repository to begin.</p>
        </div>
      ) : (
        <div style={LIST_STYLE} role="listbox" aria-label="Repositories">
          {filtered.map((repo, index) => {
            const selected = repo.path === selectedPath;
            return (
              <button
                key={repo.path}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={index === Math.max(activeIndex, 0) ? 0 : -1}
                style={{
                  ...REPO_OPTION_STYLE,
                  ...(selected ? REPO_OPTION_SELECTED_STYLE : {}),
                }}
                title={repo.path}
                onClick={() => onSelect(repo.path)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
              >
                <span
                  style={{
                    display: "block",
                    font: "var(--weight-semibold) var(--text-body-sm) var(--font-ui)",
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {repo.name}
                </span>
                <code style={MONO_PATH_STYLE}>{repo.path}</code>
              </button>
            );
          })}
          {filtered.length === 0 ? (
            <p style={{ ...SUBTLE_TEXT_STYLE, padding: "var(--space-3) var(--space-4)" }}>
              No repositories match the search.
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}
