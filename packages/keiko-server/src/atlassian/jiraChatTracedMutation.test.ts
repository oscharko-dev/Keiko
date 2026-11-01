// #4179: a Jira create or edit that names requirements is validated first and traced by the
// connector; one without references is sent untouched and never opens the Knowledge Pods.
import type { JiraTraceOutcome, JiraTraceRequest } from "@oscharko-dev/keiko-connectors";
import type { ManagedMcpToolResult } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
import { podFixture, specification, type PodFixture } from "../_requirementSupport.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { resetRequirementTurnCache } from "../requirement-inventory.js";
import { executeTracedMutation } from "./jiraChatCatalogRuntime.js";

let sink: BufferedServerLogSink;
let f: PodFixture;

beforeEach(async () => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  resetRequirementTurnCache();
  f = await podFixture([{ capsuleId: "cap-a", text: specification(5).text }]);
});
afterEach(() => {
  f.cleanup();
  resetServerLogger();
});

const OK: ManagedMcpToolResult = { data: { outcome: "succeeded", issueKey: "KEI-1" } };
const turn = (): { chatId: string; userMessageId: string; correlationId: string } => ({
  chatId: f.chatId,
  userMessageId: "m-1",
  correlationId: "req-write-0001",
});

function run(outcome?: JiraTraceOutcome): {
  fn: (trace: JiraTraceRequest | undefined) => Promise<ManagedMcpToolResult>;
  seen: (JiraTraceRequest | undefined)[];
} {
  const seen: (JiraTraceRequest | undefined)[] = [];
  return {
    seen,
    fn: (trace): Promise<ManagedMcpToolResult> => {
      seen.push(trace);
      if (trace !== undefined && outcome !== undefined) trace.report?.(outcome);
      return Promise.resolve(OK);
    },
  };
}

describe("traced create and edit", () => {
  it.each(["jira.create", "jira.edit"] as const)(
    "passes the validated labels and footer of an explicit reference to %s and reports the outcome",
    async (operation) => {
      const call = run({ labelsApplied: true, footerApplied: true, droppedLabels: [] });

      const result = await executeTracedMutation(
        f.deps,
        turn(),
        operation,
        { requirementIds: ["LH-003"] },
        call.fn,
      );

      expect(call.seen).toHaveLength(1);
      expect(call.seen[0]?.labels).toEqual(
        expect.arrayContaining(["keiko-requirement", "keiko-req-LH-003"]),
      );
      expect(call.seen[0]?.footer).toContain("LH-003");
      expect(result.data).toMatchObject({
        outcome: "succeeded",
        trace: { labelsApplied: true, footerApplied: true, droppedLabels: [] },
      });
      const line = expectActivityLogProof(
        "knowledge.requirement-trace.applied.line",
        formatActivityLogProofLine(
          sink.events.find((event) => event.op === "knowledge.requirement-trace.applied") ?? {},
        ),
      );
      expect(line).toMatchObject({
        operation: operation === "jira.create" ? "create" : "edit",
        tracedItemCount: 1,
        labelsAppliedCount: 1,
        footerAppliedCount: 1,
        droppedLabelCount: 0,
      });
    },
  );

  it("surfaces labels the instance dropped in the result and in the evidence", async () => {
    const call = run({ labelsApplied: false, footerApplied: true, droppedLabels: ["keiko-doc-x"] });

    const result = await executeTracedMutation(
      f.deps,
      turn(),
      "jira.create",
      { requirementIds: ["LH-001"] },
      call.fn,
    );

    expect(result.data).toMatchObject({
      trace: { labelsApplied: false, droppedLabels: ["keiko-doc-x"] },
    });
    expect(
      sink.events.find((event) => event.op === "knowledge.requirement-trace.applied"),
    ).toMatchObject({ extra: { droppedLabelCount: 1 } });
  });

  it("refuses an unknown reference before anything is sent", async () => {
    const call = run();

    const result = await executeTracedMutation(
      f.deps,
      turn(),
      "jira.create",
      { requirementIds: ["LH-404"] },
      call.fn,
    );

    expect(call.seen).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "rejected",
      reason: "field-validation",
      requirementRefusal: "references",
      requirementProblems: [{ reference: "LH-404", reason: "unknown" }],
    });
  });

  it("refuses a malformed requirementIds argument without opening the Pods", async () => {
    const call = run();

    const result = await executeTracedMutation(
      f.deps,
      turn(),
      "jira.create",
      { requirementIds: "LH-001" },
      call.fn,
    );

    expect(call.seen).toHaveLength(0);
    expect(result.data).toMatchObject({ outcome: "rejected", requirementRefusal: "references" });
  });

  it("sends a write without references untouched, and never records a trace", async () => {
    const call = run();
    const opened = vi.spyOn(f.deps.store, "findChatById");

    const result = await executeTracedMutation(f.deps, turn(), "jira.create", {}, call.fn);

    expect(call.seen).toEqual([undefined]);
    expect(result).toBe(OK);
    expect(opened).not.toHaveBeenCalled();
    expect(
      sink.events.filter((event) => event.op === "knowledge.requirement-trace.applied"),
    ).toHaveLength(0);
  });

  it("does not trace other operations even when they carry references", async () => {
    const call = run();

    await executeTracedMutation(
      f.deps,
      turn(),
      "jira.transition",
      { requirementIds: ["LH-001"] },
      call.fn,
    );

    expect(call.seen).toEqual([undefined]);
  });
});

describe("a conflicting definition inside one document (#4179 review)", () => {
  const CONFLICTING = [
    "### LH-001 Aufbewahrung",
    "",
    "Daten werden zehn Tage aufbewahrt; die Frist beträgt 10 Tage.",
    "",
    "Priorität: Muss.",
    "",
    "### LH-001 Aufbewahrung ergänzt",
    "",
    "Daten werden neunzig Tage aufbewahrt; die Frist beträgt 90 Tage.",
    "",
    "Priorität: Muss.",
    "",
    "### LH-002 Anmeldung",
    "",
    "Das Portal unterstützt die Anmeldung; sie ist innerhalb von 10 Minuten abgeschlossen.",
    "",
    "Priorität: Muss.",
    "",
  ].join("\n");

  it.each(["jira.create", "jira.edit"] as const)(
    "refuses %s that names the conflicting identifier before anything is sent",
    async (operation) => {
      f.cleanup();
      f = await podFixture([{ capsuleId: "cap-conflict", text: CONFLICTING }]);
      const refused = run();
      const accepted = run({ labelsApplied: true, footerApplied: true, droppedLabels: [] });

      const result = await executeTracedMutation(
        f.deps,
        turn(),
        operation,
        { requirementIds: ["LH-001"] },
        refused.fn,
      );
      const clean = await executeTracedMutation(
        f.deps,
        turn(),
        operation,
        { requirementIds: ["LH-002"] },
        accepted.fn,
      );

      expect(refused.seen).toHaveLength(0);
      expect(result.isError).toBe(true);
      expect(result.data).toMatchObject({
        outcome: "rejected",
        requirementRefusal: "references",
        requirementProblems: [{ reference: "LH-001", reason: "ambiguous" }],
      });
      expect(accepted.seen).toHaveLength(1);
      expect(clean.data).toMatchObject({ outcome: "succeeded" });
    },
  );
});
