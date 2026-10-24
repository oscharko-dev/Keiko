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
  CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES,
  type CodingWorkbenchCommand,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import {
  useCodingWorkbenchCommands,
  type CodingWorkbenchCommandsStatus,
} from "@/lib/useCodingWorkbenchCommands";
import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import type { CodingWorkbenchMessageKey } from "./coding-workbench-i18n.en";
import { handleListboxKey, useCaretAfterInsert } from "./codingWorkbenchComposerListbox";
import {
  commandNameSet,
  filterCommands,
  insertCommand,
  slashSubmission,
  slashTokenAtCursor,
  startsLikeCommand,
  type CommandOption,
  type SlashSubmission,
  type SlashToken,
} from "./codingWorkbenchSlashCommands";

type SlashMenuStatus = "loading" | "found" | "empty" | "none" | "error";

export interface SlashMenuInput {
  /**
   * False hides the menu and recognizes no command: the runtime offers none, a turn is running, or
   * the run is between states. A draft is then ordinary text, whatever it starts with.
   */
  readonly enabled: boolean;
  /**
   * The paused run whose runtime lists the commands. Absent for a new task, which is offered the
   * built-in commands every native run starts with, before any run exists to list them.
   */
  readonly runId: string | undefined;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly t: CodingWorkbenchTranslate;
}

/** How a draft reads at the moment it is sent. */
export interface DraftCommand {
  /** The offered command the draft names, with the text after it; none for ordinary text. */
  readonly submission: SlashSubmission | null;
  /** True while the listing that decides whether the draft names a command is still being read. */
  readonly pending: boolean;
}

export interface SlashMenu {
  readonly open: boolean;
  readonly status: SlashMenuStatus;
  /** The options to choose from: those matching what was typed, none unless `status` is `found`. */
  readonly options: readonly CommandOption[];
  readonly highlighted: number;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  /** The id of the option list for `aria-controls`, present only while a list is on screen. */
  readonly controls: string | undefined;
  /** Tells the menu where the caret stands; opens, narrows or closes it against the draft. */
  readonly track: (cursor: number | null) => void;
  /** Keyboard navigation while the menu is open; true when the key was the menu's. */
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly pick: (option: CommandOption) => void;
  readonly dismiss: () => void;
  /** Reads the listing again after a failed read. */
  readonly retry: () => void;
  /** Whether a draft names an offered command; for a draft read straight from the textarea. */
  readonly inspect: (draft: string) => DraftCommand;
}

// The commands the product describes in its own words, in both languages. A command the runtime
// lists beyond these is shown with the runtime's own description.
const LOCALIZED_DESCRIPTIONS: ReadonlyMap<string, CodingWorkbenchMessageKey> = new Map([
  ["init", "codingWorkbench.composer.commands.init.description"],
  ["review", "codingWorkbench.composer.commands.review.description"],
]);

const NO_COMMANDS: readonly CodingWorkbenchCommand[] = Object.freeze([]);
const NO_OPTIONS: readonly CommandOption[] = Object.freeze([]);
const NO_NAMES: ReadonlySet<string> = new Set();
const BUILT_IN_COMMANDS: readonly CodingWorkbenchCommand[] = Object.freeze(
  CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES.map((name) => ({ name })),
);
const NOT_A_COMMAND: DraftCommand = { submission: null, pending: false };

interface OfferedCommands {
  readonly status: CodingWorkbenchCommandsStatus;
  readonly commands: readonly CodingWorkbenchCommand[];
  readonly retry: () => void;
}

/**
 * The commands this composer offers: the run's own listing for a paused run, read the first time a
 * draft looks like a command, and the built-ins for a task that has no run yet.
 */
function useOfferedCommands(
  enabled: boolean,
  runId: string | undefined,
  wanted: boolean,
): OfferedCommands {
  const listing = useCodingWorkbenchCommands({
    runId: enabled ? runId : undefined,
    wanted: wanted && enabled,
  });
  if (!enabled) return { status: "idle", commands: NO_COMMANDS, retry: listing.retry };
  if (runId === undefined) {
    return { status: "ready", commands: BUILT_IN_COMMANDS, retry: listing.retry };
  }
  return listing;
}

function describeCommand(
  command: CodingWorkbenchCommand,
  t: CodingWorkbenchTranslate,
): CommandOption {
  const key = LOCALIZED_DESCRIPTIONS.get(command.name);
  return {
    name: command.name,
    description: key === undefined ? (command.description ?? "") : t(key),
  };
}

