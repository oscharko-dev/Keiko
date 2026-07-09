"use client";

/**
 * App-wide quick access surface. Plain input searches workspace filenames, text, and symbols; a
 * leading `>` switches the same input into command mode.
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { fetchFilesSearch, fetchWorkspaceSearch, fetchWorkspaceSymbols } from "@/lib/api";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../hooks/useWorkspace.types";
import { FileIcon } from "../widgets/shared/projectTree";
import type { QuickAccessCommand } from "../quickAccessRegistry";

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 30;

type QuickAccessMode = "files" | "commands";

interface FileResult {
  readonly kind: "file";
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

interface SymbolResult {
  readonly kind: "symbol";
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly detail: string;
}

type SearchResult = FileResult | SymbolResult;
type FileNameSearchResponse = Awaited<ReturnType<typeof fetchFilesSearch>>;
type WorkspaceTextSearchResponse = Awaited<ReturnType<typeof fetchWorkspaceSearch>>;
type WorkspaceSymbolSearchResponse = Awaited<ReturnType<typeof fetchWorkspaceSymbols>>;

interface UnifiedQuickAccessPaletteProps {
  readonly initialMode: QuickAccessMode;
  readonly root?: string | undefined;
  readonly commands: readonly QuickAccessCommand[];
  readonly openEditorFile: (request: OpenEditorFileRequest) => OpenEditorFileResult;
  readonly onClose: () => void;
}

function commandMatches(command: QuickAccessCommand, query: string): boolean {
  const needle = query.toLowerCase();
  return `${command.label} ${command.group} ${command.id}`.toLowerCase().includes(needle);
}

function dedupeFileResults(results: readonly FileResult[]): readonly FileResult[] {
  const seen = new Set<string>();
  const out: FileResult[] = [];
  for (const result of results) {
    if (seen.has(result.path)) continue;
    seen.add(result.path);
    out.push(result);
  }
  return out;
}

function fileNameResults(response: FileNameSearchResponse): readonly FileResult[] {
  return response.results.map((result) => ({
    kind: "file",
    path: result.path,
    line: 1,
    snippet: result.directory.length === 0 ? result.name : `${result.directory}/${result.name}`,
  }));
}

function textFileResults(response: WorkspaceTextSearchResponse): readonly FileResult[] {
  return response.results.map((result) => ({
    kind: "file",
    path: result.path,
    line: result.lineRange.startLine,
    snippet: result.snippet,
  }));
}

function symbolResults(response: WorkspaceSymbolSearchResponse): readonly SymbolResult[] {
  return response.results.map((result) => ({
    kind: "symbol",
    path: result.path,
    line: result.line,
    symbol: result.symbol,
    detail: result.enclosingSymbol ?? result.kind,
  }));
}

export function UnifiedQuickAccessPalette({
  initialMode,
  root,
  commands,
  openEditorFile,
  onClose,
}: UnifiedQuickAccessPaletteProps): ReactNode {
  const [query, setQuery] = useState(initialMode === "commands" ? ">" : "");
  const [searchResults, setSearchResults] = useState<readonly SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const mode: QuickAccessMode = query.startsWith(">") ? "commands" : "files";
  const commandQuery = query.startsWith(">") ? query.slice(1).trim() : "";

  useEffect(() => {
    const opener = openerRef.current;
    inputRef.current?.focus();
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (mode !== "files" || root === undefined || query.trim().length === 0) {
      setSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const trimmed = query.trim();
    const handle = setTimeout(() => {
      void Promise.all([
        fetchFilesSearch(root, trimmed, SEARCH_LIMIT, { signal: controller.signal }),
        fetchWorkspaceSearch(
          {
            root,
            query: trimmed,
            mode: "literal",
            caseSensitive: false,
            includeGlobs: [],
            excludeGlobs: [],
            maxResults: SEARCH_LIMIT,
          },
          { signal: controller.signal },
        ),
        fetchWorkspaceSymbols(
          { root, query: trimmed, maxResults: SEARCH_LIMIT },
          {
            signal: controller.signal,
          },
        ),
      ])
        .then(([fileNames, text, symbols]) => {
          const files = dedupeFileResults([
            ...fileNameResults(fileNames),
            ...textFileResults(text),
          ]);
          setSearchResults([...files, ...symbolResults(symbols)].slice(0, SEARCH_LIMIT));
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearchResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [mode, query, root]);

  const commandResults = useMemo(
    () =>
      commandQuery.length === 0
        ? commands
        : commands.filter((command) => commandMatches(command, commandQuery)),
    [commandQuery, commands],
  );
  const itemCount = mode === "commands" ? commandResults.length : searchResults.length;

  useEffect(() => {
    setSelected(0);
  }, [commandResults, searchResults]);

  const activate = useCallback(
    (index: number): void => {
      if (mode === "commands") {
        const command = commandResults[index];
        if (command === undefined) return;
        command.run();
        onClose();
        return;
      }
      const result = searchResults[index];
      if (result === undefined || root === undefined) return;
      openEditorFile({
        root,
        path: result.path,
        lineStart: result.line,
        lineEnd: result.line,
      });
      onClose();
    },
    [commandResults, mode, onClose, openEditorFile, root, searchResults],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (itemCount > 0) setSelected((current) => (current + 1) % itemCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (itemCount > 0) setSelected((current) => (current - 1 + itemCount) % itemCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(selected);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
      inputRef.current?.focus();
    }
  };

  const optionId = (index: number): string => `${listId}-option-${String(index)}`;
  const emptyText =
    mode === "commands"
      ? "No matching commands."
      : root === undefined
        ? "No active workspace root."
        : query.trim().length === 0
          ? "Type to search workspace files and symbols."
          : "No matching files or symbols.";

  return (
    <div className="cmdk-overlay" onPointerDown={onClose}>
      <div
        ref={dialogRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-access-title"
        aria-describedby="quick-access-desc"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2 id="quick-access-title" className="sr-only">
          Quick access
        </h2>
        <p id="quick-access-desc" className="sr-only">
          Search workspace files and symbols, or prefix the query with greater-than to run commands.
        </p>
        <div className="cmdk-input">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={itemCount > 0 ? optionId(selected) : undefined}
            aria-label={
              mode === "commands"
                ? "Command query"
                : "Workspace file or symbol query. Prefix with greater-than for commands"
            }
            placeholder={
              mode === "commands"
                ? "Run a command..."
                : "Search files and symbols...  (prefix with > for commands)"
            }
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="sr-only" role="status">
          {itemCount === 0 ? emptyText : `${String(itemCount)} result${itemCount === 1 ? "" : "s"}`}
        </div>
        <div id={listId} role="listbox" className="cmdk-list">
          {itemCount === 0 ? (
            <div className="cmdk-empty">{emptyText}</div>
          ) : mode === "commands" ? (
            commandResults.map((command, index) => (
              <button
                key={command.id}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === selected}
                className="cmdk-row"
                data-sel={index === selected}
                tabIndex={-1}
                onPointerEnter={() => setSelected(index)}
                onClick={() => activate(index)}
              >
                <span className="cmdk-label">{command.label}</span>
                <span className="spacer" />
                {command.shortcut !== undefined ? (
                  <span className="kbd">{command.shortcut}</span>
                ) : null}
                <span className="cmdk-group mono">{command.group}</span>
              </button>
            ))
          ) : (
            searchResults.map((result, index) => (
              <button
                key={`${result.kind}:${result.path}:${String(result.line)}:${index.toString()}`}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === selected}
                className="cmdk-row"
                data-sel={index === selected}
                tabIndex={-1}
                onPointerEnter={() => setSelected(index)}
                onClick={() => activate(index)}
              >
                <span className="cmdk-ico">
                  <FileIcon name={result.path} />
                </span>
                <span className="cmdk-label">
                  {result.kind === "symbol" ? result.symbol : result.path}
                </span>
                <span className="spacer" />
                <span className="cmdk-group mono">
                  {result.path}:{String(result.line)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
