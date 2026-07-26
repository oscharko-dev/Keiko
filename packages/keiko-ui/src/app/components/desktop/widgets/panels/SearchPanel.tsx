"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  WORKSPACE_REPLACE_MAX_FILES,
  WORKSPACE_SEARCH_MAX_RESULTS,
  type WorkspaceReplaceApplyConflict,
  type WorkspaceReplaceApplyFile,
  type WorkspaceReplacePreviewFileEdit,
  type WorkspaceReplacePreviewResponse,
  type WorkspaceSearchMode,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResponse,
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
import {
  useOptionalWidgetTranslate,
  type OptionalWidgetTranslate,
} from "@/lib/optional-widget-i18n";
import type { OpenEditorFileRequest, OpenEditorFileResult } from "../../hooks/useWorkspace.types";
import { Icons } from "../../Icons";
import { useOptionalChatSessionCatalog } from "../../context/ChatSessionContext";
import { useWorkspaceReplaceBuffers } from "../../WorkspaceReplaceBufferContext";
import {
  requestWorkspaceRoots,
  type WorkspaceRootRequestOutcome,
  type WorkspaceRootTarget,
} from "../../workspaceRootTargets";
import {
  SearchResultList,
  groupSearchResults,
  type RootAwareSearchResult,
  type SearchResultGroup,
} from "./SearchResultList";
import { WORKSPACE_SEARCH_FOCUS_EVENT } from "./searchPanelEvents";
import styles from "./SearchPanel.module.css";
import { NATIVE_BLOCK_STYLE } from "../../native-element-styles";
import EditorDiffSurface, { buildWorkspaceReplacePatchModel } from "../cards/EditorDiffSurface";

const SEARCH_DEBOUNCE_MS = 250;

interface SearchPanelProps {
  readonly root?: string | undefined;
  readonly roots?: readonly WorkspaceRootTarget[] | undefined;
  readonly openEditorFile?: ((request: OpenEditorFileRequest) => OpenEditorFileResult) | undefined;
}

type SearchStatus = "idle" | "loading" | "ready" | "error";
type SearchDomain = "text" | "symbols";

interface RootSearchError {
  readonly id: string;
  readonly label: string;
  readonly message: string;
}

interface SearchAggregate {
  readonly results: readonly RootAwareSearchResult[];
  readonly errors: readonly RootSearchError[];
  readonly truncated: boolean;
  readonly filesScanned: number;
  readonly elapsedMs: number;
  readonly successfulRootCount: number;
}

interface RootReplacePreview {
  readonly target: WorkspaceRootTarget;
  readonly response: WorkspaceReplacePreviewResponse;
  readonly model: PatchPreviewModel;
}

function globArray(value: string): readonly string[] {
  const trimmed = value.trim();
  return trimmed.length === 0 ? [] : [trimmed];
}

function regexSyntaxError(
  query: string,
  mode: WorkspaceSearchMode,
  t: OptionalWidgetTranslate,
): string | null {
  if (mode !== "regex" || query.trim().length === 0) return null;
  try {
    new RegExp(query);
    return null;
  } catch {
    return t("searchPanel.error.invalidRegex");
  }
}

function requestFromState(args: {
  readonly root: string;
  readonly query: string;
  readonly mode: WorkspaceSearchMode;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly includeText: string;
  readonly excludeText: string;
}): WorkspaceSearchRequest {
  return {
    root: args.root,
    query: args.query.trim(),
    mode: args.mode,
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
    includeGlobs: globArray(args.includeText),
    excludeGlobs: globArray(args.excludeText),
    maxResults: WORKSPACE_SEARCH_MAX_RESULTS,
  };
}

function panelTargets(
  root: string | undefined,
  projectName: string,
  roots: readonly WorkspaceRootTarget[] | undefined,
): readonly WorkspaceRootTarget[] {
  if (roots !== undefined && roots.length > 0) return roots;
  return root === undefined ? [] : [{ id: root, root, label: projectName }];
}

