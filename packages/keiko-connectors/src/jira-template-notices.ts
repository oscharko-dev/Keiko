import { AsyncLocalStorage } from "node:async_hooks";
import {
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  type JiraMutationAttempt,
  type JiraTemplateGateFact,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * Template notices of one write (#4354): rules an issue already broke in fields an edit did not
 * touch. The gate sits below eight different write paths; each of them would otherwise have to
 * carry the notices to its own result. One collector per executed mutation gathers them where the
 * gate decides and attaches them where the attempt leaves the executor.
 */
interface Collected {
  readonly notices: JiraTemplateViolation[];
  readonly facts: Set<JiraTemplateGateFact>;
}
const NOTICES = new AsyncLocalStorage<Collected>();

/** Called by the gate when it admits a write although a rule was already broken elsewhere. */
export function noteJiraTemplateNotices(notices: readonly JiraTemplateViolation[]): void {
  NOTICES.getStore()?.notices.push(...notices);
}

/**
 * Called by the gate when a decision rested on less than the full picture and the write went on: a
 * closed fact for the Activity Log, never shown to the person as a rule (#4354).
 */
export function noteJiraTemplateGateFact(fact: JiraTemplateGateFact): void {
  NOTICES.getStore()?.facts.add(fact);
}

/** Runs one mutation and returns its attempt with the notices its gate collected, if it succeeded. */
export async function withJiraTemplateNotices(
  run: () => Promise<JiraMutationAttempt>,
): Promise<JiraMutationAttempt> {
  const collected: Collected = { notices: [], facts: new Set() };
  const attempt = await NOTICES.run(collected, run);
  // The gate's facts describe its decision, whatever the write did afterwards.
  const facts = collected.facts.size === 0 ? {} : { templateGateFacts: [...collected.facts] };
  if (!attempt.ok || collected.notices.length === 0) return { ...attempt, ...facts };
  const seen = new Set<string>();
  const notices = collected.notices
    .filter((notice) => {
      const id = `${notice.template}|${notice.ruleId}|${notice.subject}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX);
  return { ...attempt, ...facts, templateNotices: notices };
}
