import {
  isCodingWorkbenchCommandName,
  type CodingWorkbenchCommand,
  type CodingWorkbenchCommandRequest,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";

// Pure string helpers for the `/` command menu of a Coding Workbench prompt (ADR-0137 D10). A slash
// command is a server-authored prompt template: the draft names one and the text after it, and the
// request carries the name and that text. Whether the run's runtime offers the name is the server's
// decision when the turn is dispatched; nothing here is authority.

/** The `/` token being typed: the text after the slash and where the first token ends. */
export interface SlashToken {
  /** What follows the `/` up to the end of the first token, which may be empty. */
  readonly query: string;
  /** The index just past the first token, where the draft's first whitespace (or its end) is. */
  readonly end: number;
}

/** What a `/` token may hold while it is still being typed: the characters of a command name. */
const SLASH_QUERY = /^[A-Za-z0-9._:-]{0,64}$/u;

function firstTokenEnd(value: string): number {
  const whitespace = value.search(/\s/u);
  return whitespace < 0 ? value.length : whitespace;
}

/**
 * The command token the caret is inside, when there is one: the draft starts with `/`, the caret
 * stands behind that slash and no further than the end of the first token, and the token holds only
 * command-name characters. Once whitespace follows, the draft is the command's text and the menu is
 * done; a path such as `/usr/bin`, which holds a second slash, never opens it.
 */
export function slashTokenAtCursor(value: string, cursor: number): SlashToken | null {
  if (!value.startsWith("/")) return null;
  const end = firstTokenEnd(value);
  if (cursor < 1 || cursor > end) return null;
  const query = value.slice(1, end);
  return SLASH_QUERY.test(query) ? { query, end } : null;
}

/**
 * The commands whose name contains what was typed, ignoring case, name prefixes first; the listing's
 * own order is kept within each group so the best match is the first option.
 */
export function filterCommands<T extends { readonly name: string }>(
  commands: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.toLowerCase();
  if (needle.length === 0) return commands;
  const prefixed: T[] = [];
  const contained: T[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) prefixed.push(command);
    else if (name.includes(needle)) contained.push(command);
  }
  return [...prefixed, ...contained];
}

/**
 * The draft with the command token under the caret replaced by the chosen command, and the new
 * caret just behind the space that separates it from the text: an existing space is reused, so
 * choosing a command inside `/re some text` does not double it.
 */
export function insertCommand(
  draft: string,
  token: SlashToken,
  name: string,
): { readonly value: string; readonly cursor: number } {
  const suffix = draft.slice(token.end);
  const head = `/${name}`;
  const separated = /^\s/u.test(suffix);
  return {
    value: `${head}${separated ? "" : " "}${suffix}`,
    cursor: head.length + 1,
  };
}

/** A draft that names an offered command: the command and the text after it, trimmed. */
export interface SlashSubmission {
  readonly command: CodingWorkbenchCommandRequest;
  /** The command's arguments; empty for a bare command such as `/review`. */
  readonly text: string;
}

/**
 * Reads a draft as a command when it starts with `/<name>` followed by the end of the text or
 * whitespace, and `<name>` is one of the offered commands, compared exactly. Anything else is
 * ordinary text, `/foo` included: the person who wrote it means it literally. The draft is not
 * trimmed first, so the command must open the text, as the menu requires.
 */
export function slashSubmission(
  draft: string,
  offered: ReadonlySet<string>,
): SlashSubmission | null {
  if (!draft.startsWith("/")) return null;
  const end = firstTokenEnd(draft);
  const name = draft.slice(1, end);
  if (!isCodingWorkbenchCommandName(name) || !offered.has(name)) return null;
  return { command: { name }, text: draft.slice(end).trim() };
}

/**
 * Whether the draft opens like a command (`/<name>` plus whitespace or the end) whatever the
 * offered commands are: what a send has to wait for while the listing that decides it is read.
 */
export function startsLikeCommand(draft: string): boolean {
  return (
    draft.startsWith("/") && isCodingWorkbenchCommandName(draft.slice(1, firstTokenEnd(draft)))
  );
}

/** A command as the menu shows it: its name and one line saying what it does. */
export interface CommandOption {
  readonly name: string;
  readonly description: string;
}

/** The names a draft may start with as a command. */
export function commandNameSet(
  commands: readonly Pick<CodingWorkbenchCommand, "name">[],
): ReadonlySet<string> {
  return new Set(commands.map((command) => command.name));
}
