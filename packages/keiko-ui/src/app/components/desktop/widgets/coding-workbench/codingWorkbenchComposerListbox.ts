"use client";

import { useLayoutEffect, useState, type KeyboardEvent, type RefObject } from "react";

// The keyboard model both pop-up lists of the Coding Workbench composer share: the `@` file picker
// and the `/` command menu. Focus never leaves the textarea; an open list owns the arrow keys,
// Enter, Tab and Escape, and everything else reaches the textarea as usual. One implementation, so
// the two lists cannot drift apart.

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
