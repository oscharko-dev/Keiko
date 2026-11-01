// #4179: the source trace of Jira writes is resolved only from explicit, validated references and
// leaves closed, body-free evidence on the Activity Log.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../tests/support/buffered-server-log.js";
import { podFixture, specification, type PodFixture } from "./_requirementSupport.js";
import { createServerLogger, setServerLogger } from "./observability/index.js";
import { resetRequirementTurnCache } from "./requirement-inventory.js";
import {
  logTrace,
  newTally,
  openTraceSession,
  tallyOutcome,
  tallyRefusal,
  traceOutcomeData,
  traceRefusalData,
  type TraceResolution,
} from "./requirement-trace.js";

let sink: BufferedServerLogSink;
const fixtures: PodFixture[] = [];

beforeEach(() => {
  sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  resetRequirementTurnCache();
});
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
  resetServerLogger();
});

async function session(
  pods: Parameters<typeof podFixture>[0],
  options?: Parameters<typeof podFixture>[1],
): Promise<{ f: PodFixture; open: () => ReturnType<typeof openTraceSession> }> {
  const f = await podFixture(pods, options);
  fixtures.push(f);
  return {
    f,
    open: () =>
      openTraceSession(f.deps, {
        chatId: f.chatId,
        userMessageId: "m-1",
        correlationId: "req-trace-0001",
      }),
  };
}

function scopeOf(references: string): string {
  return references;
}

describe("trace session", () => {
  it("resolves a scoped reference to doc-scoped labels and a footer with the document and revision", async () => {
    const { f, open } = await session([
      { capsuleId: "cap-a", text: specification(5).text, name: "Spec.md" },
    ]);
    const trace = open();

    const listed = await import("./requirementsTool.js").then(async (module) => {
      const tool = module.createKnowledgeRequirementsProvider(f.deps).tools()[0];
      const result = await tool?.execute(
        { ids: ["LH-002"] },
        {
          invocationId: "i",
          correlationId: "req-tool-0002",
          signal: new AbortController().signal,
          beforeEffect: () => true,
          chatId: f.chatId,
          userMessageId: "m-1",
        },
      );
      return (result?.data as { items: { reference: string }[] }).items[0]?.reference ?? "";
    });
    const resolution = trace.resolve([scopeOf(listed)]);
    trace.close();

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.trace.labels).toEqual(
      expect.arrayContaining([
        "keiko-requirement",
        "keiko-req-LH-002",
        expect.stringMatching(/^keiko-doc-[0-9a-f]{8}$/u),
        expect.stringMatching(/^keiko-rev-[0-9a-f]{12}$/u),
      ]),
    );
    expect(resolution.trace.footer).toContain("Keiko traceability");
    expect(resolution.trace.footer).toContain("LH-002");
    expect(resolution.trace.footer).toContain("Spec.md");
    expect(resolution.trace.footerStart).toBe("----\nKeiko traceability");
    expect(resolution.trace.replaceLabelPrefixes).toEqual(["keiko-rev-"]);
  });

  it("accepts a plain identifier that is unique and refuses it when two documents define it", async () => {
    const unique = await session([{ capsuleId: "cap-a", text: specification(3).text }]);
    const clash = await session([
      { capsuleId: "cap-a", text: specification(3).text },
      { capsuleId: "cap-b", text: specification(3).text.replace("Thema 2;", "Thema zwei;") },
    ]);

    const ok = unique.open().resolve(["LH-001"]);
    const ambiguous = clash.open().resolve(["LH-001"]);

    expect(ok.ok).toBe(true);
    expect(ambiguous).toMatchObject({
      ok: false,
      reason: "references",
      problems: [{ reference: "LH-001", reason: "ambiguous" }],
    });
    // Never "last wins": both candidates are named so the model can pick a scoped reference.
    const problem = (ambiguous as Extract<TraceResolution, { ok: false }>).problems[0];
    expect(problem?.candidates).toHaveLength(2);
  });

  it("refuses unknown references, an empty list and more references than the bound", async () => {
    const { open } = await session([{ capsuleId: "cap-a", text: specification(3).text }]);
    const trace = open();

    const unknown = trace.resolve(["LH-404", "not a reference!"]);
    const empty = trace.resolve([]);
    const many = trace.resolve(Array.from({ length: 9 }, (_, index) => `LH-00${String(index)}`));

    expect(unknown).toMatchObject({ ok: false, reason: "references" });
    expect(
      (unknown as Extract<TraceResolution, { ok: false }>).problems.map((p) => p.reason),
    ).toEqual(["unknown", "unknown"]);
    expect(empty).toMatchObject({ ok: false, problems: [{ reason: "malformed" }] });
    expect(many).toMatchObject({ ok: false, problems: [{ reason: "malformed" }] });
  });

  it("reports a Chat without a Knowledge Pod, and an unreadable store, as closed refusals", async () => {
    const none = await session([], { bindPods: false });
    const broken = await session([{ capsuleId: "cap-a", text: specification(3).text }]);
    broken.f.withStore((store) => {
      store._internal.db.prepare("DROP TABLE documents").run();
    });

    expect(none.open().resolve(["LH-001"])).toMatchObject({
      ok: false,
      reason: "no-knowledge-pod",
    });
    const trace = broken.open();
    expect(trace.resolve(["LH-001"])).toMatchObject({ ok: false, reason: "unavailable" });
    // A failed session stays failed and does not retry the store inside the same call.
    expect(trace.resolve(["LH-001"])).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("redacts the footer with the Chat content policy", async () => {
    const text = specification(2).text.replace(
      "### LH-002 Thema 2",
      "### LH-002 Thema SECRET-KEY-123",
    );
    const { open } = await session([{ capsuleId: "cap-a", text }], {
      redactor: (value) =>
        typeof value === "string" ? value.replaceAll("SECRET-KEY-123", "[REDACTED]") : value,
    });

    const resolution = open().resolve(["LH-002"]);

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.trace.footer).not.toContain("SECRET-KEY-123");
      expect(resolution.trace.footer).toContain("REDACTED");
    }
  });
});

