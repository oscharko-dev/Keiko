// The lab's mid-turn actions (S17, #4175): an action the lab starts while a Chat turn runs, such as
// a runtime-catalog refresh or a change of the Chat's mode, anchored to a point of the stored tool
// transcript instead of a timer.
import { completedToolExchange } from "./tool-exchanges.mjs";

const WRITE_OPERATIONS = ["jira.create", "jira.draft", "jira.edit"];
const reachedPoint = (when, exchanges) =>
  when === "first-write"
    ? exchanges.some((exchange) =>
        WRITE_OPERATIONS.some((operation) => completedToolExchange(exchange, operation)),
      )
    : exchanges.length > 0;

/**
 * Starts the lab's mid-turn action (`during.run`) once, when the stored tool transcript first shows
 * the point it waits for, and returns the promise of what it observed. It is not awaited here, so
 * the supervision keeps deciding approvals while it runs; `startedOpen` records whether the turn was
 * unsettled when it started, `turnOpen` whether it still was when it finished. The product answers a
 * mode change only after the turn it interrupts has settled, so that finish says nothing about it.
 */
export function startDuring(during, exchanges, isSettled) {
  if (during === undefined || !reachedPoint(during.when, exchanges)) return undefined;
  const startedOpen = !isSettled();
  const finished = (outcome) => ({ ...outcome, startedOpen, turnOpen: !isSettled() });
  return Promise.resolve()
    .then(during.run)
    .then(
      () => finished({ ok: true }),
      (error) => finished({ ok: false, error: String(error?.message ?? error).slice(0, 200) }),
    );
}
