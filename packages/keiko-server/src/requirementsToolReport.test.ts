// #4181: `jira.report` with requirementsFromPods asks Keiko for the Chat's requirement
// identifiers, so a model with a small window never copies dozens of them into a call.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { podFixture, specification, type PodFixture, type PodSpec } from "./_requirementSupport.js";
import { resetRequirementTurnCache } from "./requirement-inventory.js";
import {
  chatReportRequirementIds,
  createKnowledgeRequirementsProvider,
  type RequirementsToolContext,
} from "./requirementsTool.js";

const fixtures: PodFixture[] = [];

beforeEach(() => {
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

async function fixture(
  pods: readonly PodSpec[],
  options?: Parameters<typeof podFixture>[1],
): Promise<PodFixture> {
  const created = await podFixture(pods, options);
  fixtures.push(created);
  return created;
}

const context = (f: PodFixture): RequirementsToolContext => ({
  invocationId: "inv-1",
  correlationId: "req-tool-0001",
  signal: new AbortController().signal,
  beforeEffect: () => true,
  chatId: f.chatId,
  userMessageId: "turn-1",
});

describe("the requirement list Keiko hands jira.report", () => {
  it("lists the explicit identifiers of every Pod once, in the detected order", async () => {
    const f = await fixture([
      { capsuleId: "cap-a", text: specification(3).text },
      { capsuleId: "cap-b", text: specification(2, { prefix: "FR" }).text },
    ]);

    expect(chatReportRequirementIds(f.deps, context(f))).toEqual({
      ok: true,
      ids: ["LH-001", "LH-002", "LH-003", "FR-001", "FR-002"],
    });
  });

  it("lists no derived handle, which no issue could ever name", async () => {
    const text = `${specification(2).text}\n### Ohne Kennung\n\nDas Portal muss Belege innerhalb von 5 Minuten verarbeiten.\n`;
    const f = await fixture([{ capsuleId: "cap-a", text }]);
    const tool = createKnowledgeRequirementsProvider<RequirementsToolContext>(f.deps).tools()[0];
    const read = await tool?.execute({}, context(f));
    const origins = (read?.data.items as readonly { idOrigin: string }[]).map(
      (unit) => unit.idOrigin,
    );

    // The detector does find the unit without an identifier, under a handle of its own.
    expect(origins).toContain("derived");
    expect(chatReportRequirementIds(f.deps, context(f))).toEqual({
      ok: true,
      ids: ["LH-001", "LH-002"],
    });
  });

  it("says in plain words what to do when the Chat has no Pod", async () => {
    const f = await fixture([], { bindPods: false });

    expect(chatReportRequirementIds(f.deps, context(f))).toMatchObject({
      ok: false,
      message: expect.stringContaining("requirementIds") as unknown,
    });
  });

  it("names the closed reason a Pod cannot be read yet", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: specification(3).text }]);
    f.withStore((store) => {
      store._internal.db.prepare("UPDATE capsules SET lifecycle_state = 'indexing'").run();
    });

    expect(chatReportRequirementIds(f.deps, context(f))).toMatchObject({
      ok: false,
      message: expect.stringContaining("(indexing)") as unknown,
    });
  });

  it("answers a Pod without any identifier with a refusal, not an empty list", async () => {
    const f = await fixture([{ capsuleId: "cap-a", text: "# Leer\n\nNichts Verbindliches.\n" }]);

    expect(chatReportRequirementIds(f.deps, context(f))).toMatchObject({ ok: false });
  });
});
