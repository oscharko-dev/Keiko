import type { ChatToolExchange } from "@oscharko-dev/keiko-contracts/bff-wire";
import { JIRA_MANAGED_READ_TOOLS } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { within } from "@testing-library/react";

type CompletedPage = Extract<
  NonNullable<ChatToolExchange["result"]>,
  { status: "completed" }
>["page"];
const COMPOSITIONS = new Set(["jira_report", "jira_draft_stage", "jira_draft_batch"]);

/** Readability pins use partial reads: a complete read leaves its content to the model answer. */
export function partialJiraReadPage(name: string): CompletedPage {
  const partial =
    !COMPOSITIONS.has(name) &&
    JIRA_MANAGED_READ_TOOLS.some((operation) => operation.replace(/[.-]/gu, "_") === name);
  return { truncated: partial, reason: partial ? "result-cap" : "none", cursor: null };
}

/** The progress disclosure only inspects history; every other button remains subject to no-replay pins. */
export function buttonsOutsideProgress(container: HTMLElement): HTMLElement[] {
  const progress = within(container).getByRole("region", { name: /^(?:Progress|Fortschritt)$/u });
  return within(container)
    .queryAllByRole("button")
    .filter((button) => !progress.contains(button));
}

export function say(locale: "en" | "de", en: string, de: string): string {
  return locale === "en" ? en : de;
}
