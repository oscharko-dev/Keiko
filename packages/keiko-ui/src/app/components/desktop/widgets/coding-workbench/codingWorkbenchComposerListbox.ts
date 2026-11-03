"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CODING_WORKBENCH_PROMPT_MENTIONS_MAX } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingWorkbenchCommandsStatus } from "@/lib/useCodingWorkbenchCommands";

// The keyboard model and token state every pop-up list of the Coding Workbench composer shares: the
// `@` file picker, the `/` command menu and the `$` skill menu. Focus never leaves the textarea; an
// open list owns the arrow keys, Enter, Tab and Escape, and everything else reaches the textarea as
// usual. One implementation, so the lists cannot drift apart.

export interface ListboxKeyContext<T> {
  readonly open: boolean;
  readonly options: readonly T[];
  readonly highlighted: number;
  readonly setHighlighted: (update: (current: number) => number) => void;
  readonly dismiss: () => void;
  readonly pick: (option: T) => void;
}

const SELECT_KEYS: ReadonlySet<string> = new Set(["Enter", "Tab"]);

function nextHighlight(current: number, count: number, step: 1 | -1): number {
  return (current + step + count) % count;
}

function navigationStep(key: string): 1 | -1 | undefined {
  if (key === "ArrowDown") return 1;
  return key === "ArrowUp" ? -1 : undefined;
}

/** The arrow keys move the active option; Enter or Tab picks it. */
function handleListKey<T>(context: ListboxKeyContext<T>, event: KeyboardEvent): boolean {
  const { options, highlighted, setHighlighted, pick } = context;
  const step = navigationStep(event.key);
  if (step !== undefined) {
    event.preventDefault();
    setHighlighted((current) => nextHighlight(current, options.length, step));
    return true;
  }
  const chosen = options[Math.min(highlighted, options.length - 1)];
  if (!SELECT_KEYS.has(event.key) || event.shiftKey || chosen === undefined) return false;
  event.preventDefault();
  pick(chosen);
  return true;
}

/** The list's share of a key press; true when it consumed the key. */
export function handleListboxKey<T>(context: ListboxKeyContext<T>, event: KeyboardEvent): boolean {
  if (!context.open || event.nativeEvent.isComposing) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    context.dismiss();
    return true;
  }
  return context.options.length > 0 && handleListKey(context, event);
}

/** Moves the caret behind an inserted token once the new draft has been rendered. */
export function useCaretAfterInsert(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
): (position: number) => void {
  const [caret, setCaret] = useState<number | null>(null);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (caret === null || textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    setCaret(null);
  }, [caret, textareaRef]);
  return setCaret;
}

export type ComposerMenuStatus = "loading" | "found" | "empty" | "none" | "error";

/** What a menu says about its listing: a failed read never passes for an empty one. */
export function composerMenuStatus(
  listing: CodingWorkbenchCommandsStatus,
  offered: number,
  shown: number,
): ComposerMenuStatus {
  if (listing === "error") return "error";
  if (listing !== "ready") return "loading";
  if (offered === 0) return "none";
  return shown === 0 ? "empty" : "found";
}

export interface ComposerTokenState<T> {
  readonly token: T | null;
  readonly open: boolean;
  readonly highlighted: number;
  readonly setHighlighted: (update: (current: number) => number) => void;
  /** Tells the menu where the caret stands; opens, narrows or closes it against the draft. */
  readonly track: (cursor: number | null) => void;
  readonly dismiss: () => void;
  readonly close: () => void;
}

/**
 * The token under the caret, read from the current draft by `find`: whether the menu is open, which
 * option is active, and Escape. Only the caret is remembered, so a draft that was cleared or replaced
 * (a task started) leaves no menu, and no Escape, behind for the next one.
 */
export function useComposerToken<T extends { readonly query: string }>(
  enabled: boolean,
  find: (cursor: number) => T | null,
): ComposerTokenState<T> {
  const [cursor, setCursor] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const token = enabled && cursor !== null ? find(cursor) : null;
  const query = token?.query ?? null;
  // Narrowing the name starts again at the best match.
  useEffect(() => {
    setHighlighted(0);
  }, [query]);
  useEffect(() => {
    if (query === null) setDismissed(false);
  }, [query]);
  useEffect(() => {
    if (!enabled) setCursor(null);
  }, [enabled]);
  const track = useCallback((next: number | null): void => setCursor(next), []);
  const dismiss = useCallback((): void => setDismissed(true), []);
  const close = useCallback((): void => {
    setCursor(null);
    setDismissed(false);
  }, []);
  return {
    token,
    open: token !== null && !dismissed,
    highlighted,
    setHighlighted,
    track,
    dismiss,
    close,
  };
}

interface InsertedToken {
  readonly value: string;
  readonly cursor: number;
}

export interface TokenPickInput<T, O> {
  readonly onDraftChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly state: ComposerTokenState<T>;
  /** The draft with the option written over the token, and where the caret goes. */
  readonly insert: (token: T, option: O) => InsertedToken;
  readonly onPicked?: (option: O) => void;
}

/** Choosing an option writes it over the token and puts the caret behind it. */
export function useTokenPick<T, O>(input: TokenPickInput<T, O>): (option: O) => void {
  const { onDraftChange, textareaRef, insert, onPicked } = input;
  const { token, dismiss, close } = input.state;
  const placeCaret = useCaretAfterInsert(textareaRef);
  return useCallback(
    (option: O): void => {
      if (token === null) {
        dismiss();
        return;
      }
      const inserted = insert(token, option);
      onDraftChange(inserted.value);
      onPicked?.(option);
      close();
      placeCaret(inserted.cursor);
    },
    [close, dismiss, insert, onDraftChange, onPicked, placeCaret, token],
  );
}

/** The names picked so far, in order and bounded; a pick the human deleted is no longer mentioned. */
export function usePickedNames(enabled: boolean): {
  readonly picked: readonly string[];
  readonly add: (name: string) => void;
} {
  const [picked, setPicked] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!enabled) setPicked([]);
  }, [enabled]);
  const add = useCallback((name: string): void => {
    setPicked((current) =>
      current.includes(name) || current.length >= CODING_WORKBENCH_PROMPT_MENTIONS_MAX
        ? current
        : [...current, name],
    );
  }, []);
  return { picked, add };
}

export interface ComposerListbox {
  readonly highlighted: number;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  /** The id of the option list for `aria-controls`, present only while a list is on screen. */
  readonly controls: string | undefined;
  /** Keyboard navigation while the menu is open; true when the key was the menu's. */
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/** The ids and keyboard handling of one menu's option list; `name` keeps the ids distinct. */
export function useComposerListbox<T>(
  name: string,
  status: ComposerMenuStatus,
  context: ListboxKeyContext<T>,
): ComposerListbox {
  const baseId = useId();
  const { open, options, highlighted, setHighlighted, dismiss, pick } = context;
  const listId = `${baseId}-${name}s`;
  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
      handleListboxKey({ open, options, highlighted, setHighlighted, dismiss, pick }, event),
    [dismiss, highlighted, open, options, pick, setHighlighted],
  );
  return {
    highlighted: Math.min(highlighted, Math.max(options.length - 1, 0)),
    listId,
    optionId: (index: number): string => `${baseId}-${name}-${String(index)}`,
    controls: open && status === "found" ? listId : undefined,
    handleKey,
  };
}
