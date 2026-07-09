"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  WORKSPACE_REPLACE_MAX_FILES,
  WORKSPACE_SEARCH_MAX_RESULTS,
  type WorkspaceReplaceApplyConflict,
  type WorkspaceReplaceApplyFile,
  type WorkspaceSearchMode,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
  type WorkspaceSearchResultMatch,
  type WorkspaceReplacePreviewFileEdit,
  type WorkspaceReplacePreviewResponse,
  type WorkspaceSymbolSearchResponse,
} from "@oscharko-dev/keiko-contracts";
import type { PatchPreviewModel, PatchPreviewSource } from "@oscharko-dev/keiko-editor";
import {
  applyWorkspaceReplace,
  fetchFilesContent,
  fetchWorkspaceReplacePreview,
  fetchWorkspaceSearch,
  fetchWorkspaceSymbols,
} from "@/lib/api";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../../hooks/useWorkspace.types";
import { Icons } from "../../Icons";
import { useOptionalChatSessionCatalog } from "../../context/ChatSessionContext";
import { useWorkspaceReplaceBuffers } from "../../WorkspaceReplaceBufferContext";
import { SearchResultList, groupSearchResults, type SearchResultGroup } from "./SearchResultList";
import { WORKSPACE_SEARCH_FOCUS_EVENT } from "./searchPanelEvents";
import styles from "./SearchPanel.module.css";
import EditorDiffSurface, { buildWorkspaceReplacePatchModel } from "../cards/EditorDiffSurface";

const SEARCH_DEBOUNCE_MS = 250;

interface SearchPanelProps {
  readonly root?: string | undefined;
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
}

type SearchStatus = "idle" | "loading" | "ready" | "error";
type SearchDomain = "text" | "symbols";
function globArray(value: string): readonly string[] {
  const trimmed = value.trim();
  return trimmed.length === 0 ? [] : [trimmed];
}

function regexSyntaxError(query: string, mode: WorkspaceSearchMode): string | null {
  if (mode !== "regex" || query.trim().length === 0) return null;
  try {
    new RegExp(query);
    return null;
  } catch {
    return "The regular expression is not valid.";
  }
}

function requestFromState(args: {
  readonly root: string;
  readonly query: string;
  readonly mode: WorkspaceSearchMode;
  readonly caseSensitive: boolean;
  readonly includeText: string;
  readonly excludeText: string;
}): WorkspaceSearchRequest {
  return {
    root: args.root,
    query: args.query.trim(),
    mode: args.mode,
    caseSensitive: args.caseSensitive,
    includeGlobs: globArray(args.includeText),
    excludeGlobs: globArray(args.excludeText),
    maxResults: WORKSPACE_SEARCH_MAX_RESULTS,
  };
}

function statusMessage(args: {
  readonly root: string | undefined;
  readonly query: string;
  readonly status: SearchStatus;
  readonly response: WorkspaceSearchResponse | null;
  readonly error: string | null;
}): string {
  if (args.root === undefined) return "Select a workspace before searching.";
  if (args.query.trim().length === 0) return "Enter a query to search the active workspace.";
  if (args.error !== null) return args.error;
  if (args.status === "loading") return "Searching workspace...";
  if (args.response === null) return "Ready to search.";
  if (args.response.results.length === 0) return "No matching files found.";
  const suffix = args.response.truncated ? " Results were capped; refine the query." : "";
  return `${String(args.response.results.length)} matches in ${String(args.response.filesScanned)} files scanned.${suffix}`;
}

function resultGroups(response: WorkspaceSearchResponse | null): readonly SearchResultGroup[] {
  return response === null ? [] : groupSearchResults(response.results);
}

function symbolResponseToSearchResponse(
  response: WorkspaceSymbolSearchResponse,
): WorkspaceSearchResponse {
  return {
    results: response.results.map((result) => ({
      path: result.path,
      lineRange: { startLine: result.line, endLine: result.line },
      snippet: `${result.kind} ${result.symbol}${
        result.enclosingSymbol === undefined ? "" : ` in ${result.enclosingSymbol}`
      }`,
      score: result.score,
    })),
    truncated: response.truncated,
    filesScanned: response.filesScanned,
    elapsedMs: response.elapsedMs,
  };
}

