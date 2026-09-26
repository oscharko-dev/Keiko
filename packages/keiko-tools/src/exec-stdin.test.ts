import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWorkspace, recordingSpawn } from "./_support.js";
import { runCommand, nodeSpawnFn, type RunCommandDeps, type RunCommandInput } from "./exec.js";
import { DEFAULT_SANDBOX_POLICY } from "./types.js";

let workspace: ReturnType<typeof makeWorkspace>;
beforeEach(() => {
  workspace = makeWorkspace();
});
afterEach(() => {
  rmSync(workspace.root, { recursive: true, force: true });
});
function deps(): RunCommandDeps {
  return {
    workspace: workspace.info,
    policy: DEFAULT_SANDBOX_POLICY,
    commandRules: [{ executable: "node" }],
    spawn: nodeSpawnFn,
    now: Date.now,
    processEnv: { PATH: process.env.PATH },
    resolveExecutable: () => process.execPath,
  };
}
function input(stdin: string): RunCommandInput {
  return {
    command: "node",
    args: [
      "-e",
      "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>process.stdout.write(String(n)))",
    ],
    stdin,
    cwd: undefined,
    timeoutMs: 5000,
    signal: new AbortController().signal,
  };
}
describe("bounded server-owned command stdin", () => {
  it("carries bounded binary object bytes without UTF-8 transformation", async () => {
    const result = await runCommand(
      { ...input(""), stdin: new Uint8Array([0, 255, 128, 1]) },
      deps(),
    );
    expect(result.stdout).toBe("4");
    const recorder = recordingSpawn();
    await expect(
      runCommand(
        { ...input(""), stdin: new Uint8Array(65_537) },
        { ...deps(), spawn: recorder.fn },
      ),
    ).rejects.toThrow("bounded stdin");
    expect(recorder.calls()).toHaveLength(0);
  });
  it("delivers exact UTF-8 bytes and closes stdin without putting content into the result", async () => {
    const result = await runCommand(input("private-input-ä\n"), deps());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(String(Buffer.byteLength("private-input-ä\n")));
    expect(JSON.stringify(result)).not.toContain("private-input");
  });
  it("rejects an oversized UTF-8 payload before spawning", async () => {
    const recorder = recordingSpawn();
    await expect(
      runCommand(input("ä".repeat(8193)), { ...deps(), spawn: recorder.fn }),
    ).rejects.toThrow("bounded stdin");
    expect(recorder.calls()).toHaveLength(0);
  });
  it("preserves the already-aborted no-spawn pin with stdin", async () => {
    const recorder = recordingSpawn();
    await expect(
      runCommand(
        { ...input("private-input"), signal: AbortSignal.abort() },
        { ...deps(), spawn: recorder.fn },
      ),
    ).rejects.toThrow("cancelled");
    expect(recorder.calls()).toHaveLength(0);
  });
});
