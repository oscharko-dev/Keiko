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
import { connectedChatObservation } from "../testing/coding-workbench-lab/connected-chat-record.mjs";

const DIRECTORIES = [];
const CORRELATION = "corr-connected-chat-lab-observation";
const PRIVATE_BODY = "Private model answer and source path /private/secret-source.txt";

function stateWithAcceptedAssessment() {
  const stateDir = mkdtempSync(join(tmpdir(), "keiko-connected-chat-tool-"));
  DIRECTORIES.push(stateDir);
  const sink = createFileServerLogSink(stateDir, { level: "info" });
  setServerLogger(createServerLogger({ sink, level: "info" }));
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
    mkdirSync(join(damaged, "logs"));
    writeFileSync(
      join(damaged, "logs", segment),
      `${readFileSync(join(logDir, segment), "utf8")}{ broken record\n`,
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
});
