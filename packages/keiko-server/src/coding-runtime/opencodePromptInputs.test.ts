import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  OPENCODE_PROMPT_FILE_MAX_BYTES,
  OPENCODE_PROMPT_FILES_MAX_BYTES,
  OPENCODE_PROMPT_RUN_FILES_MAX_BYTES,
  createOpenCodePromptInputsRunPort,
  openCodePromptInputs,
  recordPromptInputs,
  resolvePromptReferences,
  type PromptInputsRefusal,
  type PromptInputsRun,
} from "./opencodePromptInputs.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-prompt-inputs-")));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "README.md"), "# readme\n");
  writeFileSync(join(workspace, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-CANARY\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function resolveOne(
  path: string,
  remainingRunBytes = Number.MAX_SAFE_INTEGER,
): ReturnType<typeof resolvePromptReferences> {
  return resolvePromptReferences({
    workspaceRoot: workspace,
    references: [{ path }],
    remainingRunBytes,
  });
}

function refusal(path: string): PromptInputsRefusal | undefined {
  const resolved = resolveOne(path);
  return resolved.ok ? undefined : resolved.reason;
}

describe("OpenCode prompt input capabilities", () => {
  it("offers delivery and references only on the native service", () => {
    expect(openCodePromptInputs("native")).toEqual({ delivery: true, references: true });
    expect(openCodePromptInputs("direct")).toEqual({ delivery: false, references: false });
    expect(openCodePromptInputs("code-mode")).toEqual({ delivery: false, references: false });
  });
});

describe("prompt references resolved against the run's workspace", () => {
  it("maps a contained text file to its absolute file URI and name, never the relative path", () => {
    const resolved = resolvePromptReferences({
      workspaceRoot: workspace,
      references: [{ path: "src/app.ts" }, { path: "README.md" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toEqual({
      ok: true,
      files: [
        { uri: `file://${join(workspace, "src", "app.ts")}`, name: "app.ts" },
        { uri: `file://${join(workspace, "README.md")}`, name: "README.md" },
      ],
      bytes: "export const app = 1;\n".length + "# readme\n".length,
    });
  });

  it("percent-encodes names so the URI resolves back to the very file", () => {
    for (const name of ["my notes.md", "a#b.md", "q?.md", "100%.md", "ünïcode-名前.md"]) {
      writeFileSync(join(workspace, name), "x\n");
      const resolved = resolveOne(name);
      expect(resolved.ok, name).toBe(true);
      if (!resolved.ok) continue;
      const uri = resolved.files[0]?.uri ?? "";
      expect(uri.includes("#") || uri.includes("?")).toBe(false);
      expect(fileURLToPath(uri)).toBe(join(workspace, name));
    }
  });

  it("canonicalizes a workspace root that is itself reached through a link", () => {
    const alias = join(root, "alias");
    symlinkSync(workspace, alias);
    const resolved = resolvePromptReferences({
      workspaceRoot: alias,
      references: [{ path: "README.md" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toMatchObject({
      ok: true,
      files: [{ uri: `file://${join(workspace, "README.md")}` }],
    });
  });

  it.each([
    ["a parent segment", "../outside/secret.txt"],
    ["a nested parent segment", "src/../../outside/secret.txt"],
    ["an absolute path", "/etc/passwd"],
    ["a backslash path", "src\\app.ts"],
    ["a drive path", "C:/Windows/win.ini"],
    ["a NUL byte", "src/app.ts\u0000.png"],
    ["an empty segment", "src//app.ts"],
    ["a dot segment", "./README.md"],
    ["an empty path", ""],
    ["a trailing slash", "src/"],
  ])("refuses %s before touching the filesystem", (_label, path) => {
    expect(refusal(path)).toBe("reference-invalid");
  });

  it.each([
    ".env",
    ".env.local",
    "src/.env.production",
    ".git/config",
    "node_modules/pkg/index.js",
    "keys/server.pem",
    "deploy/id_rsa",
    ".ssh/config",
    ".npmrc",
    ".ENV",
  ])("refuses the sensitive path %s even though the file exists", (path) => {
    mkdirSync(join(workspace, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(workspace, ...path.split("/")), "TOKEN=SENSITIVE-CANARY\n");
    expect(refusal(path)).toBe("reference-sensitive");
  });

  it("admits .env.example, the one documented exception", () => {
    writeFileSync(join(workspace, ".env.example"), "TOKEN=\n");
    expect(resolveOne(".env.example").ok).toBe(true);
  });

  it("refuses a symlink that leaves the workspace, for a file and for a directory", () => {
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));
    symlinkSync(outside, join(workspace, "linked-dir"));
    expect(refusal("link.txt")).toBe("reference-outside-workspace");
    expect(refusal("linked-dir/secret.txt")).toBe("reference-outside-workspace");
  });

  it("judges the sensitive names of the real path a link resolves to", () => {
    writeFileSync(join(workspace, ".env"), "TOKEN=SENSITIVE-CANARY\n");
    symlinkSync(join(workspace, ".env"), join(workspace, "innocent.txt"));
    expect(refusal("innocent.txt")).toBe("reference-sensitive");
  });

  it("attaches a link to an ordinary file once, under its real path", () => {
    symlinkSync(join(workspace, "README.md"), join(workspace, "readme-link.md"));
    const resolved = resolvePromptReferences({
      workspaceRoot: workspace,
      references: [{ path: "README.md" }, { path: "readme-link.md" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toEqual({
      ok: true,
      files: [{ uri: `file://${join(workspace, "README.md")}`, name: "README.md" }],
      bytes: "# readme\n".length,
    });
  });

  it("refuses a hard link, which can name a file outside the workspace", () => {
    linkSync(join(outside, "secret.txt"), join(workspace, "hard.txt"));
    expect(refusal("hard.txt")).toBe("reference-not-file");
  });

  it("refuses a directory, a missing file and a FIFO", () => {
    expect(refusal("src")).toBe("reference-not-file");
    expect(refusal("src/missing.ts")).toBe("reference-unreadable");
    const fifo = join(workspace, "pipe");
    if (spawnSync("mkfifo", [fifo]).status === 0)
      expect(refusal("pipe")).toBe("reference-not-file");
  });

  it("refuses a file that is not valid UTF-8 text", () => {
    writeFileSync(join(workspace, "blob.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 0]));
    writeFileSync(join(workspace, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    writeFileSync(join(workspace, "nul.txt"), "text\u0000more");
    expect(refusal("blob.bin")).toBe("reference-not-text");
    expect(refusal("latin1.txt")).toBe("reference-not-text");
    expect(refusal("nul.txt")).toBe("reference-not-text");
  });

  it("bounds one file at exactly 64 KiB", () => {
    writeFileSync(join(workspace, "exact.txt"), "x".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES));
    writeFileSync(join(workspace, "over.txt"), "x".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES + 1));
    expect(resolveOne("exact.txt")).toMatchObject({
      ok: true,
      bytes: OPENCODE_PROMPT_FILE_MAX_BYTES,
    });
    expect(refusal("over.txt")).toBe("reference-too-large");
  });

  it("refuses the whole prompt when the files add up past the prompt bound", () => {
    const names = ["a.txt", "b.txt", "c.txt", "d.txt"];
    for (const name of names)
      writeFileSync(join(workspace, name), "x".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES));
    const within = resolvePromptReferences({
      workspaceRoot: workspace,
      references: names.slice(0, 3).map((path) => ({ path })),
      remainingRunBytes: 10_000_000,
    });
    expect(within).toMatchObject({ ok: true, bytes: OPENCODE_PROMPT_FILES_MAX_BYTES });
    expect(
      resolvePromptReferences({
        workspaceRoot: workspace,
        references: names.map((path) => ({ path })),
        remainingRunBytes: 10_000_000,
      }),
    ).toEqual({ ok: false, reason: "references-prompt-budget" });
  });

  it("refuses a prompt that would outgrow what the run may still attach", () => {
    expect(resolveOne("src/app.ts", "export const app = 1;\n".length)).toMatchObject({ ok: true });
    expect(resolveOne("src/app.ts", "export const app = 1;\n".length - 1)).toEqual({
      ok: false,
      reason: "references-run-budget",
    });
    expect(resolveOne("src/app.ts", 0)).toEqual({ ok: false, reason: "references-run-budget" });
  });

  it("returns nothing at all when any one reference is refused", () => {
    expect(
      resolvePromptReferences({
        workspaceRoot: workspace,
        references: [{ path: "README.md" }, { path: ".env" }, { path: "src/app.ts" }],
        remainingRunBytes: 1_000_000,
      }),
    ).toEqual({ ok: false, reason: "reference-sensitive" });
  });

  it("refuses every reference when the workspace root cannot be resolved", () => {
    expect(
      resolvePromptReferences({
        workspaceRoot: join(root, "gone"),
        references: [{ path: "README.md" }],
        remainingRunBytes: 1_000_000,
      }),
    ).toEqual({ ok: false, reason: "reference-unreadable" });
  });

  it("never lets a path through that the unlinked read would refuse after a swap to a link", () => {
    // A directory swapped for a link between two prompts is judged afresh on every resolution.
    expect(resolveOne("src/app.ts").ok).toBe(true);
    rmSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(outside, "src"));
    writeFileSync(join(outside, "src", "app.ts"), "OUTSIDE-CANARY\n");
    symlinkSync(join(outside, "src"), join(workspace, "src"));
    expect(refusal("src/app.ts")).toBe("reference-outside-workspace");
  });
});

describe("prompt input evidence", () => {
  it("records counts and closed words for an accepted delivery, never a path or a name", () => {
    const sink = createBufferedServerLogSink();
    recordPromptInputs(
      sink,
      "run-1",
      { delivery: "queue", referenceCount: 1, correlationId: "corr-0123456789" },
      { outcome: "accepted", attachedBytes: 12 },
    );
    expect(sink.events).toHaveLength(1);
    const [event] = sink.events;
    expect(event).toMatchObject({
      op: "coding-runtime.prompt-inputs.settled",
      category: "process",
      level: "info",
      correlationId: "corr-0123456789",
      extra: {
        runId: "run-1",
        outcome: "accepted",
        delivery: "queue",
        referenceCount: 1,
        attachedBytes: 12,
      },
    });
  });

  it("records a refusal with its closed reason at warn and the run as the fallback correlation", () => {
    const sink = createBufferedServerLogSink();
    recordPromptInputs(
      sink,
      "run-1",
      { referenceCount: 1 },
      { outcome: "refused", reason: "reference-sensitive" },
    );
    const [event] = sink.events;
    expect(event).toMatchObject({
      level: "warn",
      correlationId: "unknown-correlation-id",
      extra: {
        runId: "run-1",
        outcome: "refused",
        delivery: "none",
        referenceCount: 1,
        reason: "reference-sensitive",
      },
    });
    expect(JSON.stringify(event)).not.toContain(".env");
  });

  // Needs the regenerated Activity Log registry (`npm run generate:op-catalog`), which carries the
  // typed registration this operation declares.
  it("is a registered, persistable line: the production formatter accepts exactly its fields", () => {
    const sink = createBufferedServerLogSink();
    recordPromptInputs(
      sink,
      "run-1",
      { delivery: "steer", referenceCount: 1, correlationId: "corr-0123456789" },
      { outcome: "accepted", attachedBytes: 3 },
    );
    recordPromptInputs(
      sink,
      "run-1",
      { referenceCount: 0 },
      { outcome: "refused", reason: "turn-not-running" },
    );
    const lines = sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.prompt-inputs.settled.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
    expect(lines).toMatchObject([
      { runId: "run-1", outcome: "accepted", delivery: "steer", referenceCount: 1 },
      { outcome: "refused", delivery: "none", referenceCount: 0, reason: "turn-not-running" },
    ]);
  });
});

describe("the run port that admits and delivers prompt inputs", () => {
  const NATIVE = openCodePromptInputs("native");
  const MAPPED = openCodePromptInputs("direct");

  interface Harness {
    readonly run: PromptInputsRun;
    readonly prompts: unknown[][];
    readonly failures: unknown[];
    readonly sink: ReturnType<typeof createBufferedServerLogSink>;
    inFlight: boolean;
    readonly port: ReturnType<typeof createOpenCodePromptInputsRunPort>;
  }

  function harness(
    options: {
      readonly capabilities?: typeof NATIVE;
      readonly missing?: boolean;
      readonly rejectPrompt?: boolean;
    } = {},
  ): Harness {
    const prompts: unknown[][] = [];
    const failures: unknown[] = [];
    const sink = createBufferedServerLogSink();
    const state = { inFlight: true };
    const run: PromptInputsRun = {
      runId: "run-1",
      workspaceRoot: workspace,
      sessionId: "ses_1",
      client: {
        prompt: (...args: unknown[]): Promise<void> => {
          prompts.push(args);
          return options.rejectPrompt === true
            ? Promise.reject(new Error("opencode-v2-response-invalid"))
            : Promise.resolve();
        },
      },
      runtimeAdapter: { turnInFlight: (): boolean => state.inFlight },
      ready: true,
    };
    const port = createOpenCodePromptInputsRunPort({
      readyRun: (runId) => (options.missing === true || runId !== "run-1" ? undefined : run),
      capabilities: options.capabilities ?? NATIVE,
      activityLog: sink,
      recordPostFailure: (_runId, error) => failures.push(error),
    });
    return {
      run,
      prompts,
      failures,
      sink,
      port,
      get inFlight(): boolean {
        return state.inFlight;
      },
      set inFlight(value: boolean) {
        state.inFlight = value;
      },
    };
  }

  const lines = (h: Harness): unknown[] =>
    h.sink.events.map((event) => (event as { extra?: unknown }).extra);

  it("reports the capabilities it was composed with", () => {
    expect(harness().port.promptInputs).toEqual({ delivery: true, references: true });
    expect(harness({ capabilities: MAPPED }).port.promptInputs).toEqual({
      delivery: false,
      references: false,
    });
  });

  it("refuses a delivery and references on a profile that offers neither, recording a closed reason", () => {
    const h = harness({ capabilities: MAPPED });
    expect(h.port.admitPromptInputs("run-1", { delivery: "steer" })).toEqual({
      ok: false,
      reason: "delivery-unsupported",
    });
    expect(h.port.admitPromptInputs("run-1", { references: [{ path: "README.md" }] })).toEqual({
      ok: false,
      reason: "references-unsupported",
    });
    expect(lines(h)).toMatchObject([
      { outcome: "refused", delivery: "steer", reason: "delivery-unsupported" },
      { outcome: "refused", delivery: "none", referenceCount: 1, reason: "references-unsupported" },
    ]);
  });

  it("refuses an unknown run and a delivery with no turn in flight", () => {
    expect(
      harness({ missing: true }).port.admitPromptInputs("run-1", { delivery: "queue" }),
    ).toEqual({
      ok: false,
      reason: "run-unavailable",
    });
    const h = harness();
    h.inFlight = false;
    expect(h.port.admitPromptInputs("run-1", { delivery: "queue" })).toEqual({
      ok: false,
      reason: "turn-not-running",
    });
    expect(h.port.admitPromptInputs("other-run", { delivery: "queue" })).toEqual({
      ok: false,
      reason: "run-unavailable",
    });
  });

  it("admits a delivery while the turn runs and resolves its references to attachments", () => {
    const h = harness();
    const admitted = h.port.admitPromptInputs("run-1", {
      delivery: "steer",
      references: [{ path: "src/app.ts" }],
      correlationId: "corr-0123456789",
    });
    expect(admitted).toEqual({
      ok: true,
      inputs: {
        delivery: "steer",
        referenceCount: 1,
        correlationId: "corr-0123456789",
        files: [{ uri: `file://${join(workspace, "src", "app.ts")}`, name: "app.ts" }],
        fileBytes: "export const app = 1;\n".length,
      },
    });
    expect(h.sink.events, "admission alone records nothing: only a settled prompt does").toEqual(
      [],
    );
  });

  it("refuses the prompt when a reference is hostile, naming only the closed reason", () => {
    const h = harness();
    writeFileSync(join(workspace, ".env"), "TOKEN=SENSITIVE-CANARY\n");
    for (const [path, reason] of [
      ["../outside/secret.txt", "reference-invalid"],
      [".env", "reference-sensitive"],
      ["missing.ts", "reference-unreadable"],
    ] as const) {
      expect(h.port.admitPromptInputs("run-1", { references: [{ path }] })).toEqual({
        ok: false,
        reason,
      });
    }
    expect(lines(h)).toMatchObject([
      { reason: "reference-invalid" },
      { reason: "reference-sensitive" },
      { reason: "reference-unreadable" },
    ]);
    expect(JSON.stringify(h.sink.events)).not.toMatch(/secret\.txt|\.env|missing\.ts|CANARY/u);
  });

  it("delivers with the closed delivery and the files, starts nothing and records what was attached", async () => {
    const h = harness();
    const admitted = h.port.admitPromptInputs("run-1", {
      delivery: "queue",
      references: [{ path: "README.md" }],
    });
    if (!admitted.ok) throw new Error("expected admission");
    await expect(h.port.deliverPrompt("run-1", "also this", admitted.inputs)).resolves.toBe(true);
    expect(h.prompts).toEqual([
      [
        "ses_1",
        "also this",
        undefined,
        undefined,
        { delivery: "queue", files: admitted.inputs.files },
      ],
    ]);
    expect(lines(h)).toMatchObject([
      {
        runId: "run-1",
        outcome: "accepted",
        delivery: "queue",
        referenceCount: 1,
        attachedBytes: "# readme\n".length,
      },
    ]);
    expect(h.run.promptFileBytes).toBe("# readme\n".length);
  });

  it("does not send a delivery whose turn settled after admission", async () => {
    const h = harness();
    const admitted = h.port.admitPromptInputs("run-1", { delivery: "steer" });
    if (!admitted.ok) throw new Error("expected admission");
    h.inFlight = false;
    await expect(h.port.deliverPrompt("run-1", "late", admitted.inputs)).resolves.toBe(false);
    expect(h.prompts).toEqual([]);
    expect(lines(h)).toMatchObject([{ outcome: "refused", reason: "turn-not-running" }]);
  });

  it("refuses to deliver anything that is not a delivery, and for an unknown run", async () => {
    const h = harness();
    const plain = h.port.admitPromptInputs("run-1", { references: [{ path: "README.md" }] });
    if (!plain.ok) throw new Error("expected admission");
    await expect(h.port.deliverPrompt("run-1", "t", plain.inputs)).resolves.toBe(false);
    const steer = h.port.admitPromptInputs("run-1", { delivery: "steer" });
    if (!steer.ok) throw new Error("expected admission");
    await expect(h.port.deliverPrompt("gone", "t", steer.inputs)).resolves.toBe(false);
    expect(h.prompts).toEqual([]);
  });

  it("reports a prompt the runtime rejected through the composition's diagnostic, not as accepted", async () => {
    const h = harness({ rejectPrompt: true });
    const admitted = h.port.admitPromptInputs("run-1", { delivery: "steer" });
    if (!admitted.ok) throw new Error("expected admission");
    await expect(h.port.deliverPrompt("run-1", "t", admitted.inputs)).resolves.toBe(false);
    expect(h.failures).toHaveLength(1);
    expect(h.sink.events).toEqual([]);
    expect(h.run.promptFileBytes).toBeUndefined();
  });

  it("charges every accepted prompt's files to the run and refuses the prompt that would outgrow it", () => {
    const h = harness();
    writeFileSync(join(workspace, "big.txt"), "x".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES));
    h.run.promptFileBytes = OPENCODE_PROMPT_RUN_FILES_MAX_BYTES - OPENCODE_PROMPT_FILE_MAX_BYTES;
    expect(h.port.admitPromptInputs("run-1", { references: [{ path: "big.txt" }] }).ok).toBe(true);
    h.run.promptFileBytes =
      OPENCODE_PROMPT_RUN_FILES_MAX_BYTES - OPENCODE_PROMPT_FILE_MAX_BYTES + 1;
    expect(h.port.admitPromptInputs("run-1", { references: [{ path: "big.txt" }] })).toEqual({
      ok: false,
      reason: "references-run-budget",
    });
  });
});
