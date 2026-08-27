"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  WorkspaceReplaceApplyConflict,
  WorkspaceReplaceApplyFile,
  WorkspaceReplacePreviewFileEdit,
  WorkspaceReplacePreviewResponse,
  WorkspaceSearchMode,
  WorkspaceSearchRequest,
  WorkspaceSearchResponse,
  WorkspaceSymbolSearchResponse,
} from "@oscharko-dev/keiko-contracts";
import {
  WORKSPACE_REPLACE_MAX_FILES,
  WORKSPACE_SEARCH_MAX_RESULTS,
} from "@oscharko-dev/keiko-contracts/runtime/workspace-search";
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
const SearchIcon = Icons.search;

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

function panelProjectName(
  root: string | undefined,
  roots: readonly WorkspaceRootTarget[] | undefined,
  t: OptionalWidgetTranslate,
): string {
  if (root === undefined) return t("searchPanel.noProjectSelected");
  return roots?.find((target): boolean => target.root === root)?.label ?? root;
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
  let suffix = "";
  if (args.response.truncated) {
    const key = args.multiRoot
      ? "searchPanel.status.resultsCappedPerRootSuffix"
      : "searchPanel.status.resultsCappedSuffix";
    suffix = t(key);
  }
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

function attributedResults(
  outcome: Extract<WorkspaceRootRequestOutcome<WorkspaceSearchResponse>, { status: "success" }>,
): readonly RootAwareSearchResult[] {
  return outcome.value.results.map((result) => ({
    ...result,
    root: outcome.target.root,
    rootLabel: outcome.target.label,
  }));
}

function rootFairMerge(
  resultsByRoot: readonly (readonly RootAwareSearchResult[])[],
): readonly RootAwareSearchResult[] {
  const merged: RootAwareSearchResult[] = [];
  let resultIndex = 0;
  let addedResult = true;
  while (merged.length < WORKSPACE_SEARCH_MAX_RESULTS && addedResult) {
    addedResult = false;
    for (const rootResults of resultsByRoot) {
      const result = rootResults[resultIndex];
      if (result === undefined) continue;
      merged.push(result);
      addedResult = true;
      if (merged.length === WORKSPACE_SEARCH_MAX_RESULTS) return merged;
    }
    resultIndex += 1;
  }
  return merged;
}

function aggregateSearch(
  outcomes: readonly WorkspaceRootRequestOutcome<WorkspaceSearchResponse>[],
): SearchAggregate {
  const resultsByRoot: Array<readonly RootAwareSearchResult[]> = [];
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
    resultsByRoot.push(attributedResults(outcome));
  }
  const availableResultCount = resultsByRoot.reduce((total, results) => total + results.length, 0);
  const results = rootFairMerge(resultsByRoot);
  if (availableResultCount > results.length) truncated = true;
  return {
    results,
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

type TargetReplacePreviewResult =
  | { readonly status: "preview"; readonly preview: RootReplacePreview }
  | { readonly status: "error"; readonly error: RootSearchError }
  | { readonly status: "stale" };

async function previewReplaceTarget(args: {
  readonly target: WorkspaceRootTarget;
  readonly query: string;
  readonly mode: WorkspaceSearchMode;
  readonly caseSensitive: boolean;
  readonly includeText: string;
  readonly excludeText: string;
  readonly replacement: string;
  readonly isCurrent: () => boolean;
  readonly t: OptionalWidgetTranslate;
}): Promise<TargetReplacePreviewResult> {
  try {
    const response = await fetchWorkspaceReplacePreview({
      root: args.target.root,
      query: args.query,
      mode: args.mode,
      caseSensitive: args.caseSensitive,
      includeGlobs: globArray(args.includeText),
      excludeGlobs: globArray(args.excludeText),
      replacement: args.replacement,
      maxFiles: WORKSPACE_REPLACE_MAX_FILES,
    });
    if (!args.isCurrent()) return { status: "stale" };
    const sources = await sourcesForPreview(args.target.root, response.files);
    if (!args.isCurrent()) return { status: "stale" };
    return {
      status: "preview",
      preview: {
        target: args.target,
        response,
        model: buildWorkspaceReplacePatchModel(response, sources),
      },
    };
  } catch (error) {
    if (!args.isCurrent()) return { status: "stale" };
    return {
      status: "error",
      error: {
        id: args.target.id,
        label: args.target.label,
        message: replaceErrorMessage(error, args.t("searchPanel.error.previewFailed")),
      },
    };
  }
}

async function collectReplacePreviews(
  targets: readonly WorkspaceRootTarget[],
  request: Omit<Parameters<typeof previewReplaceTarget>[0], "target">,
): Promise<{
  readonly previews: readonly RootReplacePreview[];
  readonly errors: readonly RootSearchError[];
} | null> {
  const previews: RootReplacePreview[] = [];
  const errors: RootSearchError[] = [];
  for (const target of targets) {
    const result = await previewReplaceTarget({ ...request, target });
    if (result.status === "stale") return null;
    if (result.status === "preview") previews.push(result.preview);
    else errors.push(result.error);
  }
  return { previews, errors };
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
  // #2906 round-3 review: response.truncated can be true with omittedFileCount === 0 -- the
  // upstream search hit its own bound (e.g. "match-cap" mid-file; see
  // WorkspaceReplacePreviewResponse.searchTruncationReasons's doc comment) without this preview's
  // own maxFiles cap dropping a file. Surface that incompleteness too, so the summary the user
  // reads before applying never reads as complete when search did not scan every match. Gated on
  // omittedFileCount === 0 so the two suffixes never both fire for the same cause.
  const searchLimited =
    response.truncated && response.omittedFileCount === 0
      ? t("searchPanel.replace.searchLimitSuffix")
      : "";
  return t("searchPanel.replace.summary", {
    editCount: response.editCount,
    fileCount: response.fileCount,
    omitted: `${omitted}${searchLimited}`,
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

function appliedReplaceMessage(
  result: Awaited<ReturnType<typeof applyReviewedReplace>>,
  t: OptionalWidgetTranslate,
): string {
  const suffix =
    result.conflictCount > 0
      ? t("searchPanel.replace.conflictsSuffix", {
          count: result.conflictCount,
          conflicts: conflictSummary(result.conflicts, t),
        })
      : "";
  return t("searchPanel.replace.appliedSummary", {
    count: result.appliedCount,
    suffix,
  });
}

function rootPrefixedReplaceStatus(
  preview: RootReplacePreview,
  message: string,
  t: OptionalWidgetTranslate,
): string {
  return t("searchPanel.replace.rootPrefixedStatus", {
    rootLabel: preview.target.label,
    message,
  });
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
            canApply: applyingRootId === null && !applied,
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

function searchPanelScopeKey(props: SearchPanelProps): string {
  return JSON.stringify(props.root ?? null);
}

function searchTargetsScopeKey(targets: readonly WorkspaceRootTarget[]): string {
  return JSON.stringify(targets.map((target): readonly string[] => [target.id, target.root]));
}

export function SearchPanel(props: SearchPanelProps): ReactNode {
  return <SearchPanelState key={searchPanelScopeKey(props)} {...props} />;
}

interface SearchFormState {
  readonly query: string;
  readonly setQuery: Dispatch<SetStateAction<string>>;
  readonly searchDomain: SearchDomain;
  readonly setSearchDomain: Dispatch<SetStateAction<SearchDomain>>;
  readonly mode: WorkspaceSearchMode;
  readonly setMode: Dispatch<SetStateAction<WorkspaceSearchMode>>;
  readonly caseSensitive: boolean;
  readonly setCaseSensitive: Dispatch<SetStateAction<boolean>>;
  readonly wholeWord: boolean;
  readonly setWholeWord: Dispatch<SetStateAction<boolean>>;
  readonly includeText: string;
  readonly setIncludeText: Dispatch<SetStateAction<string>>;
  readonly excludeText: string;
  readonly setExcludeText: Dispatch<SetStateAction<string>>;
  readonly replacement: string;
  readonly setReplacement: Dispatch<SetStateAction<string>>;
}

interface SearchResultsState {
  readonly response: SearchAggregate | null;
  readonly setResponse: Dispatch<SetStateAction<SearchAggregate | null>>;
  readonly status: SearchStatus;
  readonly setStatus: Dispatch<SetStateAction<SearchStatus>>;
  readonly routeError: string | null;
  readonly setRouteError: Dispatch<SetStateAction<string | null>>;
  readonly rootErrors: readonly RootSearchError[];
  readonly setRootErrors: Dispatch<SetStateAction<readonly RootSearchError[]>>;
  readonly activeIndex: number;
  readonly setActiveIndex: Dispatch<SetStateAction<number>>;
}

interface ReplaceResultsState {
  readonly previews: readonly RootReplacePreview[];
  readonly setPreviews: Dispatch<SetStateAction<readonly RootReplacePreview[]>>;
  readonly status: string | null;
  readonly setStatus: Dispatch<SetStateAction<string | null>>;
  readonly errors: readonly RootSearchError[];
  readonly setErrors: Dispatch<SetStateAction<readonly RootSearchError[]>>;
  readonly applyingRootId: string | null;
  readonly setApplyingRootId: Dispatch<SetStateAction<string | null>>;
  readonly appliedRootIds: ReadonlySet<string>;
  readonly setAppliedRootIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  readonly messages: ReadonlyMap<string, string>;
  readonly setMessages: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
}

interface ReplaceOperationRefs {
  readonly currentTargetsScopeKey: RefObject<string>;
  readonly applyGeneration: RefObject<number>;
  readonly activeApply: RefObject<object | null>;
}

type SearchRunner = (signal?: AbortSignal) => Promise<void>;

interface SearchPanelController {
  readonly t: OptionalWidgetTranslate;
  readonly projectName: string;
  readonly targets: readonly WorkspaceRootTarget[];
  readonly multiRoot: boolean;
  readonly queryInputRef: RefObject<HTMLInputElement | null>;
  readonly controlsId: string;
  readonly form: SearchFormState;
  readonly search: SearchResultsState;
  readonly replace: ReplaceResultsState;
  readonly inlineError: string | null;
  readonly message: string;
  readonly groups: readonly SearchResultGroup[];
  readonly runSearch: SearchRunner;
  readonly openMatch: (match: RootAwareSearchResult) => void;
  readonly previewReplace: () => Promise<void>;
  readonly applyReplacePreview: (preview: RootReplacePreview) => Promise<void>;
}

function useSearchFormState(): SearchFormState {
  const [query, setQuery] = useState("");
  const [searchDomain, setSearchDomain] = useState<SearchDomain>("text");
  const [mode, setMode] = useState<WorkspaceSearchMode>("literal");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeText, setIncludeText] = useState("");
  const [excludeText, setExcludeText] = useState("");
  const [replacement, setReplacement] = useState("");
  return useMemo(
    (): SearchFormState => ({
      query,
      setQuery,
      searchDomain,
      setSearchDomain,
      mode,
      setMode,
      caseSensitive,
      setCaseSensitive,
      wholeWord,
      setWholeWord,
      includeText,
      setIncludeText,
      excludeText,
      setExcludeText,
      replacement,
      setReplacement,
    }),
    [caseSensitive, excludeText, includeText, mode, query, replacement, searchDomain, wholeWord],
  );
}

function useSearchResultsState(targetsScopeKey: string): SearchResultsState {
  const [response, setResponse] = useState<SearchAggregate | null>(null);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [routeError, setRouteError] = useState<string | null>(null);
  const [rootErrors, setRootErrors] = useState<readonly RootSearchError[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect((): void => {
    setResponse(null);
    setStatus("idle");
    setRouteError(null);
    setRootErrors([]);
    setActiveIndex(0);
  }, [targetsScopeKey]);
  return {
    response,
    setResponse,
    status,
    setStatus,
    routeError,
    setRouteError,
    rootErrors,
    setRootErrors,
    activeIndex,
    setActiveIndex,
  };
}

function useReplaceResultsState(
  targetsScopeKey: string,
  refs: ReplaceOperationRefs,
): ReplaceResultsState {
  const [previews, setPreviews] = useState<readonly RootReplacePreview[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<readonly RootSearchError[]>([]);
  const [applyingRootId, setApplyingRootId] = useState<string | null>(null);
  const [appliedRootIds, setAppliedRootIds] = useState<ReadonlySet<string>>(new Set());
  const [messages, setMessages] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect((): void => {
    refs.applyGeneration.current += 1;
    refs.activeApply.current = null;
    setPreviews([]);
    setStatus(null);
    setErrors([]);
    setApplyingRootId(null);
    setAppliedRootIds(new Set());
    setMessages(new Map());
  }, [refs, targetsScopeKey]);
  return {
    previews,
    setPreviews,
    status,
    setStatus,
    errors,
    setErrors,
    applyingRootId,
    setApplyingRootId,
    appliedRootIds,
    setAppliedRootIds,
    messages,
    setMessages,
  };
}

function useReplaceOperationRefs(targetsScopeKey: string): ReplaceOperationRefs {
  const currentTargetsScopeKey = useRef(targetsScopeKey);
  const applyGeneration = useRef(0);
  const activeApply = useRef<object | null>(null);
  currentTargetsScopeKey.current = targetsScopeKey;
  return useMemo(
    () => ({ currentTargetsScopeKey, applyGeneration, activeApply }),
    [activeApply, applyGeneration, currentTargetsScopeKey],
  );
}

function useSearchFocus(queryInputRef: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    const focusSearch = (): void => queryInputRef.current?.focus();
    window.addEventListener(WORKSPACE_SEARCH_FOCUS_EVENT, focusSearch);
    return () => window.removeEventListener(WORKSPACE_SEARCH_FOCUS_EVENT, focusSearch);
  }, [queryInputRef]);
}

async function fetchSearchAggregate(
  targets: readonly WorkspaceRootTarget[],
  form: SearchFormState,
  t: OptionalWidgetTranslate,
  signal?: AbortSignal,
): Promise<SearchAggregate> {
  const options = signal === undefined ? undefined : { signal };
  const outcomes = await requestWorkspaceRoots(targets, (target) =>
    form.searchDomain === "symbols"
      ? fetchWorkspaceSymbols(
          {
            root: target.root,
            query: form.query.trim(),
            maxResults: WORKSPACE_SEARCH_MAX_RESULTS,
          },
          options,
        ).then((result) => symbolResponseToSearchResponse(result, t))
      : fetchWorkspaceSearch(
          requestFromState({
            root: target.root,
            query: form.query,
            mode: form.mode,
            caseSensitive: form.caseSensitive,
            wholeWord: form.wholeWord,
            includeText: form.includeText,
            excludeText: form.excludeText,
          }),
          options,
        ),
  );
  return aggregateSearch(outcomes);
}

function useSearchRunner(args: {
  readonly targets: readonly WorkspaceRootTarget[];
  readonly form: SearchFormState;
  readonly search: SearchResultsState;
  readonly inlineError: string | null;
  readonly multiRoot: boolean;
  readonly t: OptionalWidgetTranslate;
}): SearchRunner {
  const { targets, form, search, inlineError, multiRoot, t } = args;
  const { setStatus, setRouteError, setRootErrors, setResponse, setActiveIndex } = search;
  return useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (targets.length === 0 || form.query.trim().length === 0 || inlineError !== null) return;
      setStatus("loading");
      setRouteError(null);
      setRootErrors([]);
      const next = await fetchSearchAggregate(targets, form, t, signal);
      if (signal?.aborted === true) return;
      const failure = searchFailureMessage(next, t);
      setResponse(failure === null ? next : null);
      setRootErrors(multiRoot ? next.errors : []);
      setRouteError(failure);
      setActiveIndex(0);
      setStatus(failure === null ? "ready" : "error");
    },
    [
      form,
      inlineError,
      multiRoot,
      setActiveIndex,
      setResponse,
      setRootErrors,
      setRouteError,
      setStatus,
      t,
      targets,
    ],
  );
}

function useDebouncedSearch(args: {
  readonly query: string;
  readonly inlineError: string | null;
  readonly targetCount: number;
  readonly runSearch: SearchRunner;
  readonly search: SearchResultsState;
}): void {
  const { query, inlineError, targetCount, runSearch, search } = args;
  const { setResponse, setRootErrors, setStatus } = search;
  useEffect(() => {
    if (query.trim().length === 0 || inlineError !== null || targetCount === 0) {
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
  }, [inlineError, query, runSearch, setResponse, setRootErrors, setStatus, targetCount]);
}

interface ReplaceActionArgs {
  readonly targets: readonly WorkspaceRootTarget[];
  readonly targetsScopeKey: string;
  readonly multiRoot: boolean;
  readonly form: SearchFormState;
  readonly replace: ReplaceResultsState;
  readonly refs: ReplaceOperationRefs;
  readonly openBuffers: ReturnType<typeof useWorkspaceReplaceBuffers>;
  readonly inlineError: string | null;
  readonly t: OptionalWidgetTranslate;
}

async function runReplacePreview(args: ReplaceActionArgs): Promise<void> {
  if (
    args.targets.length === 0 ||
    args.form.query.trim().length === 0 ||
    args.inlineError !== null
  ) {
    return;
  }
  args.replace.setStatus(
    args.multiRoot
      ? args.t("searchPanel.replace.computingMulti")
      : args.t("searchPanel.replace.computingSingle"),
  );
  args.replace.setErrors([]);
  args.replace.setAppliedRootIds(new Set());
  args.replace.setMessages(new Map());
  const result = await collectReplacePreviews(args.targets, {
    query: args.form.query.trim(),
    mode: args.form.mode,
    caseSensitive: args.form.caseSensitive,
    includeText: args.form.includeText,
    excludeText: args.form.excludeText,
    replacement: args.form.replacement,
    isCurrent: (): boolean => args.refs.currentTargetsScopeKey.current === args.targetsScopeKey,
    t: args.t,
  });
  if (result === null) return;
  args.replace.setPreviews(result.previews);
  args.replace.setErrors(args.multiRoot ? result.errors : []);
  if (!args.multiRoot) {
    args.replace.setStatus(
      result.previews[0] === undefined
        ? (result.errors[0]?.message ?? args.t("searchPanel.error.previewFailed"))
        : replaceSummary(result.previews[0].response, args.t),
    );
    return;
  }
  const errorSuffix =
    result.errors.length === 0
      ? ""
      : args.t("searchPanel.replace.multiErrorsSuffix", { count: result.errors.length });
  args.replace.setStatus(
    args.t("searchPanel.replace.multiReady", {
      count: result.previews.length,
      errors: errorSuffix,
    }),
  );
}

function replaceCompletion(
  args: ReplaceActionArgs,
  preview: RootReplacePreview,
  nextMessage: string,
): void {
  args.replace.setMessages((current) => new Map(current).set(preview.target.id, nextMessage));
  args.replace.setStatus(
    args.multiRoot ? rootPrefixedReplaceStatus(preview, nextMessage, args.t) : nextMessage,
  );
}

async function runApplyReplacePreview(
  args: ReplaceActionArgs,
  preview: RootReplacePreview,
): Promise<void> {
  if (args.refs.activeApply.current !== null) return;
  const requestedGeneration = args.refs.applyGeneration.current;
  const operation = {};
  args.refs.activeApply.current = operation;
  const operationIsCurrent = (): boolean =>
    args.refs.activeApply.current === operation &&
    args.refs.applyGeneration.current === requestedGeneration &&
    args.refs.currentTargetsScopeKey.current === args.targetsScopeKey;
  args.replace.setApplyingRootId(preview.target.id);
  try {
    const result = await applyReviewedReplace({
      root: preview.target.root,
      openBuffers: args.openBuffers,
      files: preview.response.files,
    });
    if (!operationIsCurrent()) return;
    replaceCompletion(args, preview, appliedReplaceMessage(result, args.t));
    args.replace.setAppliedRootIds((current) => new Set(current).add(preview.target.id));
  } catch (error) {
    if (!operationIsCurrent()) return;
    replaceCompletion(
      args,
      preview,
      replaceErrorMessage(error, args.t("searchPanel.error.applyFailed")),
    );
  } finally {
    if (operationIsCurrent()) {
      args.refs.activeApply.current = null;
      args.replace.setApplyingRootId(null);
    }
  }
}

function createReplaceActions(
  args: ReplaceActionArgs,
): Pick<SearchPanelController, "previewReplace" | "applyReplacePreview"> {
  return {
    previewReplace: async (): Promise<void> => runReplacePreview(args),
    applyReplacePreview: async (preview): Promise<void> => runApplyReplacePreview(args, preview),
  };
}

interface SearchPanelScope {
  readonly projectName: string;
  readonly targets: readonly WorkspaceRootTarget[];
  readonly targetsScopeKey: string;
  readonly multiRoot: boolean;
}

function useSearchPanelScope(
  root: string | undefined,
  roots: readonly WorkspaceRootTarget[] | undefined,
  t: OptionalWidgetTranslate,
): SearchPanelScope {
  const projectName = panelProjectName(root, roots, t);
  const targets = useMemo(
    (): readonly WorkspaceRootTarget[] => panelTargets(root, projectName, roots),
    [projectName, root, roots],
  );
  const targetsScopeKey = useMemo((): string => searchTargetsScopeKey(targets), [targets]);
  return { projectName, targets, targetsScopeKey, multiRoot: targets.length > 1 };
}

function useSearchPanelPresentation(
  scope: SearchPanelScope,
  form: SearchFormState,
  search: SearchResultsState,
  t: OptionalWidgetTranslate,
): Pick<SearchPanelController, "inlineError" | "groups" | "message"> {
  const inlineError =
    form.searchDomain === "text" ? regexSyntaxError(form.query, form.mode, t) : null;
  const groups = useMemo(
    (): readonly SearchResultGroup[] => resultGroups(search.response),
    [search.response],
  );
  const message = statusMessage({
    hasRoot: scope.targets.length > 0,
    multiRoot: scope.multiRoot,
    query: form.query,
    status: search.status,
    response: search.response,
    error: inlineError ?? search.routeError,
    t,
  });
  return { inlineError, groups, message };
}

interface SearchPanelActionArgs {
  readonly scope: SearchPanelScope;
  readonly form: SearchFormState;
  readonly search: SearchResultsState;
  readonly replace: ReplaceResultsState;
  readonly refs: ReplaceOperationRefs;
  readonly openBuffers: ReturnType<typeof useWorkspaceReplaceBuffers>;
  readonly openEditorFile: SearchPanelProps["openEditorFile"];
  readonly inlineError: string | null;
  readonly t: OptionalWidgetTranslate;
}

function useSearchPanelActions(
  args: SearchPanelActionArgs,
): Pick<
  SearchPanelController,
  "runSearch" | "openMatch" | "previewReplace" | "applyReplacePreview"
> {
  const { scope, form, search, replace, refs, openBuffers, openEditorFile, inlineError, t } = args;
  const runSearch = useSearchRunner({
    targets: scope.targets,
    form,
    search,
    inlineError,
    multiRoot: scope.multiRoot,
    t,
  });
  useDebouncedSearch({
    query: form.query,
    inlineError,
    targetCount: scope.targets.length,
    runSearch,
    search,
  });
  const replaceActions = createReplaceActions({
    targets: scope.targets,
    targetsScopeKey: scope.targetsScopeKey,
    multiRoot: scope.multiRoot,
    form,
    replace,
    refs,
    openBuffers,
    inlineError,
    t,
  });
  const openMatch = (match: RootAwareSearchResult): void => {
    openEditorFile?.({
      root: match.root,
      path: match.path,
      lineStart: match.lineRange.startLine,
      lineEnd: match.lineRange.endLine,
    });
  };
  return { runSearch, openMatch, ...replaceActions };
}

function useSearchPanelController({
  root,
  roots,
  openEditorFile,
}: SearchPanelProps): SearchPanelController {
  const t = useOptionalWidgetTranslate();
  const openBuffers = useWorkspaceReplaceBuffers();
  const scope = useSearchPanelScope(root, roots, t);
  const refs = useReplaceOperationRefs(scope.targetsScopeKey);
  const form = useSearchFormState();
  const search = useSearchResultsState(scope.targetsScopeKey);
  const replace = useReplaceResultsState(scope.targetsScopeKey, refs);
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const controlsId = useId();
  const presentation = useSearchPanelPresentation(scope, form, search, t);
  const actions = useSearchPanelActions({
    scope,
    form,
    search,
    replace,
    refs,
    openBuffers,
    openEditorFile,
    inlineError: presentation.inlineError,
    t,
  });
  useSearchFocus(queryInputRef);
  return {
    t,
    projectName: scope.projectName,
    targets: scope.targets,
    multiRoot: scope.multiRoot,
    queryInputRef,
    controlsId,
    form,
    search,
    replace,
    ...presentation,
    ...actions,
  };
}

function ToggleButton({
  pressed,
  onClick,
  children,
}: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button className={styles.modeButton} type="button" aria-pressed={pressed} onClick={onClick}>
      {children}
    </button>
  );
}

function SearchQueryHeader({
  controller,
}: {
  readonly controller: SearchPanelController;
}): ReactNode {
  const { form, queryInputRef, targets, controlsId, t, projectName } = controller;
  return (
    <>
      <div className="srch-box">
        <SearchIcon size={15} aria-hidden="true" />
        <input
          ref={queryInputRef}
          type="search"
          aria-label={t("searchPanel.input.ariaLabel")}
          aria-describedby={controlsId}
          placeholder={t("searchPanel.input.placeholder")}
          value={form.query}
          disabled={targets.length === 0}
          onChange={(event) => form.setQuery(event.target.value)}
        />
      </div>
      <div className="tw-label srch-label">
        {projectName}{" "}
        <span className="srch-meta mono">{t("searchPanel.label.workspaceSearch")}</span>
      </div>
    </>
  );
}

function SearchModeControls({
  controller,
}: {
  readonly controller: SearchPanelController;
}): ReactNode {
  const { form, t } = controller;
  return (
    <div className={styles.controlRow}>
      <div className={styles.modeGroup} aria-label={t("searchPanel.group.searchDomain")}>
        <ToggleButton
          pressed={form.searchDomain === "text"}
          onClick={() => form.setSearchDomain("text")}
        >
          {t("searchPanel.domain.text")}
        </ToggleButton>
        <ToggleButton
          pressed={form.searchDomain === "symbols"}
          onClick={() => form.setSearchDomain("symbols")}
        >
          {t("searchPanel.domain.symbols")}
        </ToggleButton>
      </div>
      <div className={styles.modeGroup} aria-label={t("searchPanel.group.searchMode")}>
        <ToggleButton pressed={form.mode === "literal"} onClick={() => form.setMode("literal")}>
          {t("searchPanel.mode.literal")}
        </ToggleButton>
        <ToggleButton pressed={form.mode === "regex"} onClick={() => form.setMode("regex")}>
          {t("searchPanel.mode.regex")}
        </ToggleButton>
      </div>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={form.caseSensitive}
          onChange={(event) => form.setCaseSensitive(event.target.checked)}
        />{" "}
        {t("searchPanel.option.caseSensitive")}
      </label>
      <label className={styles.checkLabel}>
        <input
          type="checkbox"
          checked={form.wholeWord}
          onChange={(event) => form.setWholeWord(event.target.checked)}
        />{" "}
        {t("searchPanel.option.matchWholeWord")}
      </label>
    </div>
  );
}

function SearchGlobFields({
  controller,
}: {
  readonly controller: SearchPanelController;
}): ReactNode {
  const { form, t } = controller;
  return (
    <div className={styles.globGrid}>
      <label className={styles.fieldLabel}>
        {t("searchPanel.field.includeGlob")}
        <input
          className={`${styles.globInput} mono`}
          value={form.includeText}
          placeholder={t("searchPanel.field.includeGlobPlaceholder")}
          onChange={(event) => form.setIncludeText(event.target.value)}
        />
      </label>
      <label className={styles.fieldLabel}>
        {t("searchPanel.field.excludeGlob")}
        <input
          className={`${styles.globInput} mono`}
          value={form.excludeText}
          placeholder={t("searchPanel.field.excludeGlobPlaceholder")}
          onChange={(event) => form.setExcludeText(event.target.value)}
        />
      </label>
    </div>
  );
}

function ReplaceControls({
  controller,
}: {
  readonly controller: SearchPanelController;
}): ReactNode {
  const { form, targets, inlineError, previewReplace, t } = controller;
  return (
    <>
      <label className={styles.fieldLabel}>
        {t("searchPanel.field.replacement")}
        <input
          className={`${styles.globInput} mono`}
          value={form.replacement}
          placeholder={t("searchPanel.field.replacementPlaceholder")}
          onChange={(event) => form.setReplacement(event.target.value)}
        />
      </label>
      <button
        className={styles.modeButton}
        type="button"
        disabled={targets.length === 0 || form.query.trim().length === 0 || inlineError !== null}
        onClick={() => void previewReplace()}
      >
        {t("searchPanel.action.previewReplace")}
      </button>
    </>
  );
}

function SearchControls({ controller }: { readonly controller: SearchPanelController }): ReactNode {
  return (
    <form
      className={styles.controls}
      onSubmit={(event) => {
        event.preventDefault();
        void controller.runSearch();
      }}
    >
      <SearchQueryHeader controller={controller} />
      <SearchModeControls controller={controller} />
      <SearchGlobFields controller={controller} />
      <ReplaceControls controller={controller} />
    </form>
  );
}

function SearchPanelOutput({
  controller,
}: {
  readonly controller: SearchPanelController;
}): ReactNode {
  const { controlsId, inlineError, search, replace, t } = controller;
  return (
    <>
      {/* <output> owns role=status; NATIVE_BLOCK_STYLE restores the block box the <div> had,
          because .status declares no display of its own (#2721). */}
      <output
        id={controlsId}
        className={`${styles.status} ${(inlineError ?? search.routeError) ? styles.error : ""}`}
        style={NATIVE_BLOCK_STYLE}
      >
        {controller.message}
      </output>
      <RootErrors errors={search.rootErrors} operation="searched" t={t} />
      {replace.status !== null ? (
        <output className={styles.status} style={NATIVE_BLOCK_STYLE}>
          {replace.status}
        </output>
      ) : null}
      <RootErrors errors={replace.errors} operation="previewed" t={t} />
    </>
  );
}

function SearchPanelResults({
  controller,
}: {
  readonly controller: SearchPanelController;
}): ReactNode {
  const { groups, multiRoot, search, replace, openMatch, applyReplacePreview, t } = controller;
  return (
    <>
      {groups.length > 0 ? (
        <SearchResultList
          groups={groups}
          showRootLabels={multiRoot}
          activeIndex={search.activeIndex}
          onActiveIndexChange={search.setActiveIndex}
          onOpen={openMatch}
        />
      ) : null}
      <ReplaceReviews
        previews={replace.previews}
        multiRoot={multiRoot}
        applyingRootId={replace.applyingRootId}
        appliedRootIds={replace.appliedRootIds}
        messages={replace.messages}
        onApply={(preview) => void applyReplacePreview(preview)}
        t={t}
      />
    </>
  );
}

function SearchPanelState(props: SearchPanelProps): ReactNode {
  const controller = useSearchPanelController(props);

  return (
    <div className={`srch ${styles.panel}`}>
      <SearchControls controller={controller} />
      <SearchPanelOutput controller={controller} />
      <SearchPanelResults controller={controller} />
    </div>
  );
}
