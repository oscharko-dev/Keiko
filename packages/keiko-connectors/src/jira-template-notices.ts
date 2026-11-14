import { AsyncLocalStorage } from "node:async_hooks";
import {
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  type JiraMutationAttempt,
  type JiraTemplateViolation,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";

/**
 * Template notices of one write (#4354): rules an issue already broke in fields an edit did not
 * touch. The gate sits below eight different write paths; each of them would otherwise have to
 * carry the notices to its own result. One collector per executed mutation gathers them where the
 * gate decides and attaches them where the attempt leaves the executor.
 */
const NOTICES = new AsyncLocalStorage<JiraTemplateViolation[]>();

/** Called by the gate when it admits a write although a rule was already broken elsewhere. */
export function noteJiraTemplateNotices(notices: readonly JiraTemplateViolation[]): void {
  NOTICES.getStore()?.push(...notices);
}

/** Runs one mutation and returns its attempt with the notices its gate collected, if it succeeded. */
export async function withJiraTemplateNotices(
  run: () => Promise<JiraMutationAttempt>,
): Promise<JiraMutationAttempt> {
  const collected: JiraTemplateViolation[] = [];
  const attempt = await NOTICES.run(collected, run);
  if (!attempt.ok || collected.length === 0) return attempt;
  const seen = new Set<string>();
  const notices = collected
    .filter((notice) => {
      const id = `${notice.template}|${notice.ruleId}|${notice.subject}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, JIRA_TEMPLATE_VIOLATIONS_MAX);
  return { ...attempt, templateNotices: notices };
}
