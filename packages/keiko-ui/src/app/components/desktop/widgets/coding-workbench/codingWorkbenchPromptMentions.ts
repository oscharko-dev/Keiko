import {
  CODING_WORKBENCH_PROMPT_MENTIONS_MAX,
  isCodingWorkbenchMentionName,
  type CodingWorkbenchAgentMention,
  type CodingWorkbenchPromptMentions,
  type CodingWorkbenchSkillMention,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

// Pure string helpers for the `@agent` and `$skill` mentions of a Coding Workbench prompt (S15,
// #3906). The draft holds the human's own text; a mention is a token the human picked from what the
// run's runtime lists. What a prompt sends is computed from the text it actually sends, so every
// span names exactly the token typed there. Whether the runtime lists a name is the server's call.

export type MentionSigil = "@" | "$";

/** The `$` token being typed: its range in the draft and the text after the sigil. */
export interface MentionToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** The names a draft's picks name, per kind, in the order they were picked. */
export interface PickedMentions {
  readonly agents: readonly string[];
  readonly skills: readonly string[];
}

const TOKEN_OPENERS = /[\s([{]/u;
const TOKEN_CLOSERS = /[\s.,;:!?)\]}]/u;

/**
 * The mention the caret is inside: the sigil at the start of the draft or after whitespace or an
 * opening bracket, followed by characters up to the caret that contain no whitespace and no sigil. A
 * `$` inside a word (a price, a shell variable written without a space) never opens the list.
 */
export function mentionTokenAtCursor(
  value: string,
  cursor: number,
  sigil: MentionSigil,
): MentionToken | null {
  const end = Math.max(0, Math.min(cursor, value.length));
  const prefix = value.slice(0, end);
  const start = prefix.lastIndexOf(sigil);
  if (start < 0) return null;
  const before = start === 0 ? "" : (prefix[start - 1] ?? "");
  if (before.length > 0 && !TOKEN_OPENERS.test(before)) return null;
  const query = prefix.slice(start + 1);
  if (/[\s@$]/u.test(query)) return null;
  return { start, end, query };
}

/** The draft with the token under the caret replaced by the picked name, and the new caret. */
export function insertMention(
  draft: string,
  token: Pick<MentionToken, "start" | "end">,
  sigil: MentionSigil,
  name: string,
): { readonly value: string; readonly cursor: number } {
  const prefix = draft.slice(0, token.start);
  const suffix = draft.slice(token.end);
  const needsSpace = suffix.length === 0 || !TOKEN_CLOSERS.test(suffix[0] ?? "");
  const inserted = `${sigil}${name}${needsSpace ? " " : ""}`;
  return { value: `${prefix}${inserted}${suffix}`, cursor: prefix.length + inserted.length };
}

/** Where the whole token `sigil + name` first stands in `text`, or -1. */
export function mentionIndex(text: string, sigil: MentionSigil, name: string): number {
  const token = `${sigil}${name}`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return -1;
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + token.length] ?? "";
    if (
      (before === "" || TOKEN_OPENERS.test(before)) &&
      (after === "" || TOKEN_CLOSERS.test(after))
    ) {
      return at;
    }
    from = at + 1;
  }
}

function mentionsOf<T>(
  text: string,
  names: readonly string[],
  sigil: MentionSigil,
  make: (name: string, start: number) => T,
): readonly T[] {
  const seen = new Set<string>();
  const mentions: T[] = [];
  for (const name of names) {
    if (seen.has(name) || !isCodingWorkbenchMentionName(name)) continue;
    const at = mentionIndex(text, sigil, name);
    if (at < 0) continue;
    seen.add(name);
    mentions.push(make(name, at));
    if (mentions.length === CODING_WORKBENCH_PROMPT_MENTIONS_MAX) break;
  }
  return mentions;
}

/**
 * The mentions a prompt sends: every picked name its text still names as a whole token, once, with
 * the span of that token in `text`, which must be exactly the text sent. A pick whose token the
 * human deleted is not mentioned.
 */
export function promptMentionsIn(
  text: string,
  picked: PickedMentions,
): CodingWorkbenchPromptMentions | undefined {
  const agents = mentionsOf(
    text,
    picked.agents,
    "@",
    (name, start): CodingWorkbenchAgentMention => ({
      name,
      mention: { start, end: start + name.length + 1, text: `@${name}` },
    }),
  );
  const skills = mentionsOf(text, picked.skills, "$", (id, start): CodingWorkbenchSkillMention => ({
    id,
    mention: { start, end: start + id.length + 1, text: `$${id}` },
  }));
  if (agents.length === 0 && skills.length === 0) return undefined;
  return {
    ...(agents.length === 0 ? {} : { agents }),
    ...(skills.length === 0 ? {} : { skills }),
  };
}

/** The picked names a draft still names, so a pick never outlives its token. */
export function namesStillMentioned(
  draft: string,
  names: readonly string[],
  sigil: MentionSigil,
): readonly string[] {
  return names.filter((name) => mentionIndex(draft, sigil, name) >= 0);
}