async function sourcesForPreview(
  root: string,
  files: readonly WorkspaceReplacePreviewFileEdit[],
): Promise<Readonly<Record<string, PatchPreviewSource>>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const content = await fetchFilesContent(root, file.path);
      return [
        file.path,
        {
          content: {
            relativePath: file.path,
            sizeBytes: content.sizeBytes,
            text: content.content,
            truncated: false,
          },
        } satisfies PatchPreviewSource,
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function replaceSummary(response: WorkspaceReplacePreviewResponse | null): string {
  if (response === null) return "No replace preview has been computed.";
  const omitted =
    response.omittedFileCount > 0 ? ` ${String(response.omittedFileCount)} files omitted.` : "";
  return `${String(response.editCount)} replacements across ${String(response.fileCount)} files.${omitted}`;
}

function replaceErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function conflictSummary(conflicts: readonly WorkspaceReplaceApplyConflict[]): string {
  if (conflicts.length === 0) return "";
  const listed = conflicts
    .slice(0, 3)
    .map((conflict) => `${conflict.path} (${conflict.reason})`)
    .join(", ");
  const remaining = conflicts.length > 3 ? `, ${String(conflicts.length - 3)} more` : "";
  return ` Conflicts: ${listed}${remaining}.`;
}

async function applyReviewedReplace(args: {
  readonly root: string;
  readonly files: readonly WorkspaceReplaceApplyFile[];
  readonly openBuffers: ReturnType<typeof useWorkspaceReplaceBuffers>;
}): Promise<{
  readonly appliedCount: number;
  readonly conflictCount: number;
  readonly conflicts: readonly WorkspaceReplaceApplyConflict[];
}> {
  const closedFiles: WorkspaceReplaceApplyFile[] = [];
  const conflicts: WorkspaceReplaceApplyConflict[] = [];
  let openAppliedCount = 0;
  for (const file of args.files) {
    const openResult =
      args.openBuffers === null
        ? { status: "not-open" as const }
        : await args.openBuffers.apply(args.root, file);
    if (openResult.status === "applied") openAppliedCount += 1;
    else if (openResult.status === "conflict") conflicts.push(openResult.conflict);
    else closedFiles.push(file);
  }
  const closedResult =
    closedFiles.length === 0
      ? { appliedCount: 0, conflictCount: 0, conflicts: [] }
      : await applyWorkspaceReplace({ root: args.root, files: closedFiles });
  return {
    appliedCount: openAppliedCount + closedResult.appliedCount,
    conflictCount: conflicts.length + closedResult.conflictCount,
    conflicts: [...conflicts, ...closedResult.conflicts],
  };
}

export function SearchPanel({ root, openEditorFile }: SearchPanelProps): ReactNode {
  const catalog = useOptionalChatSessionCatalog();
  const openBuffers = useWorkspaceReplaceBuffers();
  const selectedRoot = root ?? catalog?.activeProject?.path;
  const projectName = catalog?.activeProject?.name ?? "No project selected";
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [searchDomain, setSearchDomain] = useState<SearchDomain>("text");
  const [mode, setMode] = useState<WorkspaceSearchMode>("literal");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [response, setResponse] = useState<WorkspaceSearchResponse | null>(null);
  const [replaceResponse, setReplaceResponse] = useState<WorkspaceReplacePreviewResponse | null>(
    null,
  );
  const [patchModel, setPatchModel] = useState<PatchPreviewModel | null>(null);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [replaceStatus, setReplaceStatus] = useState("Preview replace before applying changes.");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [applyingReplace, setApplyingReplace] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const controlsId = useId();
  const inlineError = searchDomain === "text" ? regexSyntaxError(query, mode) : null;
  const groups = useMemo(() => resultGroups(response), [response]);
  const message = statusMessage({
    root: selectedRoot,
    query,
    status,
    response,
    error: inlineError ?? routeError,
  });
  const showReplaceStatus = replaceStatus !== "Preview replace before applying changes.";

  useEffect(() => {
    const focusSearch = (): void => queryInputRef.current?.focus();
    window.addEventListener(WORKSPACE_SEARCH_FOCUS_EVENT, focusSearch);
    return () => window.removeEventListener(WORKSPACE_SEARCH_FOCUS_EVENT, focusSearch);
  }, []);

  const runSearch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (selectedRoot === undefined || query.trim().length === 0 || inlineError !== null) return;
      setStatus("loading");
      setRouteError(null);
      try {
        const next =
          searchDomain === "symbols"
            ? symbolResponseToSearchResponse(
                await fetchWorkspaceSymbols(
                  {
                    root: selectedRoot,
                    query: query.trim(),
                    maxResults: WORKSPACE_SEARCH_MAX_RESULTS,
                  },
                  signal === undefined ? undefined : { signal },
                ),
              )
            : await fetchWorkspaceSearch(
                requestFromState({
                  root: selectedRoot,
                  query,
                  mode,
                  caseSensitive,
                  includeText,
                  excludeText,
                }),
                signal === undefined ? undefined : { signal },
              );
        setResponse(next);
        setActiveIndex(0);
        setStatus("ready");
      } catch (error) {
        if (signal?.aborted === true) return;
        setRouteError(error instanceof Error ? error.message : "Workspace search failed.");
        setResponse(null);
        setStatus("error");
      }
    },
    [caseSensitive, excludeText, includeText, inlineError, mode, query, searchDomain, selectedRoot],
  );

  useEffect(() => {
    if (query.trim().length === 0 || inlineError !== null || selectedRoot === undefined) {
      setResponse(null);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void runSearch(controller.signal), SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [inlineError, query, runSearch, selectedRoot]);

  const openMatch = useCallback(
    (match: WorkspaceSearchResultMatch): void => {
      if (selectedRoot === undefined || openEditorFile === undefined) return;
      openEditorFile({
        root: selectedRoot,
        path: match.path,
        lineStart: match.lineRange.startLine,
        lineEnd: match.lineRange.endLine,
      });
    },
    [openEditorFile, selectedRoot],
  );

  const previewReplace = useCallback(async (): Promise<void> => {
    if (selectedRoot === undefined || query.trim().length === 0 || inlineError !== null) return;
    setReplaceStatus("Computing replace preview...");
    try {
      const preview = await fetchWorkspaceReplacePreview({
        root: selectedRoot,
        query: query.trim(),
        mode,
        caseSensitive,
        includeGlobs: globArray(includeText),
        excludeGlobs: globArray(excludeText),
        replacement,
        maxFiles: WORKSPACE_REPLACE_MAX_FILES,
      });
      const sources = await sourcesForPreview(selectedRoot, preview.files);
      setReplaceResponse(preview);
      setPatchModel(buildWorkspaceReplacePatchModel(preview, sources));
      setReplaceStatus(replaceSummary(preview));
    } catch (error) {
      setReplaceResponse(null);
      setPatchModel(null);
      setReplaceStatus(replaceErrorMessage(error, "Replace preview failed."));
    }
  }, [
    caseSensitive,
    excludeText,
    includeText,
    inlineError,
    mode,
    query,
    replacement,
    selectedRoot,
  ]);

  const applyReplacePreview = useCallback(async (): Promise<void> => {
    if (selectedRoot === undefined || replaceResponse === null) return;
    setApplyingReplace(true);
    try {
      const result = await applyReviewedReplace({
        root: selectedRoot,
        openBuffers,
        files: replaceResponse.files,
      });
      const suffix =
        result.conflictCount > 0
          ? ` ${String(result.conflictCount)} files reported conflicts.${conflictSummary(
              result.conflicts,
            )}`
          : "";
      setReplaceStatus(`${String(result.appliedCount)} files applied.${suffix}`);
    } catch (error) {
      setReplaceStatus(replaceErrorMessage(error, "Workspace replace apply failed."));
    } finally {
      setApplyingReplace(false);
    }
  }, [openBuffers, replaceResponse, selectedRoot]);

  return (
    <div className={`srch ${styles.panel}`}>
      <form
        className={styles.controls}
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div className="srch-box">
          <Icons.search size={15} aria-hidden="true" />
          <input
            ref={queryInputRef}
            type="search"
            aria-label="Search files and symbols"
            aria-describedby={controlsId}
            placeholder="Search workspace files"
            value={query}
            disabled={selectedRoot === undefined}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="tw-label srch-label">
          {projectName} <span className="srch-meta mono">workspace search</span>
        </div>
        <div className={styles.controlRow}>
          <div className={styles.modeGroup} aria-label="Search domain">
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={searchDomain === "text"}
              onClick={() => setSearchDomain("text")}
            >
              Text
            </button>
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={searchDomain === "symbols"}
              onClick={() => setSearchDomain("symbols")}
            >
              Symbols
            </button>
          </div>
          <div className={styles.modeGroup} aria-label="Search mode">
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={mode === "literal"}
              onClick={() => setMode("literal")}
            >
              Literal
            </button>
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={mode === "regex"}
              onClick={() => setMode("regex")}
            >
              Regex
            </button>
          </div>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            Case sensitive
          </label>
        </div>
        <div className={styles.globGrid}>
          <label className={styles.fieldLabel}>
            Include glob
            <input
              className={`${styles.globInput} mono`}
              value={includeText}
              placeholder="src/**/*.ts"
              onChange={(event) => setIncludeText(event.target.value)}
            />
          </label>
          <label className={styles.fieldLabel}>
            Exclude glob
            <input
              className={`${styles.globInput} mono`}
              value={excludeText}
              placeholder="dist/**"
              onChange={(event) => setExcludeText(event.target.value)}
            />
          </label>
        </div>
        <label className={styles.fieldLabel}>
          Replacement
          <input
            className={`${styles.globInput} mono`}
            value={replacement}
            placeholder="Replacement text"
            onChange={(event) => setReplacement(event.target.value)}
          />
        </label>
        <button
          className={styles.modeButton}
          type="button"
          disabled={selectedRoot === undefined || query.trim().length === 0 || inlineError !== null}
          onClick={() => void previewReplace()}
        >
          Preview replace
        </button>
      </form>
      <div
        id={controlsId}
        className={`${styles.status} ${(inlineError ?? routeError) ? styles.error : ""}`}
        role="status"
      >
        {message}
      </div>
      {showReplaceStatus ? (
        <div className={styles.status} role="status">
          {replaceStatus}
        </div>
      ) : null}
      {groups.length > 0 ? (
        <SearchResultList
          groups={groups}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onOpen={openMatch}
        />
      ) : null}
      {patchModel === null ? null : (
        <div className={styles.replaceReview}>
          <EditorDiffSurface
            model={patchModel}
            loadState={{ status: "ready" }}
            actions={{ canApply: true, canReject: false, canRunVerification: false }}
            onApply={() => void applyReplacePreview()}
          />
          <button
            className={styles.modeButton}
            type="button"
            disabled={applyingReplace || replaceResponse === null}
            onClick={() => void applyReplacePreview()}
          >
            Apply reviewed replace
          </button>
        </div>
      )}
    </div>
  );
}
