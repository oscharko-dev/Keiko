// #3390 — records the stage evidence already observed by one selected five-flow drive. The paid
// flow and the individually selectable scenario tests call the same receipt writer; this module
// adds no second journey and cannot create a passing receipt before its caller reaches the stage.

import { type Page } from "@playwright/test";
import {
  recordScenarioReceipt,
  type CodingIssueJourneyScenarioId,
} from "./coding-issue-journey-scenarios.js";

async function observedToolCallEvents(page: Page): Promise<number> {
  return page.locator('[data-timeline-kind="tool"]').count();
}

export async function recordSuccessfulJourneyStage(
  page: Page,
  scenarioId: CodingIssueJourneyScenarioId,
  assertions: readonly string[],
  startedAt: number,
  flowBinding: NonNullable<Parameters<typeof recordScenarioReceipt>[0]["flowBinding"]>,
  correlatedToolCallEvents: number,
): Promise<string> {
  const visibleToolCalls = await observedToolCallEvents(page);
  if (
    visibleToolCalls <= 0 ||
    !Number.isSafeInteger(correlatedToolCallEvents) ||
    correlatedToolCallEvents <= 0
  ) {
    throw new Error("qualification stage has no observed model tool activity");
  }
  const receipt = {
    scenarioId,
    result: "passed",
    assertions,
    usage: {
      spendObservability: "unknown",
      observedToolCallEvents: correlatedToolCallEvents,
      observedRunDurationMs: Date.now() - startedAt,
    },
    flowBinding,
  } as const;
  // Preserve the canonical scenario projection for the existing descriptor row, while the
  // flow-qualified key retains every one of the five independent observations.
  recordScenarioReceipt(receipt);
  return recordScenarioReceipt({
    ...receipt,
    receiptKey: `${flowBinding.flowId}.${scenarioId}`,
  });
}
