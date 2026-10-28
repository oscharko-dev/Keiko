"use client";

import type { RefObject } from "react";
import {
  CODING_WORKBENCH_BUILT_IN_SUBAGENTS,
  type CodingWorkbenchMentionableAgent,
  type CodingWorkbenchPromptMentions,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

import { useCodingWorkbenchCommands } from "@/lib/useCodingWorkbenchCommands";
import { promptMentionsIn } from "./codingWorkbenchPromptMentions";
import { useSkillMentionMenu, type SkillMenu } from "./useCodingWorkbenchSkillMenu";

export interface ComposerMentionsInput {
  /** False offers no mention: the run's runtime takes none, or the composer cannot send now. */
  readonly enabled: boolean;
  /** The live run whose runtime lists its subagents and skills; absent for a new task. */
  readonly runId: string | undefined;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export interface ComposerMentions {
  /** The subagents the `@` list offers: the run's own, or the built-ins before any run exists. */
  readonly agents: readonly CodingWorkbenchMentionableAgent[];
  /** The `$` list; a new task offers no skills, which only its run can list. */
  readonly skillMenu: SkillMenu;
  /**
   * The mentions of the text a prompt sends, `sent` being exactly that text (trimmed as sent) and
   * `agentNames` the subagents the `@` list recorded for the draft.
   */
  readonly mentionsFor: (
    draft: string,
    sent: string,
    agentNames: readonly string[],
  ) => CodingWorkbenchPromptMentions | undefined;
}

const NO_AGENTS: readonly CodingWorkbenchMentionableAgent[] = Object.freeze([]);
const MENTION_SIGILS = /[@$]/u;

function offeredAgents(
  enabled: boolean,
  live: boolean,
  listed: readonly CodingWorkbenchMentionableAgent[],
): readonly CodingWorkbenchMentionableAgent[] {
  if (!enabled) return NO_AGENTS;
  return live ? listed : CODING_WORKBENCH_BUILT_IN_SUBAGENTS;
}

/**
 * The `@agent` and `$skill` mentions of the Workbench composer (S15, #3906). One lazy read of the
 * run's listing serves both lists, started the first time the draft holds a sigil; what a prompt
 * mentions is computed from the text it sends, so every span names the token typed there.
 */
export function useComposerMentions(input: ComposerMentionsInput): ComposerMentions {
  const { enabled, runId, draft, onDraftChange, textareaRef } = input;
  const live = enabled && runId !== undefined;
  const listing = useCodingWorkbenchCommands({
    runId: live ? runId : undefined,
    wanted: live && MENTION_SIGILS.test(draft),
  });
  const skillMenu = useSkillMentionMenu({
    enabled: live,
    skills: listing.skills,
    status: listing.status,
    retry: listing.retry,
    draft,
    onDraftChange,
    textareaRef,
  });
  const agents = offeredAgents(enabled, live, listing.agents);
  return {
    agents,
    skillMenu,
    mentionsFor: (value, sent, agentNames) =>
      enabled
        ? promptMentionsIn(sent, { agents: agentNames, skills: skillMenu.skillsFor(value) })
        : undefined,
  };
}
