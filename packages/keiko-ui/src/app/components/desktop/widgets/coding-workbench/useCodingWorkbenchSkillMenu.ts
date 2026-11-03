"use client";

import { useCallback, useMemo, type KeyboardEvent, type RefObject } from "react";
import type { CodingWorkbenchMentionableSkill } from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import type { CodingWorkbenchCommandsStatus } from "@/lib/useCodingWorkbenchCommands";
import {
  composerMenuStatus,
  useComposerListbox,
  useComposerToken,
  usePickedNames,
  useTokenPick,
  type ComposerMenuStatus,
} from "./codingWorkbenchComposerListbox";
import {
  insertMention,
  mentionTokenAtCursor,
  namesStillMentioned,
  type MentionToken,
} from "./codingWorkbenchPromptMentions";
import { filterCommands } from "./codingWorkbenchSlashCommands";

export interface SkillMenuInput {
  /** False hides the menu and drops every pick: the run offers no mentions, or none yet. */
  readonly enabled: boolean;
  /** The run's skills and the state of their read, shared with the `@` list's subagents. */
  readonly skills: readonly CodingWorkbenchMentionableSkill[];
  readonly status: CodingWorkbenchCommandsStatus;
  readonly retry: () => void;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export interface SkillMenu {
  readonly open: boolean;
  readonly status: ComposerMenuStatus;
  readonly options: readonly CodingWorkbenchMentionableSkill[];
  readonly highlighted: number;
  readonly listId: string;
  readonly optionId: (index: number) => string;
  readonly controls: string | undefined;
  /** Tells the menu where the caret stands; opens, narrows or closes it against the draft. */
  readonly track: (cursor: number | null) => void;
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly pick: (option: CodingWorkbenchMentionableSkill) => void;
  readonly dismiss: () => void;
  readonly retry: () => void;
  /** The skills a draft still names, in the order they were picked: what a prompt mentions. */
  readonly skillsFor: (draft: string) => readonly string[];
}

const NO_OPTIONS: readonly CodingWorkbenchMentionableSkill[] = Object.freeze([]);

function insertSkill(
  draft: string,
): (
  token: MentionToken,
  option: CodingWorkbenchMentionableSkill,
) => ReturnType<typeof insertMention> {
  return (token, option) => insertMention(draft, token, "$", option.id);
}

/**
 * The `$` skill menu of the Workbench composer (S15, #3906): it opens while the caret is inside a
 * `$` token, narrows as the name is typed, and writes the chosen `$id ` into the draft. The skills
 * are the run's runtime's own listing; the prompt mentions a picked skill while its text names it.
 */
export function useSkillMentionMenu(input: SkillMenuInput): SkillMenu {
  const { enabled, draft, skills, onDraftChange, textareaRef } = input;
  const state = useComposerToken(enabled, (cursor) => mentionTokenAtCursor(draft, cursor, "$"));
  const { token, open, highlighted, setHighlighted, dismiss } = state;
  const { picked, add } = usePickedNames(enabled);
  const query = token?.query ?? "";
  const matches = useMemo(() => filterCommands(skills, query), [skills, query]);
  const status = composerMenuStatus(input.status, skills.length, matches.length);
  const options = status === "found" ? matches : NO_OPTIONS;
  const insert = useMemo(() => insertSkill(draft), [draft]);
  const onPicked = useCallback(
    (option: CodingWorkbenchMentionableSkill): void => add(option.id),
    [add],
  );
  const pick = useTokenPick({ onDraftChange, textareaRef, state, insert, onPicked });
  const listbox = useComposerListbox("skill", status, {
    open,
    options,
    highlighted,
    setHighlighted,
    dismiss,
    pick,
  });
  return {
    ...listbox,
    open,
    status,
    options,
    track: state.track,
    pick,
    dismiss,
    retry: input.retry,
    skillsFor: (value: string): readonly string[] => namesStillMentioned(value, picked, "$"),
  };
}