function statusMessage(args: {
  readonly hasRoot: boolean;
  readonly multiRoot: boolean;
  readonly query: string;
  readonly status: SearchStatus;
  readonly response: SearchAggregate | null;
  readonly error: string | null;
  readonly t: OptionalWidgetTranslate;
}): string {
  const { t } = args;
  if (!args.hasRoot) return t("searchPanel.status.selectWorkspace");
  if (args.query.trim().length === 0) return t("searchPanel.status.enterQuery");
  if (args.error !== null) return args.error;
  if (args.status === "loading") {
    return args.multiRoot
      ? t("searchPanel.status.searchingRoots")
      : t("searchPanel.status.searching");
  }
  if (args.response === null) return t("searchPanel.status.readyToSearch");
  if (args.response.results.length === 0) return t("searchPanel.status.noMatches");
  const suffix = args.response.truncated ? t("searchPanel.status.resultsCappedSuffix") : "";
  const roots = args.multiRoot
    ? t("searchPanel.status.acrossRootsSuffix", {
        count: args.response.successfulRootCount,
      })
    : "";
  return t("searchPanel.status.results", {
    count: args.response.results.length,
    roots,
    filesScanned: args.response.filesScanned,
    suffix,
  });
}

function resultGroups(response: SearchAggregate | null): readonly SearchResultGroup[] {
  return response === null ? [] : groupSearchResults(response.results);
}

function symbolResponseToSearchResponse(
  response: WorkspaceSymbolSearchResponse,
  t: OptionalWidgetTranslate,
): WorkspaceSearchResponse {
  return {
    results: response.results.map((result) => ({
      path: result.path,
      lineRange: { startLine: result.line, endLine: result.line },
      snippet: `${result.kind} ${result.symbol}${
        result.enclosingSymbol === undefined
          ? ""
          : t("searchPanel.symbol.enclosingSuffix", {
              enclosing: result.enclosingSymbol,
            })
      }`,
      score: result.score,
    })),
    truncated: response.truncated,
    filesScanned: response.filesScanned,
    elapsedMs: response.elapsedMs,
  };
}

function aggregateSearch(
  outcomes: readonly WorkspaceRootRequestOutcome<WorkspaceSearchResponse>[],
): SearchAggregate {
  const results: RootAwareSearchResult[] = [];
  const errors: RootSearchError[] = [];
  let filesScanned = 0;
  let elapsedMs = 0;
  let truncated = false;
  let successfulRootCount = 0;
  for (const outcome of outcomes) {
    if (outcome.status === "error") {
      errors.push({
        id: outcome.target.id,
        label: outcome.target.label,
        message: outcome.message,
      });
      continue;
    }
    successfulRootCount += 1;
    filesScanned += outcome.value.filesScanned;
    elapsedMs = Math.max(elapsedMs, outcome.value.elapsedMs);
    truncated ||= outcome.value.truncated;
    results.push(
      ...outcome.value.results.map((result) => ({
        ...result,
        root: outcome.target.root,
        rootLabel: outcome.target.label,
      })),
    );
  }
  if (results.length > WORKSPACE_SEARCH_MAX_RESULTS) truncated = true;
  return {
    results: results.slice(0, WORKSPACE_SEARCH_MAX_RESULTS),
    errors,
    truncated,
    filesScanned,
    elapsedMs,
    successfulRootCount,
  };
}

