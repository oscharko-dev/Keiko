import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceToolHost } from "../../src/tools/registry.js";
import {
  CommandCancelledError,
  CommandDeniedError,
  PatchApplyDisabledError,
  ToolArgumentError,
  UnknownToolError,
} from "../../src/tools/errors.js";
import { nodeSpawnFn } from "../../src/tools/exec.js";
import { DEFAULT_COMMAND_RULES, type CommandRule } from "../../src/tools/types.js";
import { makeWorkspace, recordingSpawn } from "./_support.js";
import type { ToolCallRequest } from "../../src/harness/ports.js";
import type { WorkspaceInfo } from "../../src/workspace/types.js";

let root: string;
let info: WorkspaceInfo;

const NODE_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  { executable: "node" },
  ...DEFAULT_COMMAND_RULES,
]);

beforeEach(() => {
  ({ root, info } = makeWorkspace());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

function request(toolName: string, args: Record<string, unknown>): ToolCallRequest {
  return {
    toolCallId: "tc-1",
    toolName,
    arguments: args,
    signal: new AbortController().signal,
  };
}

function host(
  overrides: Partial<ConstructorParameters<typeof WorkspaceToolHost>[0]> = {},
): WorkspaceToolHost {
  return new WorkspaceToolHost({
    workspace: info,
    processEnv: { PATH: process.env.PATH ?? "" },
    ...overrides,
  });
}

describe("WorkspaceToolHost — listTools", () => {
  it("returns 6 well-formed tool definitions", () => {
    const tools = host().listTools();
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "apply_patch",
      "inspect_package_scripts",
      "list_files",
      "propose_patch",
      "read_file",
      "run_command",
    ]);
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toHaveProperty("type", "object");
    }
  });
});

describe("WorkspaceToolHost — read-only tools (happy path)", () => {
  it("read_file returns redacted content", async () => {
    write("src/a.txt", "hello world");
    const result = await host().execute(request("read_file", { path: "src/a.txt" }));
    expect(parse(result.output).text).toBe("hello world");
    expect(result.commandExecuted).toBe(false);
  });

  it("list_files returns relative paths and stats", async () => {
    write("src/a.txt", "x");
    const result = await host().execute(request("list_files", {}));
    const parsed = parse(result.output) as {
      files: { relativePath: string }[];
      stats: { discovered: number };
    };
    expect(parsed.files.map((f: { relativePath: string }) => f.relativePath)).toContain(
      "src/a.txt",
    );
    expect(parsed.stats.discovered).toBeGreaterThan(0);
  });

  it("inspect_package_scripts returns only the scripts object", async () => {
    write(
      "package.json",
      JSON.stringify({ name: "x", scripts: { test: "vitest" }, dependencies: {} }),
    );
    const result = await host().execute(request("inspect_package_scripts", {}));
    expect(parse(result.output).scripts).toEqual({ test: "vitest" });
  });
});

describe("WorkspaceToolHost — argument validation", () => {
  it("rejects a missing required string", async () => {
    await expect(host().execute(request("read_file", {}))).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
  });

  it("rejects a wrong-typed argument", async () => {
    await expect(host().execute(request("read_file", { path: 42 }))).rejects.toBeInstanceOf(
      ToolArgumentError,
    );
  });

  it("rejects a non-string-array args field for run_command", async () => {
    await expect(
      host().execute(request("run_command", { command: "node", args: [1, 2] })),
    ).rejects.toBeInstanceOf(ToolArgumentError);
  });

  it("rejects an unknown tool", async () => {
    await expect(host().execute(request("nope", {}))).rejects.toBeInstanceOf(UnknownToolError);
  });

  it("rejects a tool call already aborted before dispatch", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      host().execute({
        toolCallId: "x",
        toolName: "read_file",
        arguments: { path: "p" },
        signal: ctrl.signal,
      }),
    ).rejects.toBeInstanceOf(CommandCancelledError);
  });
});

