// Tool qualification only: real registered writer/reader and privacy projection, no model call.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileServerLogSink,
  createServerLogger,
  nullServerLogger,
  setServerLogger,
} from "../../packages/keiko-activity-log/dist/index.js";
import { logAnswerAssessment } from "../../packages/keiko-server/dist/grounded-citation-log.js";
import { activityLogSegmentFileName } from "../../packages/keiko-contracts/dist/activity-log-files.js";
import {
  connectedChatObservation,
  expectedSourceFactObservation,
} from "../testing/coding-workbench-lab/connected-chat-record.mjs";
import { materializeManualCases } from "../testing/coding-workbench-lab/connected-chat-cases.mjs";

const DIRECTORIES = [];
const CORRELATION = "corr-connected-chat-lab-observation";
const PRIVATE_BODY = "Private model answer and source path /private/secret-source.txt";

function stateWithAcceptedAssessment(count = 1) {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-chat-tool-"));
  DIRECTORIES.push(stateDir);
  const sink = createFileServerLogSink(stateDir, { level: "info" });
  setServerLogger(createServerLogger({ sink, level: "info" }));
  for (let index = 0; index < count; index += 1)
    logAnswerAssessment(
      {
        policy: "allowed",
        sourceBacked: "",
        assessment: PRIVATE_BODY,
        neutralized: false,
      },
      CORRELATION,
      { phase: "accepted-final" },
    );
  sink.close();
  return { stateDir };
}

function copiedState(runtime, transform) {
  const source = join(runtime.stateDir, "logs");
  const segment = readdirSync(source).find((name) => name.endsWith(".jsonl"));
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-chat-copy-"));
  DIRECTORIES.push(stateDir);
  mkdirSync(join(stateDir, "logs"), { mode: 0o700 });
  writeFileSync(
    join(stateDir, "logs", segment),
    transform(readFileSync(join(source, segment), "utf8")),
    { mode: 0o600 },
  );
  return { stateDir };
}

function response() {
  return {
    correlationId: CORRELATION,
    json: {
      content: `<assessment>${PRIVATE_BODY}</assessment>`,
      citations: [],
      uncertainty: [],
    },
  };
}

afterEach(() => {
  setServerLogger(nullServerLogger());
  while (DIRECTORIES.length > 0) rmSync(DIRECTORIES.pop(), { recursive: true, force: true });
});