function searchFailureMessage(
  aggregate: SearchAggregate,
  t: OptionalWidgetTranslate,
): string | null {
  if (aggregate.successfulRootCount > 0) return null;
  if (aggregate.errors.length === 1) {
    return aggregate.errors[0]?.message ?? t("searchPanel.error.searchFailed");
  }
  return t("searchPanel.error.allRootsFailed");
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

function replaceSummary(
  response: WorkspaceReplacePreviewResponse | null,
  t: OptionalWidgetTranslate,
): string {
  if (response === null) return t("searchPanel.replace.noPreviewComputed");
  const omitted =
    response.omittedFileCount > 0
      ? t("searchPanel.replace.omittedSuffix", {
          count: response.omittedFileCount,
        })
      : "";
  return t("searchPanel.replace.summary", {
    editCount: response.editCount,
    fileCount: response.fileCount,
    omitted,
  });
}

function replaceErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function conflictSummary(
  conflicts: readonly WorkspaceReplaceApplyConflict[],
  t: OptionalWidgetTranslate,
): string {
  if (conflicts.length === 0) return "";
  const listed = conflicts
    .slice(0, 3)
    .map((conflict) => `${conflict.path} (${conflict.reason})`)
    .join(", ");
  const remaining =
    conflicts.length > 3
      ? t("searchPanel.replace.conflictsMoreSuffix", {
          count: conflicts.length - 3,
        })
      : "";
  return t("searchPanel.replace.conflictsSummary", { listed, remaining });
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

function RootErrors({
  errors,
  operation,
  t,
}: {
  readonly errors: readonly RootSearchError[];
  readonly operation: "searched" | "previewed";
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  if (errors.length === 0) return null;
  const operationLabel =
    operation === "searched"
      ? t("searchPanel.rootErrors.operationSearched")
      : t("searchPanel.rootErrors.operationPreviewed");
  return (
    <div className={`${styles.status} ${styles.error}`} role="alert">
      <span>
        {errors.length === 1
          ? t("searchPanel.rootErrors.one", { operation: operationLabel })
          : t("searchPanel.rootErrors.some", { operation: operationLabel })}
      </span>
      <ul className={styles.errorList}>
        {errors.map((error) => (
          <li key={error.id}>
            {error.label}: {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReplaceReviews({
  previews,
  multiRoot,
  applyingRootId,
  appliedRootIds,
  messages,
  onApply,
  t,
}: {
  readonly previews: readonly RootReplacePreview[];
  readonly multiRoot: boolean;
  readonly applyingRootId: string | null;
  readonly appliedRootIds: ReadonlySet<string>;
  readonly messages: ReadonlyMap<string, string>;
  readonly onApply: (preview: RootReplacePreview) => void;
  readonly t: OptionalWidgetTranslate;
}): ReactNode {
  return previews.map((preview) => {
    const applied = appliedRootIds.has(preview.target.id);
    const buttonLabel = multiRoot
      ? t("searchPanel.action.applyReviewedReplaceInRoot", {
          rootLabel: preview.target.label,
        })
      : t("searchPanel.action.applyReviewedReplace");
    return (
      <section className={styles.replaceReview} key={preview.target.id}>
        {multiRoot ? <h3 className={styles.rootHeading}>{preview.target.label}</h3> : null}
        <EditorDiffSurface
          model={preview.model}
          loadState={{ status: "ready" }}
          actions={{
            canApply: !applied,
            canReject: false,
            canRunVerification: false,
          }}
          onApply={() => onApply(preview)}
        />
        {multiRoot && messages.has(preview.target.id) ? (
          <output className={styles.status}>{messages.get(preview.target.id)}</output>
        ) : null}
        <button
          className={styles.modeButton}
          type="button"
          disabled={applyingRootId !== null || applied}
          onClick={() => onApply(preview)}
        >
          {buttonLabel}
        </button>
      </section>
    );
  });
}

export function SearchPanel({ root, roots, openEditorFile }: SearchPanelProps): ReactNode {
  const t = useOptionalWidgetTranslate();
  const catalog = useOptionalChatSessionCatalog();
  const openBuffers = useWorkspaceReplaceBuffers();
  const selectedRoot = root ?? catalog?.activeProject?.path;
  const projectName = catalog?.activeProject?.name ?? t("searchPanel.noProjectSelected");
  const targets = useMemo(
    () => panelTargets(selectedRoot, projectName, roots),
    [projectName, roots, selectedRoot],
  );
  const multiRoot = targets.length > 1;
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [searchDomain, setSearchDomain] = useState<SearchDomain>("text");
  const [mode, setMode] = useState<WorkspaceSearchMode>("literal");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [response, setResponse] = useState<SearchAggregate | null>(null);
  const [replacePreviews, setReplacePreviews] = useState<readonly RootReplacePreview[]>([]);
  const [status, setStatus] = useState<SearchStatus>("idle");
  // `replaceStatus` is `null` until the first replace-related action runs, so visibility never
  // depends on comparing translated display text against a hardcoded sentinel (that comparison
  // silently breaks once the sentinel and the status text are translated independently).
  const [replaceStatus, setReplaceStatus] = useState<string | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [rootErrors, setRootErrors] = useState<readonly RootSearchError[]>([]);
  const [replaceErrors, setReplaceErrors] = useState<readonly RootSearchError[]>([]);
  const [applyingRootId, setApplyingRootId] = useState<string | null>(null);
  const [appliedRootIds, setAppliedRootIds] = useState<ReadonlySet<string>>(new Set());
  const [replaceMessages, setReplaceMessages] = useState<ReadonlyMap<string, string>>(new Map());
  const [activeIndex, setActiveIndex] = useState(0);
  const controlsId = useId();
  const inlineError = searchDomain === "text" ? regexSyntaxError(query, mode, t) : null;
  const groups = useMemo(() => resultGroups(response), [response]);
  const message = statusMessage({
    hasRoot: targets.length > 0,
    multiRoot,
    query,
    status,
    response,
    error: inlineError ?? routeError,
    t,
  });
  const showReplaceStatus = replaceStatus !== null;

  useEffect(() => {
    const focusSearch = (): void => queryInputRef.current?.focus();
    window.addEventListener(WORKSPACE_SEARCH_FOCUS_EVENT, focusSearch);
    return () => window.removeEventListener(WORKSPACE_SEARCH_FOCUS_EVENT, focusSearch);
  }, []);

  const runSearch = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (targets.length === 0 || query.trim().length === 0 || inlineError !== null) return;
      setStatus("loading");
      setRouteError(null);
      setRootErrors([]);
      const options = signal === undefined ? undefined : { signal };
      const outcomes = await requestWorkspaceRoots(targets, (target) =>
        searchDomain === "symbols"
          ? fetchWorkspaceSymbols(
              {
                root: target.root,
                query: query.trim(),
                maxResults: WORKSPACE_SEARCH_MAX_RESULTS,
              },
              options,
            ).then((result) => symbolResponseToSearchResponse(result, t))
          : fetchWorkspaceSearch(
              requestFromState({
                root: target.root,
                query,
                mode,
                caseSensitive,
                wholeWord,
                includeText,
                excludeText,
              }),
              options,
            ),
      );
      if (signal?.aborted === true) return;
      const next = aggregateSearch(outcomes);
      const failure = searchFailureMessage(next, t);
      setResponse(failure === null ? next : null);
      setRootErrors(multiRoot ? next.errors : []);
      setRouteError(failure);
      setActiveIndex(0);
      setStatus(failure === null ? "ready" : "error");
    },
    [
      caseSensitive,
      excludeText,
      includeText,
      inlineError,
      mode,
      multiRoot,
      query,
      searchDomain,
      t,
      targets,
      wholeWord,
    ],
  );

  useEffect(() => {
    if (query.trim().length === 0 || inlineError !== null || targets.length === 0) {
      setResponse(null);
      setRootErrors([]);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void runSearch(controller.signal), SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [inlineError, query, runSearch, targets.length]);

  const openMatch = useCallback(
    (match: RootAwareSearchResult): void => {
      if (openEditorFile === undefined) return;
      openEditorFile({
        root: match.root,
        path: match.path,
        lineStart: match.lineRange.startLine,
        lineEnd: match.lineRange.endLine,
      });
    },
    [openEditorFile],
  );

  const previewReplace = useCallback(async (): Promise<void> => {
    if (targets.length === 0 || query.trim().length === 0 || inlineError !== null) return;
    setReplaceStatus(
      multiRoot
        ? t("searchPanel.replace.computingMulti")
        : t("searchPanel.replace.computingSingle"),
    );
    setReplaceErrors([]);
    setAppliedRootIds(new Set());
    setReplaceMessages(new Map());
    const next: RootReplacePreview[] = [];
    const errors: RootSearchError[] = [];
    for (const target of targets) {
      try {
        const preview = await fetchWorkspaceReplacePreview({
          root: target.root,
          query: query.trim(),
          mode,
          caseSensitive,
          includeGlobs: globArray(includeText),
          excludeGlobs: globArray(excludeText),
          replacement,
          maxFiles: WORKSPACE_REPLACE_MAX_FILES,
        });
        const sources = await sourcesForPreview(target.root, preview.files);
        next.push({
          target,
          response: preview,
          model: buildWorkspaceReplacePatchModel(preview, sources),
        });
      } catch (error) {
        errors.push({
          id: target.id,
          label: target.label,
          message: replaceErrorMessage(error, t("searchPanel.error.previewFailed")),
        });
      }
    }
    setReplacePreviews(next);
    setReplaceErrors(multiRoot ? errors : []);
    if (!multiRoot) {
      setReplaceStatus(
        next[0] === undefined
          ? (errors[0]?.message ?? t("searchPanel.error.previewFailed"))
          : replaceSummary(next[0].response, t),
      );
      return;
    }
    setReplaceStatus(
      t("searchPanel.replace.multiReady", {
        count: next.length,
        errors:
          errors.length === 0
            ? ""
            : t("searchPanel.replace.multiErrorsSuffix", {
                count: errors.length,
              }),
      }),
    );
  }, [
    caseSensitive,
    excludeText,
    includeText,
    inlineError,
    mode,
    multiRoot,
    query,
    replacement,
    t,
    targets,
  ]);

  const applyReplacePreview = useCallback(
    async (preview: RootReplacePreview): Promise<void> => {
      setApplyingRootId(preview.target.id);
      try {
        const result = await applyReviewedReplace({
          root: preview.target.root,
          openBuffers,
          files: preview.response.files,
        });
        const suffix =
          result.conflictCount > 0
            ? t("searchPanel.replace.conflictsSuffix", {
                count: result.conflictCount,
                conflicts: conflictSummary(result.conflicts, t),
              })
            : "";
        const nextMessage = t("searchPanel.replace.appliedSummary", {
          count: result.appliedCount,
          suffix,
        });
        setReplaceMessages((current) => new Map(current).set(preview.target.id, nextMessage));
        setReplaceStatus(
          multiRoot
            ? t("searchPanel.replace.rootPrefixedStatus", {
                rootLabel: preview.target.label,
                message: nextMessage,
              })
            : nextMessage,
        );
        setAppliedRootIds((current) => new Set(current).add(preview.target.id));
      } catch (error) {
        const nextMessage = replaceErrorMessage(error, t("searchPanel.error.applyFailed"));
        setReplaceMessages((current) => new Map(current).set(preview.target.id, nextMessage));
        setReplaceStatus(
          multiRoot
            ? t("searchPanel.replace.rootPrefixedStatus", {
                rootLabel: preview.target.label,
                message: nextMessage,
              })
            : nextMessage,
        );
      } finally {
        setApplyingRootId(null);
      }
    },
    [multiRoot, openBuffers, t],
  );

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
            aria-label={t("searchPanel.input.ariaLabel")}
            aria-describedby={controlsId}
            placeholder={t("searchPanel.input.placeholder")}
            value={query}
            disabled={targets.length === 0}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="tw-label srch-label">
          {projectName}{" "}
          <span className="srch-meta mono">{t("searchPanel.label.workspaceSearch")}</span>
        </div>
        <div className={styles.controlRow}>
          <div className={styles.modeGroup} aria-label={t("searchPanel.group.searchDomain")}>
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={searchDomain === "text"}
              onClick={() => setSearchDomain("text")}
            >
              {t("searchPanel.domain.text")}
            </button>
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={searchDomain === "symbols"}
              onClick={() => setSearchDomain("symbols")}
            >
              {t("searchPanel.domain.symbols")}
            </button>
          </div>
          <div className={styles.modeGroup} aria-label={t("searchPanel.group.searchMode")}>
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={mode === "literal"}
              onClick={() => setMode("literal")}
            >
              {t("searchPanel.mode.literal")}
            </button>
            <button
              className={styles.modeButton}
              type="button"
              aria-pressed={mode === "regex"}
              onClick={() => setMode("regex")}
            >
              {t("searchPanel.mode.regex")}
            </button>
          </div>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />{" "}
            {t("searchPanel.option.caseSensitive")}
          </label>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              checked={wholeWord}
              onChange={(event) => setWholeWord(event.target.checked)}
            />{" "}
            {t("searchPanel.option.matchWholeWord")}
          </label>
        </div>
        <div className={styles.globGrid}>
          <label className={styles.fieldLabel}>
            {t("searchPanel.field.includeGlob")}
            <input
              className={`${styles.globInput} mono`}
              value={includeText}
              placeholder={t("searchPanel.field.includeGlobPlaceholder")}
              onChange={(event) => setIncludeText(event.target.value)}
            />
          </label>
          <label className={styles.fieldLabel}>
            {t("searchPanel.field.excludeGlob")}
            <input
              className={`${styles.globInput} mono`}
              value={excludeText}
              placeholder={t("searchPanel.field.excludeGlobPlaceholder")}
              onChange={(event) => setExcludeText(event.target.value)}
            />
          </label>
        </div>
        <label className={styles.fieldLabel}>
          {t("searchPanel.field.replacement")}
          <input
            className={`${styles.globInput} mono`}
            value={replacement}
            placeholder={t("searchPanel.field.replacementPlaceholder")}
            onChange={(event) => setReplacement(event.target.value)}
          />
        </label>
        <button
          className={styles.modeButton}
          type="button"
          disabled={targets.length === 0 || query.trim().length === 0 || inlineError !== null}
          onClick={() => void previewReplace()}
        >
          {t("searchPanel.action.previewReplace")}
        </button>
      </form>
      {/* <output> owns role=status; NATIVE_BLOCK_STYLE restores the block box the <div> had,
          because .status declares no display of its own (#2721). */}
      <output
        id={controlsId}
        className={`${styles.status} ${(inlineError ?? routeError) ? styles.error : ""}`}
        style={NATIVE_BLOCK_STYLE}
      >
        {message}
      </output>
      <RootErrors errors={rootErrors} operation="searched" t={t} />
      {showReplaceStatus ? (
        <output className={styles.status} style={NATIVE_BLOCK_STYLE}>
          {replaceStatus}
        </output>
      ) : null}
      <RootErrors errors={replaceErrors} operation="previewed" t={t} />
      {groups.length > 0 ? (
        <SearchResultList
          groups={groups}
          showRootLabels={multiRoot}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onOpen={openMatch}
        />
      ) : null}
      <ReplaceReviews
        previews={replacePreviews}
        multiRoot={multiRoot}
        applyingRootId={applyingRootId}
        appliedRootIds={appliedRootIds}
        messages={replaceMessages}
        onApply={(preview) => void applyReplacePreview(preview)}
        t={t}
      />
    </div>
  );
}
