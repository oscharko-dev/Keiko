import { describe, expect, it, vi } from "vitest";

vi.mock("../testing/jira-chat-lab/browser-workflow-turn.mjs", () => ({
  openWorkflowBrowser: vi.fn(),
  sendBrowserTurn: vi.fn(),
  workflowHistory: vi.fn(),
}));

import * as agile from "../testing/jira-chat-lab/browser-project-agile-journey.mjs";
import { runProjectSetup } from "../testing/jira-chat-lab/browser-project-setup.mjs";
import { runSprintBulk } from "../testing/jira-chat-lab/browser-sprint-bulk.mjs";
import { installTemplates } from "../testing/jira-chat-lab/templates.mjs";
import { runRuleProbes } from "../testing/jira-chat-lab/browser-rules-knowledge-journey.mjs";
import { setUiLanguage, assertCardsReadable } from "../testing/jira-chat-lab/browser-a11y.mjs";

describe("integrator-owned limit-run export contract", () => {
  it("exposes the actual project and sprint implementations from the contracted journey module", () => {
    expect(agile.runProjectSetup).toBe(runProjectSetup);
    expect(agile.runSprintBulk).toBe(runSprintBulk);
    expect(agile.runProjectAgileJourney).toBeTypeOf("function");
  });
  it.each([
    installTemplates,
    runRuleProbes,
    runProjectSetup,
    runSprintBulk,
    setUiLanguage,
    assertCardsReadable,
  ])("keeps %s asynchronous for the shared orchestrator", (block) =>
    expect(block.constructor.name).toBe("AsyncFunction"),
  );
});
