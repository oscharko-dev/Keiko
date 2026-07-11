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

async function runQuickAccessSearch(
  root: string,
  query: string,
  signal: AbortSignal,
): Promise<readonly SearchResult[]> {
  const [fileNames, text, symbols] = await Promise.all([
    fetchFilesSearch(root, query, SEARCH_LIMIT, { signal }),
    fetchWorkspaceSearch(
      {
        root,
        query,
        mode: "literal",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
        maxResults: SEARCH_LIMIT,
      },
      { signal },
    ),
    fetchWorkspaceSymbols({ root, query, maxResults: SEARCH_LIMIT }, { signal }),
  ]);
  const files = dedupeFileResults([...fileNameResults(fileNames), ...textFileResults(text)]);
  return [...files, ...symbolResults(symbols)].slice(0, SEARCH_LIMIT);
}

function getEmptyText(mode: QuickAccessMode, root: string | undefined, query: string): string {
  if (mode === "commands") return "No matching commands.";
  if (root === undefined) return "No active workspace root.";
  if (query.trim().length === 0) return "Type to search workspace files and symbols.";
  return "No matching files or symbols.";
}

interface PaletteKeyHandlerParams {
  readonly itemCount: number;
  readonly selected: number;
  readonly setSelected: (updater: (current: number) => number) => void;
  readonly activate: (index: number) => void;
  readonly onClose: () => void;
  readonly focusInput: () => void;
}

function buildPaletteKeyHandlers(params: PaletteKeyHandlerParams): Record<string, () => void> {
  const { itemCount, selected, setSelected, activate, onClose, focusInput } = params;
  return {
    ArrowDown: () => {
      if (itemCount > 0) setSelected((current) => (current + 1) % itemCount);
    },
    ArrowUp: () => {
      if (itemCount > 0) setSelected((current) => (current - 1 + itemCount) % itemCount);
    },
    Enter: () => activate(selected),
    Escape: onClose,
    Tab: focusInput,
  };
}

function renderCommandOptions(
  commands: readonly QuickAccessCommand[],
  selected: number,
  optionId: (index: number) => string,
  onHover: (index: number) => void,
  onActivate: (index: number) => void,
): ReactNode {
  return commands.map((command, index) => (
    <button
      key={command.id}
      type="button"
      id={optionId(index)}
      role="option"
      aria-selected={index === selected}
      className="cmdk-row"
      data-sel={index === selected}
      tabIndex={-1}
      onPointerEnter={() => onHover(index)}
      onClick={() => onActivate(index)}
    >
      <span className="cmdk-label">{command.label}</span>
      <span className="spacer" />
      {command.shortcut !== undefined ? <span className="kbd">{command.shortcut}</span> : null}
      <span className="cmdk-group mono">{command.group}</span>
    </button>
  ));
}

function renderResultOptions(
  results: readonly SearchResult[],
  selected: number,
  optionId: (index: number) => string,
  onHover: (index: number) => void,
  onActivate: (index: number) => void,
): ReactNode {
  return results.map((result, index) => (
    <button
      key={`${result.kind}:${result.path}:${String(result.line)}:${index.toString()}`}
      type="button"
      id={optionId(index)}
      role="option"
      aria-selected={index === selected}
      className="cmdk-row"
      data-sel={index === selected}
      tabIndex={-1}
      onPointerEnter={() => onHover(index)}
      onClick={() => onActivate(index)}
    >
      <span className="cmdk-ico">
        <FileIcon name={result.path} />
      </span>
      <span className="cmdk-label">{result.kind === "symbol" ? result.symbol : result.path}</span>
      <span className="spacer" />
      <span className="cmdk-group mono">
        {result.path}:{String(result.line)}
      </span>
    </button>
  ));
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
      void runQuickAccessSearch(root, trimmed, controller.signal)
        .then((results) => setSearchResults(results))
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
    const handlers = buildPaletteKeyHandlers({
      itemCount,
      selected,
      setSelected,
      activate,
      onClose,
      focusInput: () => inputRef.current?.focus(),
    });
    const handler = handlers[event.key];
    if (handler === undefined) return;
    event.preventDefault();
    handler();
  };

  const optionId = (index: number): string => `${listId}-option-${String(index)}`;
  const emptyText = getEmptyText(mode, root, query);

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
            renderCommandOptions(commandResults, selected, optionId, setSelected, activate)
          ) : (
            renderResultOptions(searchResults, selected, optionId, setSelected, activate)
          )}
        </div>
      </div>
    </div>
  );
}
