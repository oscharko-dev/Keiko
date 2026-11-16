import { describe, expect, it, vi } from "vitest";
import { URL } from "node:url";

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
import { loadLimitRunBlocks } from "../testing/jira-chat-lab/browser-limit-run.mjs";

describe("integrator-owned limit-run export contract", () => {
  it("loads the six delivered owner modules through the integrated orchestrator", async () => {
    const ownedPaths = new Set([
      "./templates.mjs",
      "./browser-rules-knowledge-journey.mjs",
      "./browser-project-agile-journey.mjs",
      "./browser-a11y.mjs",
    ]);
    const otherOwners = Object.fromEntries(
      [
        "stageLastenheft",
        "runBulkEpics",
        "gradeBulkRefusals",
        "runHierarchyBulk",
        "simulateProgress",
        "runProgressReport",
        "createFaultPlan",
      ].map((name) => [name, vi.fn()]),
    );
    const owner = new URL("../testing/jira-chat-lab/browser-limit-run.mjs", import.meta.url);
    const blocks = await loadLimitRunBlocks((path) =>
      ownedPaths.has(path) ? import(new URL(path, owner).href) : Promise.resolve(otherOwners),
    );
    expect(blocks).toMatchObject({
      installTemplates,
      runRuleProbes,
      runProjectSetup,
      runSprintBulk,
      setUiLanguage,
      assertCardsReadable,
    });
  });
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