describe("trace results and evidence", () => {
  it("shapes refusals and outcomes for the tool result without echoing long input", () => {
    const refusal = traceRefusalData(
      {
        ok: false,
        reason: "references",
        problems: [{ reference: "X".repeat(200), reason: "unknown" }],
      },
      "epic",
    );
    const outcome = traceOutcomeData({
      labelsApplied: true,
      footerApplied: false,
      droppedLabels: ["a", "b"],
    });

    expect(refusal).toMatchObject({
      reason: "field-validation",
      requirementRefusal: "references",
      requirementProblems: [{ ref: "epic", reason: "unknown" }],
    });
    expect(JSON.stringify(refusal).length).toBeLessThan(400);
    expect(outcome).toEqual({
      labelsApplied: true,
      footerApplied: false,
      droppedLabels: ["a", "b"],
    });
    expect(traceOutcomeData(undefined)).toBeUndefined();
  });

  it("records applied labels, footers, dropped labels and refusals as counts on one line", () => {
    const tally = newTally();
    tallyOutcome(tally, { labelsApplied: true, footerApplied: true, droppedLabels: ["x"] });
    tallyOutcome(tally, { labelsApplied: false, footerApplied: true, droppedLabels: [] });
    tallyRefusal(tally, {
      ok: false,
      reason: "references",
      problems: [{ reference: "LH-9", reason: "unknown" }],
    });

    logTrace("req-trace-0002", "draft", tally);

    const line = expectActivityLogProof(
      "knowledge.requirement-trace.applied.line",
      formatActivityLogProofLine(
        sink.events.find((event) => event.op === "knowledge.requirement-trace.applied") ?? {},
      ),
    );
    expect(line).toMatchObject({
      correlationId: "req-trace-0002",
      operation: "draft",
      tracedItemCount: 3,
      refusedItemCount: 1,
      referenceProblemCount: 1,
      labelsAppliedCount: 1,
      footerAppliedCount: 2,
      droppedLabelCount: 1,
      unavailable: false,
    });
    expect(JSON.stringify(line)).not.toContain("LH-9");
  });

  it("writes nothing when no item named a requirement", () => {
    logTrace("req-trace-0003", "create", newTally());

    expect(
      sink.events.filter((event) => event.op === "knowledge.requirement-trace.applied"),
    ).toHaveLength(0);
  });
});
