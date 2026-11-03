import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ServerLogEvent, ServerLogSink } from "@oscharko-dev/keiko-activity-log";
import { WorkspaceReadError } from "@oscharko-dev/keiko-workspace";

// The canonical projection cannot project this file: the instructions fail closed.
vi.mock("@oscharko-dev/keiko-workspace/source-redaction", () => ({
  redactWorkspaceSource: (): never => {
    throw new WorkspaceReadError("code source redaction is unavailable", "AGENTS.md");
  },
}));

const { createCodingRuntimeRepositoryInstructionsPort } =
  await import("./codingRuntimeRepositoryInstructions.js");

const RUN_ID = "run-repository-instructions-redaction";
const OP = "coding-runtime.repository-instructions.context";

function capture(): { readonly activityLog: ServerLogSink; readonly records: ServerLogEvent[] } {
  const records: ServerLogEvent[] = [];
  return { activityLog: { write: (event) => void records.push(event) }, records };
}

// PR #4064 review r4369385467: an unavailable safe projection attaches nothing and copies nothing.
describe("repository instructions without a safe projection", () => {
  it("refuses the native copy, removes a stale one and records why", async () => {
    const { activityLog, records } = capture();
    const port = createCodingRuntimeRepositoryInstructionsPort({
      enabled: true,
      delivery: "native-instructions",
      source: { readText: () => Promise.resolve({ ok: true, text: "# Rules\n" }) },
      activityLog,
    });
    const targetPath = join(mkdtempSync(join(tmpdir(), "keiko-instructions-unsafe-")), "AGENTS.md");
    writeFileSync(targetPath, "an earlier copy\n");

    await expect(
      port.materializeForRun({ runId: RUN_ID, isRunWorkspace: () => true, targetPath }),
    ).resolves.toBe(true);

    expect(existsSync(targetPath)).toBe(false);
    expect(records.filter((record) => record.op === OP)).toMatchObject([
      { level: "warn", extra: { state: "refused", reason: "redaction-unavailable" } },
    ]);
  });

  it("attaches no initial-turn block", async () => {
    const { activityLog, records } = capture();
    const port = createCodingRuntimeRepositoryInstructionsPort({
      enabled: true,
      source: { readText: () => Promise.resolve({ ok: true, text: "# Rules\n" }) },
      activityLog,
    });

    await expect(
      port.loadForRun({ runId: RUN_ID, isRunWorkspace: () => true }),
    ).resolves.toBeUndefined();
    expect(records.filter((record) => record.op === OP)).toMatchObject([
      { extra: { state: "refused", reason: "redaction-unavailable" } },
    ]);
  });
});
