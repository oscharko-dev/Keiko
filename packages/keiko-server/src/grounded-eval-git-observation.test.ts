import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetServerLogger } from "../../../tests/support/activity-log-test-support.js";
import {
  expectRegisteredActivityLogLine,
  readPersistedActivityLog,
} from "../../../tests/support/activity-log-proof.js";
import { runConnectedRetrievalEval } from "./grounded-eval-support.js";

describe("observed real Git setup for connected retrieval evaluation", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "keiko-eval-git-observation-"));
    vi.stubEnv("KEIKO_STATE_DIR", stateDir);
    vi.stubEnv("KEIKO_LOG_LEVEL", "debug");
    resetServerLogger();
  });
  afterEach(() => {
    resetServerLogger();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("records a real init failure without retaining Git output or fixture paths", async () => {
    await expect(
      runConnectedRetrievalEval({
        files: { ".git/HEAD": "ref: refs/heads/fixture\n", ".git": "invalid Git metadata\n" },
        query: "Explain src/validation.ts",
      }),
    ).rejects.toThrow("Connected retrieval fixture Git initialization failed");
    const line = readPersistedActivityLog(stateDir)
      .split("\n")
      .find((record) => record.includes('"op":"git.process.failed"'));
    expect(line).toBeDefined();
    const record = expectRegisteredActivityLogLine("git.process.failed", line ?? "");
    expect(record).toMatchObject({ op: "git.process.failed", subcommand: "init" });
    expect(typeof record.correlationId).toBe("string");
    expect(line).not.toContain("invalid Git metadata");
    expect(line).not.toContain("keiko-connected-retrieval-eval-");
  });

  it("keeps a healthy real fixture repository retrievable without a Git failure", async () => {
    const result = await runConnectedRetrievalEval({
      files: {
        ".git/HEAD": "ref: refs/heads/fixture\n",
        "src/validation.ts": "export const validation = 937;\n",
      },
      query: "Explain src/validation.ts",
    });
    expect(result.pack.files.map((file) => file.scopePath)).toContain("src/validation.ts");
    expect(readPersistedActivityLog(stateDir)).not.toContain('"op":"git.process.failed"');
  });
});
