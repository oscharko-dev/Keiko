"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  CODING_WORKBENCH_PROMPT_REFERENCES_MAX,
  type CodingWorkbenchPromptReference,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { fetchFilesSearch } from "@/lib/api";
import { reportClientDiagnostic } from "@/lib/client-diagnostics";
import { bffRequestErrorKind } from "@/lib/http";
import { handleListboxKey, useCaretAfterInsert } from "./codingWorkbenchComposerListbox";
import {
  canPickReference,
  fileMentionAtCursor,
  fileReferenceOption,
  insertFileMention,
  referencesInDraft,
  removeFileMention,
  type FileMention,
  type FileReferenceOption,
} from "./codingWorkbenchPromptReferences";

/** The picker offers a short list; the human narrows it by typing more of the name. */
const FILE_REFERENCE_SEARCH_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 150;

type FileReferenceSearchStatus = "idle" | "searching" | "found" | "empty" | "error";

export interface FileReferencePickerInput {
  /** False hides the picker and drops every pick: the run offers no references, or has no root. */
  readonly enabled: boolean;
  /** The run's workspace root the file search runs against; the picker needs one. */
  readonly root: string | null;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export interface FileReferencePicker {
  readonly open: boolean;
  readonly status: FileReferenceSearchStatus;
  readonly options: readonly FileReferenceOption[];
  readonly highlighted: number;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  /** The files the draft still names, in the order they were picked: what a prompt sends. */
  readonly references: readonly CodingWorkbenchPromptReference[];
  /** The same for a draft read straight from the textarea, which may be ahead of React's state. */
  readonly referencesFor: (draft: string) => readonly CodingWorkbenchPromptReference[];
  /** The id of the option list for `aria-controls`, present only while a list is on screen. */
  readonly controls: string | undefined;
  /** True once the contract's bound of referenced files is reached. */
  readonly atLimit: boolean;
  /** Tells the picker the draft or the caret moved; opens, narrows or closes the mention. */
  readonly track: (value: string, cursor: number | null) => void;
  /** Keyboard navigation while the list is open; true when the key was the picker's. */
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly pick: (option: FileReferenceOption) => void;
  readonly remove: (path: string) => void;
  readonly dismiss: () => void;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

interface SearchState {
  readonly status: FileReferenceSearchStatus;
  readonly options: readonly FileReferenceOption[];
}

const IDLE_SEARCH: SearchState = { status: "idle", options: [] };
const NO_PATHS: readonly string[] = Object.freeze([]);

/** The files a search found that the message does not reference yet. */
function searchOptions(
  root: string,
  results: Awaited<ReturnType<typeof fetchFilesSearch>>["results"],
  pickedKey: string,
): FileReferenceOption[] {
  const already = new Set(pickedKey.split("\u0000"));
  return results
    .map((result) => fileReferenceOption(root, result))
    .filter(
      (option): option is FileReferenceOption => option !== null && !already.has(option.path),
    );
}

/**
 * Searches the run's workspace for the text after the `@`, through the Files surface's own search
 * (no second file index). Debounced and cancelled by the next keystroke; a failure is reported
 * body-free and shown as a retryable state, never as an empty result.
 */
function useFileSearch(
  root: string | null,
  query: string | null,
  picked: readonly string[],
): SearchState {
  const [state, setState] = useState<SearchState>(IDLE_SEARCH);
  const pickedKey = picked.join("\u0000");
  useEffect(() => {
    if (root === null || query === null || query.length === 0) {
      setState(IDLE_SEARCH);
      return undefined;
    }
    const controller = new AbortController();
    setState((previous) => ({ status: "searching", options: previous.options }));
    const timer = window.setTimeout(() => {
      void fetchFilesSearch(root, query, FILE_REFERENCE_SEARCH_LIMIT, { signal: controller.signal })
        .then((response) => {
          const options = searchOptions(root, response.results, pickedKey);
          setState({ status: options.length === 0 ? "empty" : "found", options });
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          // i18n-exempt: body-free diagnostic message for the activity log, never rendered
          reportClientDiagnostic("[keiko] coding workbench file reference search failed", {
            kind: "other",
            errorKind: bffRequestErrorKind(error),
          });
          setState({ status: "error", options: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return (): void => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pickedKey, query, root]);
  return state;
}

interface MentionState {
  readonly mention: FileMention | null;
  readonly open: boolean;
  readonly highlighted: number;
  readonly setHighlighted: (update: (current: number) => number) => void;
  readonly track: (value: string, cursor: number | null) => void;
  readonly dismiss: () => void;
  readonly close: () => void;
}

/** Whether the draft still holds the mention exactly as it was tracked. */
function mentionHolds(draft: string, mention: FileMention): boolean {
  return draft.slice(mention.start, mention.end) === `@${mention.query}`;
}

/**
 * The `@` token under the caret: whether it is open, which option is active, and Escape. A mention
 * the draft no longer holds (it was cleared when a task started, or replaced) is no mention: it
 * neither stays open over the next draft nor leaves its Escape behind for it.
 */
function useMentionState(enabled: boolean, draft: string): MentionState {
  const [tracked, setTracked] = useState<FileMention | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const mention = tracked !== null && mentionHolds(draft, tracked) ? tracked : null;
  const query = mention?.query;
  // Narrowing or moving to another mention starts again at the best match.
  useEffect(() => {
    setHighlighted(0);
  }, [query, mention?.start]);
  useEffect(() => {
    if (!enabled) setTracked(null);
  }, [enabled]);
  useEffect(() => {
    if (mention === null) setDismissedAt(null);
  }, [mention]);
  const track = useCallback(
    (value: string, cursor: number | null): void => {
      const next = enabled && cursor !== null ? fileMentionAtCursor(value, cursor) : null;
      setTracked(next);
      if (next === null) setDismissedAt(null);
    },
    [enabled],
  );
  const dismiss = useCallback((): void => {
    setDismissedAt(mention?.start ?? null);
  }, [mention]);
  const close = useCallback((): void => {
    setTracked(null);
    setDismissedAt(null);
  }, []);
  const open = enabled && mention !== null && dismissedAt !== mention.start;
  return { mention, open, highlighted, setHighlighted, track, dismiss, close };
}

interface PickedPaths {
  readonly picked: readonly string[];
  readonly setPicked: (paths: readonly string[]) => void;
  readonly references: readonly CodingWorkbenchPromptReference[];
  readonly paths: readonly string[];
}

/**
 * The files picked so far, as a list that never outlives the draft or the root it was searched in: a
 * pick whose `@path` token the human deleted is dropped, so what a prompt sends is what its text
 * shows, and so is every pick made under another root, whose relative paths mean something else
 * here.
 */
function usePickedPaths(enabled: boolean, draft: string, root: string | null): PickedPaths {
  const [pickedIn, setPickedIn] = useState<{
    readonly root: string | null;
    readonly paths: readonly string[];
  }>({ root, paths: [] });
  const picked = pickedIn.root === root ? pickedIn.paths : NO_PATHS;
  const setPicked = useCallback(
    (paths: readonly string[]): void => setPickedIn({ root, paths }),
    [root],
  );
  const references = useMemo(() => referencesInDraft(draft, picked), [draft, picked]);
  const paths = useMemo(() => references.map((reference) => reference.path), [references]);
  useEffect(() => {
    // Only a real difference is written back: an equal-length list is already the picked one.
    if (!enabled) {
      if (picked.length > 0) setPicked([]);
    } else if (picked.length !== paths.length) {
      setPicked(paths);
    }
  }, [enabled, picked.length, paths, setPicked]);
  return { picked, setPicked, references, paths };
}

interface PickActions {
  readonly pick: (option: FileReferenceOption) => void;
  readonly remove: (path: string) => void;
}

/** Picking inserts the `@path` token and records the file; removing takes the token out again. */
function usePickActions(
  input: FileReferencePickerInput,
  mentionState: MentionState,
  pickedPaths: PickedPaths,
): PickActions {
  const { draft, onDraftChange, textareaRef } = input;
  const { mention, dismiss, close } = mentionState;
  const { setPicked, paths } = pickedPaths;
  const placeCaret = useCaretAfterInsert(textareaRef);
  const pick = useCallback(
    (option: FileReferenceOption): void => {
      if (mention === null || !canPickReference(paths, option.path)) {
        dismiss();
        return;
      }
      const inserted = insertFileMention(draft, mention, option.path);
      onDraftChange(inserted.value);
      setPicked([...paths, option.path]);
      close();
      placeCaret(inserted.cursor);
    },
    [close, dismiss, draft, mention, onDraftChange, paths, placeCaret, setPicked],
  );
  const remove = useCallback(
    (path: string): void => {
      onDraftChange(removeFileMention(draft, path));
      textareaRef.current?.focus();
    },
    [draft, onDraftChange, textareaRef],
  );
  return { pick, remove };
}

/**
 * The `@` file picker of the Workbench composer (ADR-0137 D10). The draft keeps the human's text;
 * a picked file adds its `@path` token to the draft and its path to the references the prompt
 * sends. Focus never leaves the textarea: the list is driven with the arrow keys, Enter or Tab, and
 * Escape.
 */
export function useFileReferencePicker(input: FileReferencePickerInput): FileReferencePicker {
  const { enabled, root, draft } = input;
  const baseId = useId();
  const mentionState = useMentionState(enabled, draft);
  const { mention, open, highlighted, setHighlighted, track, dismiss } = mentionState;
  const pickedPaths = usePickedPaths(enabled, draft, root);
  const { picked, references, paths } = pickedPaths;
  const search = useFileSearch(enabled ? root : null, mention?.query ?? null, paths);
  const listId = `${baseId}-file-references`;
  const atLimit = paths.length >= CODING_WORKBENCH_PROMPT_REFERENCES_MAX;
  const { pick, remove } = usePickActions(input, mentionState, pickedPaths);
  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
      handleListboxKey(
        { open, options: search.options, highlighted, setHighlighted, dismiss, pick },
        event,
      ),
    [dismiss, highlighted, open, pick, search.options, setHighlighted],
  );
  return {
    open,
    status: search.status,
    options: search.options,
    highlighted: Math.min(highlighted, Math.max(search.options.length - 1, 0)),
    listId,
    controls: open && search.status === "found" && !atLimit ? listId : undefined,
    optionId: (index: number): string => `${baseId}-file-reference-${String(index)}`,
    references,
    referencesFor: (value: string): readonly CodingWorkbenchPromptReference[] =>
      referencesInDraft(value, picked),
    atLimit,
    track,
    handleKey,
    pick,
    remove,
    dismiss,
  };
}