describe("connected-chat lab's body-free observation", () => {
  it("reads the actual registered assessment writer through the canonical support reader", async () => {
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), response(), []);
    expect(record.assessmentEvents).toEqual([
      expect.objectContaining({
        phase: "accepted-final",
        policy: "allowed",
        outcome: "assessment-only",
        sourceBackedChars: 0,
      }),
    ]);
    expect(record.readerTimelineCount).toBeGreaterThan(0);
    expect(record.unsupportedLogLineCount).toBe(0);
    expect(record.corruptLogLineCount).toBe(0);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(record)).not.toContain("secret-source");
  });

  it("counts actual compaction records and omits unknown usage metadata", async () => {
    const manifest = {
      compaction: [],
      usageTotals: {
        promptTokens: 13,
        completionTokens: 7,
        requestCount: 1,
        totalLatencyMs: 4,
        arbitraryBody: PRIVATE_BODY,
      },
    };
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), response(), [
      manifest,
    ]);
    expect(record.compactionEvidenceCount).toBe(0);
    expect(record.usageTotals).toEqual([
      {
        promptTokens: 13,
        completionTokens: 7,
        requestCount: 1,
        totalLatencyMs: 4,
      },
    ]);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
  });

  it("preserves malformed persisted lines for the validated reader's integrity verdict", async () => {
    const runtime = stateWithAcceptedAssessment();
    const logDir = join(runtime.stateDir, "logs");
    const segment = readdirSync(logDir).find((name) => name.endsWith(".jsonl"));
    const damaged = mkdtempSync(join(tmpdir(), "keiko-connected-chat-damaged-"));
    DIRECTORIES.push(damaged);
    mkdirSync(join(damaged, "logs"), { mode: 0o700 });
    writeFileSync(
      join(damaged, "logs", segment),
      `${readFileSync(join(logDir, segment), "utf8")}{ broken record\n`,
      { mode: 0o600 },
    );
    runtime.stateDir = damaged;
    const record = await connectedChatObservation(runtime, response(), []);
    expect(record.evidenceClassification).toBe("corrupt");
    expect(record.corruptLogLineCount).toBe(1);
  });

  it("retains the actual wire's uncited warning count", async () => {
    const result = response();
    result.json.uncertainty.push({ kind: "uncited-answer", claim: PRIVATE_BODY });
    const record = await connectedChatObservation(stateWithAcceptedAssessment(), result, []);
    expect(record.uncitedWarningCount).toBe(1);
    expect(JSON.stringify(record)).not.toContain(PRIVATE_BODY);
  });

  it("does not label two valid process IDs with the same instance as stable", async () => {
    let matched = 0;
    const runtime = copiedState(
      stateWithAcceptedAssessment(2),
      (text) =>
        text
          .trimEnd()
          .split("\n")
          .map((line) => {
            const row = JSON.parse(line);
            if (row.correlationId === CORRELATION && matched++ === 1) row.pid += 1;
            return JSON.stringify(row);
          })
          .join("\n") + "\n",
    );
    const record = await connectedChatObservation(runtime, response(), []);
    expect(record.assessmentEvents).toHaveLength(2);
    expect(record.readerTimelineCount).toBeGreaterThanOrEqual(2);
    expect(record.corruptLogLineCount).toBe(0);
    expect(record.stableProcess).toBe(false);
  });

  it("keeps an earlier torn segment truncated through the canonical per-file line iterator", async () => {
    const original = stateWithAcceptedAssessment();
    const runtime = copiedState(original, (text) => `${text}{ torn fragment`);
    const next = activityLogSegmentFileName(
      { startMs: Date.now(), pid: 4242, instanceId: "a1b2c3d4", index: 2 },
      "sealed",
    );
    const originalName = readdirSync(join(original.stateDir, "logs")).find((name) =>
      name.endsWith(".jsonl"),
    );
    writeFileSync(
      join(runtime.stateDir, "logs", next),
      readFileSync(join(original.stateDir, "logs", originalName)),
      { mode: 0o600 },
    );
    const record = await connectedChatObservation(runtime, response(), []);
    expect(record.evidenceClassification).toBe("truncated");
    expect(record.truncatedLogLineCount).toBe(1);
    expect(record.corruptLogLineCount).toBe(0);
  });

  it("distinguishes retained evidence from zero-sent prompt and unobserved physical reads", async () => {
    const result = response();
    result.json.contextPack = { filesInPrompt: 0 };
    const target = "manual/guide.html";
    const record = await connectedChatObservation(
      stateWithAcceptedAssessment(),
      result,
      [{ connectedContext: { files: [{ scopePath: target }] } }],
      target,
    );
    expect(record.expectedTargetInRetainedEvidence).toBe(true);
    expect(record.expectedTargetInPrompt).toBe(false);
    expect(record.targetPhysicalReadDisposition).toBe("unobserved");
    expect(record.expectedTargetRead).toBeUndefined();
  });

  it("does not promote a declaration read-state to final-prompt membership", async () => {
    const result = response();
    const target = "manual/guide.html";
    result.json.insufficiencyDeclarations = [{ scopePath: target, state: "read-in-this-turn" }];
    const record = await connectedChatObservation(
      stateWithAcceptedAssessment(),
      result,
      [],
      target,
    );
    expect(record.expectedTargetInPrompt).toBeUndefined();
    expect(record.targetDeclarationStates).toEqual(["read-in-this-turn"]);
    expect(record.expectedTargetInRetainedEvidence).toBe(false);
  });
});

describe("manual campaign's existing corpus witness", () => {
  const corpus = () => ({
    fileCount: 100_000,
    noGit: true,
    root: "/private/corpus",
    targets: {
      late: { path: "late/interlock.html", body: PRIVATE_BODY },
      generated: { path: "generated/Überhitzungsschutz.html", body: PRIVATE_BODY },
      deep72: { path: "deep72/recovery.html", expectedDelaySeconds: 49 },
    },
  });
  it("binds original content/entity queries and same-chat depth/follow-up/general/source-return without retaining bodies", async () => {
    const rows = await materializeManualCases(corpus());
    expect(rows).toHaveLength(8);
    expect(rows[0].question).toBe(
      "What temperature trips the Vesper dosing interlock? Cite the authoritative manual. Keep the answer under 100 words.",
    );
    expect(rows[0].question).not.toContain(rows[0].target);
    expect(rows[2].question).toContain("Überhitzungsschutz");
    expect(rows[3].question).toContain("deep72/recovery.html");
    expect(rows[4].target).toBe(rows[3].target);
    expect(rows[5].target).toBeUndefined();
    expect(rows[7].target).toBe(rows[3].target);
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(rows)).not.toContain("/private/corpus");
  });
  it("rejects witness paths outside portable relative scope before any API use", async () => {
    const witness = corpus();
    witness.targets.late.path = "../outside.html";
    await expect(materializeManualCases(witness)).rejects.toThrow("invalid-manual-target");
  });
  it("records a unit-qualified source fact without accepting path digits or assessment prose", async () => {
    const fact = { number: "49", unit: "seconds" };
    const present = await expectedSourceFactObservation(
      "Wait 49 seconds [deep/49/recovery.html:1].",
      fact,
    );
    expect(present.expectedSourceFactPresent).toBe(true);
    expect(present.expectedSourceFactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      await expectedSourceFactObservation(
        "[deep/49/recovery.html:1] <assessment>Wait 49 seconds</assessment>",
        fact,
      ),
    ).toMatchObject({ expectedSourceFactPresent: false });
    expect(Object.keys(present)).toEqual(["expectedSourceFactPresent", "expectedSourceFactSha256"]);
  });
});
