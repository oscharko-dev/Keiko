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
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../hooks/useWorkspace.types";
import { FileIcon } from "../widgets/shared/projectTree";
import { fuzzyScore } from "../widgets/cards/editorCommands";
import type { QuickAccessCommand } from "../quickAccessRegistry";
import { requestWorkspaceRoots, type WorkspaceRootTarget } from "../workspaceRootTargets";

const SEARCH_DEBOUNCE_MS = 120;
const SEARCH_LIMIT = 30;

type QuickAccessMode = "files" | "commands";

interface FileResult {
  readonly kind: "file";
  readonly root: string;
  readonly rootLabel: string;
  readonly path: string;
  readonly line: number;
  readonly snippet: string;
}

interface SymbolResult {
  readonly kind: "symbol";
  readonly root: string;
  readonly rootLabel: string;
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
  readonly roots?: readonly WorkspaceRootTarget[] | undefined;
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
    const key = `${result.root}\n${result.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

function fileNameResults(
  target: WorkspaceRootTarget,
  response: FileNameSearchResponse,
): readonly FileResult[] {
  return response.results.map((result) => ({
    kind: "file",
    root: target.root,
    rootLabel: target.label,
    path: result.path,
    line: 1,
    snippet: result.directory.length === 0 ? result.name : `${result.directory}/${result.name}`,
  }));
}

function textFileResults(
  target: WorkspaceRootTarget,
  response: WorkspaceTextSearchResponse,
): readonly FileResult[] {
  return response.results.map((result) => ({
    kind: "file",
    root: target.root,
    rootLabel: target.label,
    path: result.path,
    line: result.lineRange.startLine,
    snippet: result.snippet,
  }));
}

function symbolResults(
  target: WorkspaceRootTarget,
  response: WorkspaceSymbolSearchResponse,
): readonly SymbolResult[] {
  return response.results.map((result) => ({
    kind: "symbol",
    root: target.root,
    rootLabel: target.label,
    path: result.path,
    line: result.line,
    symbol: result.symbol,
    detail: result.enclosingSymbol ?? result.kind,
  }));
}

interface QuickAccessRootResponse {
  readonly files: readonly FileResult[];
  readonly symbols: readonly SymbolResult[];
}

function quickAccessTargets(
  root: string | undefined,
  roots: readonly WorkspaceRootTarget[] | undefined,
): readonly WorkspaceRootTarget[] {
  if (roots !== undefined && roots.length > 0) return roots;
  return root === undefined ? [] : [{ id: root, root, label: root }];
}

function quickAccessSearchText(result: SearchResult): string {
  return result.kind === "symbol"
    ? `${result.symbol} ${result.path} ${result.detail}`
    : `${result.path} ${result.snippet}`;
}

function rankedResults(
  query: string,
  responses: readonly QuickAccessRootResponse[],
): readonly SearchResult[] {
  const results = responses.flatMap((response) => [...response.files, ...response.symbols]);
  return results
    .map((result, index) => ({
      result,
      index,
      score: fuzzyScore(query, quickAccessSearchText(result)) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ result }) => result)
    .slice(0, SEARCH_LIMIT);
}

async function searchQuickAccessRoot(
  target: WorkspaceRootTarget,
  query: string,
  signal: AbortSignal,
): Promise<QuickAccessRootResponse> {
  const [fileNames, text, symbols] = await Promise.all([
    fetchFilesSearch(target.root, query, SEARCH_LIMIT, { signal }),
    fetchWorkspaceSearch(
      {
        root: target.root,
        query,
        mode: "literal",
        caseSensitive: false,
        includeGlobs: [],
        excludeGlobs: [],
        maxResults: SEARCH_LIMIT,
      },
      { signal },
    ),
    fetchWorkspaceSymbols({ root: target.root, query, maxResults: SEARCH_LIMIT }, { signal }),
  ]);
  return {
    files: dedupeFileResults([
      ...fileNameResults(target, fileNames),
      ...textFileResults(target, text),
    ]),
    symbols: symbolResults(target, symbols),
  };
}

function quickAccessEmptyText(
  t: OptionalWidgetTranslate,
  mode: QuickAccessMode,
  root: string | undefined,
  query: string,
): string {
  if (mode === "commands") return t("quickAccess.empty.commands");
  if (root === undefined) return t("quickAccess.empty.noRoot");
  return query.trim().length === 0
    ? t("quickAccess.empty.startSearch")
    : t("quickAccess.empty.files");
}

export function UnifiedQuickAccessPalette({
  initialMode,
  root,
  roots,
  commands,
  openEditorFile,
  onClose,
}: UnifiedQuickAccessPaletteProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const [query, setQuery] = useState(initialMode === "commands" ? ">" : "");
  const [searchResults, setSearchResults] = useState<readonly SearchResult[]>([]);
  const [failedRoots, setFailedRoots] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const openerRef = useRef<HTMLElement | null>(
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const mode: QuickAccessMode = query.startsWith(">") ? "commands" : "files";
  const commandQuery = query.startsWith(">") ? query.slice(1).trim() : "";
  const targets = useMemo(() => quickAccessTargets(root, roots), [root, roots]);
  const multiRoot = targets.length > 1;

  useEffect(() => {
    const opener = openerRef.current;
    inputRef.current?.focus();
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (mode !== "files" || targets.length === 0 || query.trim().length === 0) {
      setSearchResults([]);
      setFailedRoots([]);
      return;
    }
    const controller = new AbortController();
    const trimmed = query.trim();
    const handle = setTimeout(() => {
      void requestWorkspaceRoots(targets, (target) =>
        searchQuickAccessRoot(target, trimmed, controller.signal),
      )
        .then((outcomes) => {
          if (controller.signal.aborted) return;
          const responses = outcomes.flatMap((outcome) =>
            outcome.status === "success" ? [outcome.value] : [],
          );
          setFailedRoots(
            outcomes.flatMap((outcome) =>
              outcome.status === "error" ? [outcome.target.label] : [],
            ),
          );
          setSearchResults(rankedResults(trimmed, responses));
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setFailedRoots([]);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [mode, query, targets]);

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
      if (result === undefined) return;
      openEditorFile({
        root: result.root,
        path: result.path,
        lineStart: result.line,
        lineEnd: result.line,
      });
      onClose();
    },
    [commandResults, mode, onClose, openEditorFile, searchResults],
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
  const emptyText = quickAccessEmptyText(t, mode, root, query);
  const resultKey = itemCount === 1 ? "quickAccess.result.singular" : "quickAccess.result.plural";

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
          {t("quickAccess.title")}
        </h2>
        <p id="quick-access-desc" className="sr-only">
          {t("quickAccess.description")}
        </p>
        <div className="cmdk-input">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={itemCount > 0 ? optionId(selected) : undefined}
            aria-label={
              mode === "commands" ? t("quickAccess.query.commands") : t("quickAccess.query.files")
            }
            placeholder={
              mode === "commands"
                ? t("quickAccess.placeholder.commands")
                : t("quickAccess.placeholder.files")
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
          {itemCount === 0 ? emptyText : t(resultKey, { count: itemCount })}
        </div>
        {failedRoots.length > 0 ? (
          <div className="cmdk-empty" role="alert">
            Search unavailable for {failedRoots.join(", ")}.
          </div>
        ) : null}
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
                key={`${result.root}:${result.kind}:${result.path}:${String(result.line)}:${index.toString()}`}
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
                  {multiRoot ? `${result.rootLabel} · ` : ""}
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
