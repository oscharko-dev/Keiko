"use client";

import type { KeyboardEvent, ReactNode } from "react";
import type {
  CodingSafeActivityFeed,
  CodingSafeActivityTool,
  CodingSafeActivityToolFailureOrigin,
  CodingSafeActivityToolOutput,
  CodingSafeActivityToolText,
} from "@oscharko-dev/keiko-contracts";
import { codingSafeActivityStateFailureOrigin } from "@oscharko-dev/keiko-contracts/runtime/coding-safe-activity";

import type { CodingWorkbenchTranslate } from "./coding-workbench-i18n";
import styles from "./CodingWorkbenchWindow.module.css";

// A tool row says what happened and who caused it: the command it ran, where a failure came from
// (Keiko's governance, the command, the tool, the clock or a stop), the message the agent was
// handed and the ends of what the command printed. Everything here is untrusted workspace text the
// server already put through the credential floor; it is rendered as text only.

/** Characters of a command's first line a collapsed row shows before an ellipsis. */
const COMMAND_PREVIEW_CHARS = 80;
/** A call's duration is worth a word from one second on. */
const SHOWN_DURATION_MS = 1_000;

/** Where a call that did not succeed failed; a failed call without a named origin is the tool's. */
export function toolFailureOrigin(
  tool: CodingSafeActivityTool,
): CodingSafeActivityToolFailureOrigin | undefined {
  const facts = tool.presentation ?? {};
  // A verification or Git step says what happened in its own outcome vocabulary.
  if (facts.verificationOutcome !== undefined || facts.gitOutcome !== undefined) return undefined;
  return facts.failureOrigin ?? codingSafeActivityStateFailureOrigin(tool.state, facts.exitCode);
}

/** A failure a person has to read opens by itself; a stopped call stays one line. */
export function opensWithFailure(origin: CodingSafeActivityToolFailureOrigin | undefined): boolean {
  return origin !== undefined && origin !== "cancelled";
}

/** The first line of a command, shortened to one row with an ellipsis. */
export function commandPreview(command: CodingSafeActivityToolText): string {
  const [first = ""] = command.text.split("\n");
  const cut = first.length > COMMAND_PREVIEW_CHARS || command.text.includes("\n");
  return cut || command.truncated ? `${first.slice(0, COMMAND_PREVIEW_CHARS)}…` : first;
}

// The row's one-line preview already shows a short, single-line command whole; the opened row then
// does not repeat it.
function previewShowsWhole(command: CodingSafeActivityToolText): boolean {
  return !command.truncated && commandPreview(command) === command.text;
}

export function ToolCommandPreview({
  command,
}: {
  readonly command: CodingSafeActivityToolText;
}): ReactNode {
  return (
    <code className={styles.cmpToolCommandLine} translate="no">
      <span aria-hidden="true">$ </span>
      {commandPreview(command)}
    </code>
  );
}