/** The offered commands matching what was typed after the slash, described in the person's language. */
function useCommandOptions(
  commands: readonly CodingWorkbenchCommand[],
  query: string,
  t: CodingWorkbenchTranslate,
): readonly CommandOption[] {
  return useMemo(
    () =>
      filterCommands(
        commands.map((command) => describeCommand(command, t)),
        query,
      ),
    [commands, query, t],
  );
}

function menuStatus(offered: OfferedCommands, shown: number): SlashMenuStatus {
  if (offered.status === "error") return "error";
  if (offered.status !== "ready") return "loading";
  if (offered.commands.length === 0) return "none";
  return shown === 0 ? "empty" : "found";
}

interface SlashState {
  readonly token: SlashToken | null;
  readonly open: boolean;
  readonly highlighted: number;
  readonly setHighlighted: (update: (current: number) => number) => void;
  readonly track: (cursor: number | null) => void;
  readonly dismiss: () => void;
  readonly close: () => void;
}

/**
 * The `/` token under the caret, read from the current draft: whether the menu is open, which option
 * is active, and Escape. Only the caret is remembered, so a draft that was cleared or replaced (a
 * task started) leaves no menu, and no Escape, behind for the next one.
 */
function useSlashState(enabled: boolean, draft: string): SlashState {
  const [cursor, setCursor] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const token = enabled && cursor !== null ? slashTokenAtCursor(draft, cursor) : null;
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

/** Choosing a command writes `/name ` into the draft and puts the caret behind the space. */
function useSlashPick(input: SlashMenuInput, state: SlashState): (option: CommandOption) => void {
  const { draft, onDraftChange, textareaRef } = input;
  const { token, dismiss, close } = state;
  const placeCaret = useCaretAfterInsert(textareaRef);
  return useCallback(
    (option: CommandOption): void => {
      if (token === null) {
        dismiss();
        return;
      }
      const inserted = insertCommand(draft, token, option.name);
      onDraftChange(inserted.value);
      close();
      placeCaret(inserted.cursor);
    },
    [close, dismiss, draft, onDraftChange, placeCaret, token],
  );
}

/**
 * Reads a draft against the offered commands. A live run's listing decides, so a draft that opens
 * like a command waits (`pending`) while that listing is read; a failed read recognizes nothing and
 * the draft is ordinary text.
 */
function useInspectDraft(
  enabled: boolean,
  live: boolean,
  offered: OfferedCommands,
): (draft: string) => DraftCommand {
  const names = useMemo(
    () => (offered.status === "ready" ? commandNameSet(offered.commands) : NO_NAMES),
    [offered.commands, offered.status],
  );
  const reading = offered.status === "idle" || offered.status === "loading";
  return useCallback(
    (draft: string): DraftCommand => {
      if (!enabled) return NOT_A_COMMAND;
      const submission = slashSubmission(draft, names);
      return {
        submission,
        pending: live && reading && submission === null && startsLikeCommand(draft),
      };
    },
    [enabled, live, names, reading],
  );
}

/**
 * The `/` command menu of the Workbench composer (ADR-0137 D10): it opens while the draft starts
 * with `/` and the caret is inside that first token, narrows as the name is typed, and writes the
 * chosen `/name ` into the draft. Focus never leaves the textarea; the arrow keys, Enter or Tab, and
 * Escape drive it like the `@` picker. The command is read from the draft again when it is sent, so
 * a `/name` that is not offered goes out as ordinary text.
 */
export function useSlashCommandMenu(input: SlashMenuInput): SlashMenu {
  const { enabled, runId, draft, t } = input;
  const baseId = useId();
  const state = useSlashState(enabled, draft);
  const { token, open, highlighted, setHighlighted, dismiss } = state;
  const offered = useOfferedCommands(enabled, runId, open || startsLikeCommand(draft));
  const matches = useCommandOptions(offered.commands, token?.query ?? "", t);
  const status = menuStatus(offered, matches.length);
  const options = status === "found" ? matches : NO_OPTIONS;
  const pick = useSlashPick(input, state);
  const inspect = useInspectDraft(enabled, runId !== undefined, offered);
  const listId = `${baseId}-slash-commands`;
  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean =>
      handleListboxKey({ open, options, highlighted, setHighlighted, dismiss, pick }, event),
    [dismiss, highlighted, open, options, pick, setHighlighted],
  );
  return {
    open,
    status,
    options,
    highlighted: Math.min(highlighted, Math.max(options.length - 1, 0)),
    listId,
    optionId: (index: number): string => `${baseId}-slash-command-${String(index)}`,
    controls: open && status === "found" ? listId : undefined,
    track: state.track,
    handleKey,
    pick,
    dismiss,
    retry: offered.retry,
    inspect,
  };
}