describe("WorkspaceToolHost — run_command", () => {
  it("denies a non-allowlisted command without spawning", async () => {
    const spawn = recordingSpawn();
    await expect(
      host({ spawn: spawn.fn }).execute(
        request("run_command", { command: "rm", args: ["-rf", "/"] }),
      ),
    ).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });

  it("runs an allowed command and sets commandExecuted:true (real node)", async () => {
    const result = await host({
      spawn: nodeSpawnFn,
      config: { commandRules: NODE_COMMAND_RULES },
    }).execute(
      request("run_command", { command: "node", args: ["-e", "process.stdout.write('ok')"] }),
    );
    expect(result.commandExecuted).toBe(true);
    const summary = parse(result.output) as { exitCode: number; stdout: string };
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("ok");
  });

  it("redacts a planted secret in command stdout", async () => {
    const result = await host({
      spawn: nodeSpawnFn,
      config: { commandRules: NODE_COMMAND_RULES },
    }).execute(
      request("run_command", {
        command: "node",
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify("k=" + ("AKIA" + "IOSFODNN7EXAMPLE"))})`,
        ],
      }),
    );
    const awsKey = "AKIA" + "IOSFODNN7EXAMPLE"; // split so the literal is not contiguous
    expect(result.output).not.toContain(awsKey);
    expect(result.output).toContain("[REDACTED]");
  });

  it("S-M1: run_command attaches redacted command metadata (no stdout/arg values)", async () => {
    const result = await host({
      spawn: nodeSpawnFn,
      config: { commandRules: NODE_COMMAND_RULES },
    }).execute(
      request("run_command", { command: "node", args: ["-e", "process.stdout.write('ok')"] }),
    );
    expect(result.metadata).toMatchObject({
      kind: "command",
      executable: "node",
      argCount: 2,
      exitCode: 0,
      timedOut: false,
      sandbox: {
        network: "inherit",
        cwdRequested: false,
      },
    });
    expect(result.metadata?.kind).toBe("command");
    if (result.metadata?.kind === "command") {
      expect(result.metadata.sandbox.envAllowlist).toContain("PATH");
      expect(typeof result.metadata.sandbox.maxOutputBytes).toBe("number");
      expect(typeof result.metadata.sandbox.timeoutMs).toBe("number");
      expect(typeof result.metadata.sandbox.terminationGraceMs).toBe("number");
    }
    // The metadata must not carry the argument VALUES or any captured stdout.
    expect(JSON.stringify(result.metadata)).not.toContain("process.stdout");
    expect(JSON.stringify(result.metadata)).not.toContain("ok");
  });
});

describe("WorkspaceToolHost — S-M2 config deep-merge + envAllowlist validation", () => {
  it("a partial sandbox override keeps the full default env allowlist (PATH reaches the child)", async () => {
    // Overriding only maxOutputBytes must NOT drop envAllowlist (the shallow-spread bug).
    const result = await host({
      spawn: nodeSpawnFn,
      config: { sandbox: { maxOutputBytes: 4_096 }, commandRules: NODE_COMMAND_RULES },
      processEnv: { PATH: process.env.PATH ?? "" },
    }).execute(
      request("run_command", {
        command: "node",
        args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"],
      }),
    );
    const summary = parse(result.output) as { exitCode: number; stdout: string };
    expect(summary.exitCode).toBe(0);
    expect(JSON.parse(summary.stdout) as string[]).toContain("PATH");
  });

  it("an explicitly-empty envAllowlist rejects cleanly (no synchronous throw)", async () => {
    const spawn = recordingSpawn();
    // The call must return a rejected promise, never throw synchronously, so awaiting it works.
    const promise = host({
      spawn: spawn.fn,
      config: { sandbox: { envAllowlist: [] } },
    }).execute(request("run_command", { command: "node", args: ["-e", "1"] }));
    await expect(promise).rejects.toBeInstanceOf(CommandDeniedError);
    expect(spawn.calls()).toHaveLength(0);
  });
});

describe("WorkspaceToolHost — patch tools", () => {
  const MODIFY = "--- a/src/x.txt\n+++ b/src/x.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n";

  it("propose_patch returns a preview and writes nothing", async () => {
    write("src/x.txt", "one\ntwo\n");
    const before = read("src/x.txt");
    const result = await host().execute(request("propose_patch", { diff: MODIFY }));
    expect(parse(result.output).preview).toContain("PATCH OK");
    expect(read("src/x.txt")).toBe(before);
    expect(result.commandExecuted).toBe(false);
  });

  it("apply_patch is fail-closed by default (applyEnabled false)", async () => {
    write("src/x.txt", "one\ntwo\n");
    await expect(host().execute(request("apply_patch", { diff: MODIFY }))).rejects.toBeInstanceOf(
      PatchApplyDisabledError,
    );
    expect(read("src/x.txt")).toBe("one\ntwo\n");
  });

  it("apply_patch applies when explicitly enabled", async () => {
    write("src/x.txt", "one\ntwo\n");
    const result = await host({ config: { applyEnabled: true } }).execute(
      request("apply_patch", { diff: MODIFY }),
    );
    expect(parse(result.output).changedFiles).toEqual(["src/x.txt"]);
    expect(read("src/x.txt")).toBe("one\nTWO\n");
  });

  it("S-M1: apply_patch attaches patch-apply metadata with counts only (no paths)", async () => {
    write("src/x.txt", "one\ntwo\n");
    const result = await host({ config: { applyEnabled: true } }).execute(
      request("apply_patch", { diff: MODIFY }),
    );
    expect(result.metadata).toEqual({
      kind: "patch-apply",
      changedFiles: 1,
      created: 0,
      deleted: 0,
    });
    // Counts only — no file path leaks into the audit metadata.
    expect(JSON.stringify(result.metadata)).not.toContain("src/x.txt");
  });
});

describe("WorkspaceToolHost — path traversal", () => {
  it("read_file rejects a traversal path", async () => {
    await expect(
      host().execute(request("read_file", { path: "../../etc/passwd" })),
    ).rejects.toThrow();
  });

  it("read_file rejects a denied path (.env)", async () => {
    write(".env", "SECRET=1");
    await expect(host().execute(request("read_file", { path: ".env" }))).rejects.toThrow();
  });
});