/** The short label at the end of a failed row: who caused it, and how often it failed already. */
export function ToolFailureLabel({
  tool,
  origin,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly origin: CodingSafeActivityToolFailureOrigin;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const repeated = tool.presentation?.failureCount ?? 1;
  return (
    <span className={styles.cmpToolFailureLabels}>
      {repeated > 1 ? (
        <span className={styles.cmpToolRepeated}>
          {t("codingWorkbench.activity.failedTimes", { count: repeated })}
        </span>
      ) : null}
      <span className={styles.cmpToolFailureOrigin} data-origin={origin}>
        <span className={styles.cmpToolFailureIcon} aria-hidden="true" />
        {t(`codingWorkbench.activity.failureOrigin.${origin}`)}
      </span>
    </span>
  );
}

/** How long a settled call ran, muted, from one second on. */
export function ToolDuration({
  durationMs,
  t,
  format,
}: {
  readonly durationMs: number | undefined;
  readonly t: CodingWorkbenchTranslate;
  readonly format: (durationMs: number) => string;
}): ReactNode {
  if (durationMs === undefined || durationMs < SHOWN_DURATION_MS) return null;
  return (
    <span className={styles.cmpToolDuration}>
      {t("codingWorkbench.activity.took", { duration: format(durationMs) })}
    </span>
  );
}

/** What an opened failed row says first: what went wrong, in plain words, and what happens next. */
export function ToolFailureExplanation({
  tool,
  origin,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly origin: CodingSafeActivityToolFailureOrigin;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const cause = tool.presentation?.refusalCause;
  const exitCode = tool.presentation?.exitCode;
  return (
    <div className={styles.cmpToolFailure}>
      <p className={styles.cmpToolOutcome}>
        {origin === "command-failed" && exitCode !== undefined
          ? t("codingWorkbench.activity.failure.command-failed", { code: exitCode })
          : t(`codingWorkbench.activity.failure.${failureSentence(origin)}`)}
        {cause === undefined ? null : ` ${t(`codingWorkbench.activity.refusalCause.${cause}`)}`}
      </p>
      {origin === "keiko-refused" || origin === "cancelled" ? null : (
        <p className={styles.cmpToolHint}>{t("codingWorkbench.activity.failure.agentRetries")}</p>
      )}
    </div>
  );
}

function failureSentence(
  origin: CodingSafeActivityToolFailureOrigin,
): Exclude<CodingSafeActivityToolFailureOrigin, "command-failed"> | "command-failed-unknown" {
  return origin === "command-failed" ? "command-failed-unknown" : origin;
}

/** The opened row's text: the whole command, the agent's message and the output's two ends. */
export function ToolTextDetail({
  tool,
  t,
}: {
  readonly tool: CodingSafeActivityTool;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const facts = tool.presentation;
  if (facts?.detailOmitted === true) {
    return <p className={styles.cmpToolHint}>{t("codingWorkbench.activity.detailOmitted")}</p>;
  }
  if (facts === undefined) return null;
  return (
    <>
      {facts.command === undefined || previewShowsWhole(facts.command) ? null : (
        <ToolTextBlock
          label={t("codingWorkbench.activity.command")}
          text={`$ ${facts.command.text}`}
          truncated={facts.command.truncated}
          t={t}
        />
      )}
      {facts.errorText === undefined ? null : (
        <ToolTextBlock
          label={t("codingWorkbench.activity.agentMessage")}
          text={facts.errorText.text}
          truncated={facts.errorText.truncated}
          t={t}
        />
      )}
      {facts.output === undefined ? null : <ToolOutputBlock output={facts.output} t={t} />}
    </>
  );
}

function ToolTextBlock({
  label,
  text,
  truncated,
  t,
}: {
  readonly label: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return (
    <div className={styles.cmpToolBlock} role="group" aria-label={label}>
      <p className={styles.cmpToolBlockLabel} aria-hidden="true">
        {label}
      </p>
      <pre className={styles.cmpToolText} translate="no">
        {text}
      </pre>
      {truncated ? (
        <p className={styles.cmpToolHint}>{t("codingWorkbench.activity.textShortened")}</p>
      ) : null}
    </div>
  );
}

function ToolOutputBlock({
  output,
  t,
}: {
  readonly output: CodingSafeActivityToolOutput;
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  const label = t("codingWorkbench.activity.output");
  return (
    <div className={styles.cmpToolBlock} role="group" aria-label={label}>
      <p className={styles.cmpToolBlockLabel} aria-hidden="true">
        {label}
      </p>
      <pre className={styles.cmpToolText} translate="no">
        {output.head}
      </pre>
      {output.hiddenLineCount > 0 ? (
        <p className={styles.cmpToolHiddenLines}>
          {output.hiddenLineCount === 1
            ? t("codingWorkbench.activity.hiddenLines.one")
            : t("codingWorkbench.activity.hiddenLines", { count: output.hiddenLineCount })}
        </p>
      ) : null}
      {output.tail === "" ? null : (
        <pre className={styles.cmpToolText} translate="no">
          {output.tail}
        </pre>
      )}
      {output.truncated ? (
        <p className={styles.cmpToolHint}>{t("codingWorkbench.activity.linesShortened")}</p>
      ) : null}
    </div>
  );
}

type ToolActivityKind = "read" | "search" | "edit" | "command" | "git" | "web" | "plan" | "other";

const TOOL_ACTIVITY_KINDS: Readonly<Record<string, ToolActivityKind>> = {
  read: "read",
  keiko_workspace_read: "read",
  glob: "search",
  grep: "search",
  list: "search",
  keiko_repository_search: "search",
  keiko_workspace_discover: "search",
  keiko_skill_discover: "search",
  websearch: "search",
  edit: "edit",
  write: "edit",
  patch: "edit",
  keiko_changeset_edit: "edit",
  shell: "command",
  execute: "command",
  keiko_verification: "command",
  keiko_git_status: "git",
  keiko_git_diff: "git",
  keiko_git_stage: "git",
  keiko_git_commit: "git",
  keiko_git_push: "git",
  keiko_git_execute: "git",
  keiko_git_sync: "git",
  keiko_git_branch: "git",
  keiko_pull_request: "git",
  keiko_ci_status: "git",
  webfetch: "web",
  keiko_research_fetch: "web",
  todo: "plan",
  todowrite: "plan",
};

const TOOL_ACTIVITY_ORDER: readonly ToolActivityKind[] = [
  "read",
  "search",
  "edit",
  "command",
  "git",
  "web",
  "plan",
  "other",
];

/**
 * A group of finished steps in verbs, in a fixed order: "Read 3 files · Ran 2 commands". Each kind
 * counts its calls, so the summary says what the agent did rather than how many rows it folded.
 */
export function toolGroupSummary(
  tools: readonly { readonly tool: CodingSafeActivityTool; readonly count: number }[],
  t: CodingWorkbenchTranslate,
): string {
  const counts = new Map<ToolActivityKind, number>();
  for (const { tool, count } of tools) {
    const kind = Object.hasOwn(TOOL_ACTIVITY_KINDS, tool.tool)
      ? (TOOL_ACTIVITY_KINDS[tool.tool] ?? "other")
      : "other";
    counts.set(kind, (counts.get(kind) ?? 0) + count);
  }
  return TOOL_ACTIVITY_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    if (count === undefined) return [];
    return [
      count === 1
        ? t(`codingWorkbench.activity.group.${kind}.one`)
        : t(`codingWorkbench.activity.group.${kind}`, { count }),
    ];
  }).join(" · ");
}

/** How many of a feed's shell calls did not finish successfully, for the run's status line. */
export function failedCommandCount(feed: CodingSafeActivityFeed | null): number {
  if (feed?.availability !== "available") return 0;
  let count = 0;
  for (const turn of feed.turns) {
    for (const tool of turn.tools) {
      if (TOOL_ACTIVITY_KINDS[tool.tool] !== "command") continue;
      // A command that ran and failed or ran out of time; a block by Keiko, a tool's own error and
      // a stop each have their own words and are not a failed command.
      const origin = toolFailureOrigin(tool);
      if (origin === "command-failed" || origin === "timed-out") count += 1;
    }
  }
  return count;
}

/**
 * Arrow keys move between the timeline's step rows, Home and End to its first and last; Enter and
 * Space open a row through its own summary. Only rows the list currently renders are reachable.
 */
export function moveRowFocus(event: KeyboardEvent<HTMLElement>): void {
  const step = ROW_KEYS[event.key];
  if (step === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
  const list = event.currentTarget.closest("[data-timeline-rows]");
  if (list === null) return;
  const rows = [...list.querySelectorAll<HTMLElement>("summary[data-timeline-row]")].filter(
    (row) => row === event.currentTarget || isShownRow(row),
  );
  const index = rows.indexOf(event.currentTarget);
  const target = step === "first" ? rows[0] : step === "last" ? rows.at(-1) : rows[index + step];
  if (target === undefined) return;
  event.preventDefault();
  target.focus();
}

// A row folded inside a closed group stays in the document once read, but is not on screen.
function isShownRow(summary: HTMLElement): boolean {
  let folding = summary.parentElement?.parentElement?.closest("details") ?? null;
  while (folding !== null) {
    if (!folding.open) return false;
    folding = folding.parentElement?.closest("details") ?? null;
  }
  return true;
}

const ROW_KEYS: Readonly<Partial<Record<string, -1 | 1 | "first" | "last">>> = {
  ArrowDown: 1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};
