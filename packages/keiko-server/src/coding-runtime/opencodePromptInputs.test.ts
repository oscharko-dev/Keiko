import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES,
  CODING_WORKBENCH_RUNTIME_INBOX_PREVIEW_MAX_CHARS,
  validateCodingWorkbenchRuntimeInboxChannelPayload,
} from "@oscharko-dev/keiko-contracts/runtime/coding-workbench-runtime-api";
import { activityLogEventWillBeRejected } from "@oscharko-dev/keiko-contracts/runtime/observability";

import { createBufferedServerLogSink } from "../../../../tests/support/buffered-server-log.js";
import {
  plantDirectoryRedirect,
  plantSymlinkOrSkip,
  WINDOWS_HOST,
} from "../test-support/symlink-fixture.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import {
  OpenCodeV2HttpStatusError,
  OpenCodeV2PromptRefusedError,
  OpenCodeV2ReceiptMismatchError,
  OPENCODE_PROMPT_FILE_MAX_BYTES,
  OPENCODE_PROMPT_MEDIA_MAX_BYTES,
  openCodeV2PromptFileData,
} from "./opencodeV2HttpClient.js";
import {
  OPENCODE_NATIVE_INPUT_LEDGER_MAX,
  OPENCODE_PROMPT_FILES_MAX_BYTES,
  OPENCODE_PROMPT_RUN_FILES_MAX_BYTES,
  createOpenCodePromptInputsRunPort,
  nativeInputPreview,
  openCodePromptInputs,
  recordPromptInputs,
  resolvePromptReferences,
  runtimePromptInputs,
  type AdmittedPromptInputs,
  type PromptInputsAdmission,
  type PromptInputsRefusal,
  type PromptInputsRun,
} from "./opencodePromptInputs.js";

let root: string;
let workspace: string;
let outside: string;

/** A file's bytes as the attachment carries them. */
function inline(text: string): string {
  return openCodeV2PromptFileData(Buffer.from(text, "utf8"));
}

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

describe("the runtime inputs of an admitted prompt (#3906)", () => {
  const MENTIONS = {
    agents: [{ name: "general", mention: { start: 4, end: 12, text: "@general" } }],
    skills: [{ id: "review-method" }],
  };
  const admittedWith = (files: readonly { uri: string; name: string }[]): AdmittedPromptInputs => ({
    referenceCount: files.length,
    files,
    fileBytes: 0,
    mentions: MENTIONS,
  });

  it("sends the mentions as typed when the text leads with nothing", () => {
    expect(runtimePromptInputs(admittedWith([]))).toEqual({ mentions: MENTIONS });
    expect(runtimePromptInputs(undefined)).toEqual({});
  });

  it("moves every span by the hidden context the sent text leads with, and only the span", () => {
    const context = "Earlier context of the task.";
    const sent = `${context}\n\nAsk @general now.`;
    const moved = runtimePromptInputs(admittedWith([]), context.length + 2);
    const span = moved.mentions?.agents?.[0]?.mention;

    expect(span).toEqual({
      start: 4 + context.length + 2,
      end: 12 + context.length + 2,
      text: "@general",
    });
    expect(sent.slice(span?.start, span?.end)).toBe("@general");
    expect(moved.mentions?.skills).toEqual([{ id: "review-method" }]);
  });

  it("records how many agents and skills a prompt mentions, never a name", () => {
    const sink = createBufferedServerLogSink();
    recordPromptInputs(sink, "run-1", admittedWith([]), { outcome: "accepted", attachedBytes: 0 });
    expect(sink.events[0]?.extra).toMatchObject({ agentMentionCount: 1, skillMentionCount: 1 });
    expect(JSON.stringify(sink.events)).not.toMatch(/general|review-method/u);
  });
});

describe("OpenCode prompt input capabilities", () => {
  it("offers delivery, references, slash commands and mentions only on the native service", () => {
    expect(openCodePromptInputs("native")).toEqual({
      delivery: true,
      references: true,
      commands: true,
      mentions: true,
    });
    for (const profile of ["direct", "code-mode"] as const) {
      expect(openCodePromptInputs(profile)).toEqual({
        delivery: false,
        references: false,
        commands: false,
        mentions: false,
      });
    }
  });
});

describe("prompt references resolved against the run's workspace", () => {
  it("maps a contained text file to its admitted bytes inline and its name, never a path", () => {
    const resolved = resolvePromptReferences({
      workspaceRoot: workspace,
      references: [{ path: "src/app.ts" }, { path: "README.md" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toEqual({
      ok: true,
      files: [
        { uri: inline("export const app = 1;\n"), name: "app.ts" },
        { uri: inline("# readme\n"), name: "README.md" },
      ],
      bytes: "export const app = 1;\n".length + "# readme\n".length,
    });
  });

  function expectCarriedUnderOwnName(name: string): void {
    writeFileSync(join(workspace, name), "ünïcode x\n");
    const resolved = resolveOne(name);
    expect(resolved.ok, name).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.files[0]).toEqual({ uri: inline("ünïcode x\n"), name });
  }

  it("carries the file's exact bytes and its own name whatever the name contains", () => {
    for (const name of ["my notes.md", "a#b.md", "100%.md", "ünïcode-名前.md"])
      expectCarriedUnderOwnName(name);
  });

  // Windows forbids `?` in a file name, so the host cannot create this fixture (#4068).
  it.skipIf(WINDOWS_HOST)("carries a name that contains a question mark", () => {
    expectCarriedUnderOwnName("q?.md");
  });

  // #3897 review: the runtime must not reopen the path the resolver admitted. A hard link to an
  // outside file swapped in after admission would otherwise reach the model in its place.
  it("keeps the admitted bytes when the path is replaced by a link to an outside file afterwards", () => {
    writeFileSync(join(workspace, "notes.md"), "ADMITTED_BYTES\n");
    const canary = join(outside, "canary.md");
    writeFileSync(canary, "OUTSIDE_CANARY_THAT_MUST_NOT_BE_SENT\n");
    const resolved = resolveOne("notes.md");
    rmSync(join(workspace, "notes.md"));
    linkSync(canary, join(workspace, "notes.md"));
    expect(resolved).toMatchObject({ ok: true, files: [{ uri: inline("ADMITTED_BYTES\n") }] });
    expect(JSON.stringify(resolved)).not.toContain(
      Buffer.from("OUTSIDE_CANARY").toString("base64").slice(0, 16),
    );
    expect(JSON.stringify(resolved)).not.toContain(workspace);
  });

  it("canonicalizes a workspace root that is itself reached through a link", () => {
    const alias = join(root, "alias");
    // A junction on Windows (no privilege needed), a directory symlink elsewhere (#4068).
    plantDirectoryRedirect(workspace, alias);
    const resolved = resolvePromptReferences({
      workspaceRoot: alias,
      references: [{ path: "README.md" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toMatchObject({
      ok: true,
      files: [{ uri: inline("# readme\n") }],
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

  // A file link needs a privilege an ordinary Windows account lacks; each directory form runs on
  // every host, as a junction there and a directory symlink elsewhere (#4068).
  it("refuses a symlink that leaves the workspace, for a file", (testContext) => {
    plantSymlinkOrSkip(testContext, join(outside, "secret.txt"), join(workspace, "link.txt"));
    expect(refusal("link.txt")).toBe("reference-outside-workspace");
  });

  it("refuses a symlink that leaves the workspace, for a directory", () => {
    plantDirectoryRedirect(outside, join(workspace, "linked-dir"));
    expect(refusal("linked-dir/secret.txt")).toBe("reference-outside-workspace");
  });

  it("judges the sensitive names of the real path a link resolves to", (testContext) => {
    writeFileSync(join(workspace, ".env"), "TOKEN=SENSITIVE-CANARY\n");
    plantSymlinkOrSkip(testContext, join(workspace, ".env"), join(workspace, "innocent.txt"));
    expect(refusal("innocent.txt")).toBe("reference-sensitive");
  });

  it("judges the sensitive names of the real path a directory link resolves to", () => {
    mkdirSync(join(workspace, ".ssh"));
    writeFileSync(join(workspace, ".ssh", "config"), "TOKEN=SENSITIVE-CANARY\n");
    plantDirectoryRedirect(join(workspace, ".ssh"), join(workspace, "innocent-dir"));
    expect(refusal("innocent-dir/config")).toBe("reference-sensitive");
  });

  it("attaches a file reached through a directory link once, under its real path", () => {
    plantDirectoryRedirect(join(workspace, "src"), join(workspace, "src-link"));
    const resolved = resolvePromptReferences({
      workspaceRoot: workspace,
      references: [{ path: "src/app.ts" }, { path: "src-link/app.ts" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toEqual({
      ok: true,
      files: [{ uri: inline("export const app = 1;\n"), name: "app.ts" }],
      bytes: "export const app = 1;\n".length,
    });
  });

  it("attaches a link to an ordinary file once, under its real path", (testContext) => {
    plantSymlinkOrSkip(
      testContext,
      join(workspace, "README.md"),
      join(workspace, "readme-link.md"),
    );
    const resolved = resolvePromptReferences({
      workspaceRoot: workspace,
      references: [{ path: "README.md" }, { path: "readme-link.md" }],
      remainingRunBytes: 1_000_000,
    });
    expect(resolved).toEqual({
      ok: true,
      files: [{ uri: inline("# readme\n"), name: "README.md" }],
      bytes: "# readme\n".length,
    });
  });

  it("refuses a hard link, which can name a file outside the workspace", () => {
    linkSync(join(outside, "secret.txt"), join(workspace, "hard.txt"));
    expect(refusal("hard.txt")).toBe("reference-not-file");
  });

  it("refuses a directory and a missing file", () => {
    expect(refusal("src")).toBe("reference-not-file");
    expect(refusal("src/missing.ts")).toBe("reference-unreadable");
  });

  // A `mkfifo` on the PATH proves nothing by its exit status alone: the MSYS one on a Windows host
  // succeeds and leaves no FIFO the Node runtime can see, so the node itself is checked (#4068).
  it("refuses a FIFO", (testContext) => {
    const fifo = join(workspace, "pipe");
    const created =
      spawnSync("mkfifo", [fifo]).status === 0 &&
      lstatSync(fifo, { throwIfNoEntry: false })?.isFIFO() === true;
    if (!created) testContext.skip("this host cannot create a POSIX FIFO the runtime can see");
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
    // A junction on Windows (no privilege needed), a directory symlink elsewhere (#4068).
    plantDirectoryRedirect(join(outside, "src"), join(workspace, "src"));
    expect(refusal("src/app.ts")).toBe("reference-outside-workspace");
  });
});

// #3906 AC1: an image or PDF the human references reaches a model that declares that input, as
// the very bytes the descriptor read proved, under its own type.
describe("image and PDF references", () => {
  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from("synthetic image body"),
  ]);
  const PDF = Buffer.from("%PDF-1.4\nsynthetic document\n%%EOF\n", "latin1");
  const BOTH = { image: true, pdf: true } as const;

  function resolveMedia(
    paths: readonly string[],
    media: { readonly image: boolean; readonly pdf: boolean } = BOTH,
    remainingRunBytes = OPENCODE_PROMPT_RUN_FILES_MAX_BYTES,
  ): ReturnType<typeof resolvePromptReferences> {
    return resolvePromptReferences({
      workspaceRoot: workspace,
      references: paths.map((path) => ({ path })),
      remainingRunBytes,
      media,
    });
  }

  it("attaches an image and a PDF byte for byte under their own types", () => {
    writeFileSync(join(workspace, "screen.png"), PNG);
    writeFileSync(join(workspace, "spec.PDF"), PDF);

    expect(resolveMedia(["screen.png", "spec.PDF"])).toEqual({
      ok: true,
      bytes: PNG.length + PDF.length,
      files: [
        { uri: `data:image/png;base64,${PNG.toString("base64")}`, name: "screen.png" },
        { uri: `data:application/pdf;base64,${PDF.toString("base64")}`, name: "spec.PDF" },
      ],
    });
  });

  it("refuses an image or PDF the run's model does not declare, before anything is read", () => {
    writeFileSync(join(workspace, "screen.png"), PNG);
    writeFileSync(join(workspace, "spec.pdf"), PDF);

    expect(resolveMedia(["screen.png"], { image: false, pdf: true })).toEqual({
      ok: false,
      reason: "reference-media-unsupported",
    });
    expect(resolveMedia(["spec.pdf"], { image: true, pdf: false })).toEqual({
      ok: false,
      reason: "reference-media-unsupported",
    });
    // A run that names no media (a mapped profile, an older caller) attaches none.
    expect(refusal("screen.png")).toBe("reference-media-unsupported");
  });

  it("never sends a renamed file as what it is not", () => {
    writeFileSync(join(workspace, "notes.png"), "plain text named like an image\n");
    writeFileSync(join(workspace, "image.pdf"), PNG);

    expect(resolveMedia(["notes.png"])).toEqual({ ok: false, reason: "reference-not-media" });
    expect(resolveMedia(["image.pdf"])).toEqual({ ok: false, reason: "reference-not-media" });
  });

  it("bounds one medium at its own ceiling and the run at its budget", () => {
    const large = Buffer.concat([PNG, Buffer.alloc(OPENCODE_PROMPT_MEDIA_MAX_BYTES - PNG.length)]);
    writeFileSync(join(workspace, "exact.png"), large);
    writeFileSync(join(workspace, "over.png"), Buffer.concat([large, Buffer.from([0])]));

    expect(resolveMedia(["exact.png"])).toMatchObject({ ok: true, bytes: large.length });
    expect(resolveMedia(["over.png"])).toEqual({ ok: false, reason: "reference-too-large" });
    expect(resolveMedia(["exact.png"], BOTH, large.length - 1)).toEqual({
      ok: false,
      reason: "references-run-budget",
    });
  });

  it("charges media to the run's budget, not to the prompt's text bound", () => {
    const names = ["a.txt", "b.txt", "c.txt"];
    for (const name of names)
      writeFileSync(join(workspace, name), "x".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES));
    writeFileSync(join(workspace, "screen.png"), PNG);

    expect(resolveMedia([...names, "screen.png"])).toMatchObject({
      ok: true,
      bytes: OPENCODE_PROMPT_FILES_MAX_BYTES + PNG.length,
    });
  });

  it("keeps the sensitive-path boundary for media", () => {
    expect(resolveMedia([".env.png"])).toMatchObject({ ok: false });
  });

  it("keeps the workspace boundary for a media file link", (testContext) => {
    writeFileSync(join(outside, "leak.png"), PNG);
    plantSymlinkOrSkip(testContext, join(outside, "leak.png"), join(workspace, "linked.png"));

    expect(resolveMedia(["linked.png"])).toEqual({
      ok: false,
      reason: "reference-outside-workspace",
    });
  });

  it("keeps the workspace boundary for media reached through a directory link", () => {
    writeFileSync(join(outside, "leak.png"), PNG);
    plantDirectoryRedirect(outside, join(workspace, "linked-media"));

    expect(resolveMedia(["linked-media/leak.png"])).toEqual({
      ok: false,
      reason: "reference-outside-workspace",
    });
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
    // A delivery names its operator request and how its native message id was handled: the join key
    // between a lost acknowledgement and the retry that resolved it.
    const delivery = { delivery: "queue", referenceCount: 0, requestId: "req-1" } as const;
    recordPromptInputs(sink, "run-1", delivery, {
      outcome: "refused",
      reason: "delivery-unconfirmed",
      inputBinding: "bound",
      errorKind: "unavailable",
    });
    recordPromptInputs(sink, "run-1", delivery, {
      outcome: "accepted",
      attachedBytes: 0,
      inputBinding: "reused",
    });
    recordPromptInputs(sink, "run-1", delivery, {
      outcome: "refused",
      reason: "request-conflict",
    });
    const lines = sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.prompt-inputs.settled.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );
    expect(lines).toMatchObject([
      { runId: "run-1", outcome: "accepted", delivery: "steer", referenceCount: 1 },
      { outcome: "refused", delivery: "none", referenceCount: 0, reason: "turn-not-running" },
      {
        outcome: "refused",
        delivery: "queue",
        requestId: "req-1",
        inputBinding: "bound",
        reason: "delivery-unconfirmed",
        errorKind: "unavailable",
      },
      { outcome: "accepted", requestId: "req-1", inputBinding: "reused", attachedBytes: 0 },
      { outcome: "refused", requestId: "req-1", reason: "request-conflict" },
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
    /** What the next prompts reject with, one per call; a call past the end succeeds. */
    readonly promptFailures: Error[];
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
    const promptFailures: Error[] = [];
    const sink = createBufferedServerLogSink();
    const state = { inFlight: true };
    let minted = 0;
    const run: PromptInputsRun = {
      runId: "run-1",
      workspaceRoot: workspace,
      sessionId: "ses_1",
      client: {
        prompt: (...args: unknown[]): Promise<void> => {
          prompts.push(args);
          if (options.rejectPrompt === true) {
            return Promise.reject(new Error("opencode-v2-response-invalid"));
          }
          const failure = promptFailures.shift();
          return failure === undefined ? Promise.resolve() : Promise.reject(failure);
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
      mintMessageId: () => `msg_minted_${String((minted += 1))}`,
    });
    return {
      run,
      prompts,
      failures,
      promptFailures,
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
    expect(harness().port.promptInputs).toEqual({
      delivery: true,
      references: true,
      commands: true,
      mentions: true,
    });
    expect(harness({ capabilities: MAPPED }).port.promptInputs).toEqual({
      delivery: false,
      references: false,
      commands: false,
      mentions: false,
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
        files: [{ uri: inline("export const app = 1;\n"), name: "app.ts" }],
        fileBytes: "export const app = 1;\n".length,
      },
    });
    expect(h.sink.events, "admission alone records nothing: only a settled prompt does").toEqual(
      [],
    );
  });

  it("refuses a command on a profile that has none, recording the command only by its digest", () => {
    const h = harness({ capabilities: MAPPED });

    expect(
      h.port.admitPromptInputs("run-1", {
        command: { name: "my-custom", argumentBytes: 4 },
        requestId: "req-1",
      }),
    ).toEqual({ ok: false, reason: "commands-unsupported" });

    expect(lines(h)).toMatchObject([
      {
        outcome: "refused",
        reason: "commands-unsupported",
        command: "other",
        commandDigest: createHash("sha256").update("my-custom", "utf8").digest("hex"),
        commandArgumentBytes: 4,
      },
    ]);
    expect(JSON.stringify(h.sink.events)).not.toContain("my-custom");
  });

  it("admits a command on the native profile with its references, and records nothing until it settles", () => {
    const h = harness();

    const admitted = h.port.admitPromptInputs("run-1", {
      command: { name: "review", argumentBytes: 9 },
      references: [{ path: "src/app.ts" }],
      correlationId: "corr-0123456789",
      requestId: "req-1",
    });

    expect(admitted).toEqual({
      ok: true,
      inputs: {
        command: { name: "review", argumentBytes: 9 },
        referenceCount: 1,
        correlationId: "corr-0123456789",
        requestId: "req-1",
        files: [{ uri: inline("export const app = 1;\n"), name: "app.ts" }],
        fileBytes: "export const app = 1;\n".length,
      },
    });
    expect(h.sink.events).toEqual([]);
  });

  it("refuses the whole command prompt when one of its references is refused", () => {
    const h = harness();

    expect(
      h.port.admitPromptInputs("run-1", {
        command: { name: "review", argumentBytes: 0 },
        references: [{ path: "src/app.ts" }, { path: "../outside/secret.txt" }],
      }),
    ).toEqual({ ok: false, reason: "reference-invalid" });
    expect(lines(h)).toMatchObject([
      { outcome: "refused", reason: "reference-invalid", command: "review" },
    ]);
  });

  it("names a built-in command in the log and any other command by the digest of its name", () => {
    const sink = createBufferedServerLogSink();

    for (const name of ["init", "review", "git:commit", "Review"]) {
      recordPromptInputs(
        sink,
        "run-1",
        { referenceCount: 0, command: { name, argumentBytes: 5 } },
        { outcome: "accepted", attachedBytes: 0 },
      );
    }

    expect(sink.events.map((event) => (event as { extra?: unknown }).extra)).toMatchObject([
      { command: "init", commandArgumentBytes: 5 },
      { command: "review", commandArgumentBytes: 5 },
      {
        command: "other",
        commandDigest: createHash("sha256").update("git:commit", "utf8").digest("hex"),
        commandArgumentBytes: 5,
      },
      {
        command: "other",
        commandDigest: createHash("sha256").update("Review", "utf8").digest("hex"),
      },
    ]);
    const builtIn = sink.events.slice(0, 2).map((event) => (event as { extra: object }).extra);
    for (const extra of builtIn) expect(extra).not.toHaveProperty("commandDigest");
    expect(JSON.stringify(sink.events)).not.toMatch(/git:commit/u);
    for (const event of sink.events) expect(activityLogEventWillBeRejected(event)).toBe(false);
  });

  // The operation's `command` vocabulary is `init`, `review` and `other`: a built-in the contract
  // names must reach the log by name, so the two move together.
  it.each(CODING_WORKBENCH_BUILT_IN_COMMAND_NAMES)(
    "names the contract's built-in command %s by name and not by digest",
    (name) => {
      const sink = createBufferedServerLogSink();

      recordPromptInputs(
        sink,
        "run-1",
        { referenceCount: 0, command: { name, argumentBytes: 0 } },
        { outcome: "accepted", attachedBytes: 0 },
      );

      const extra = (sink.events[0] as { extra: Record<string, unknown> }).extra;
      expect(extra.command).toBe(name);
      expect(extra).not.toHaveProperty("commandDigest");
    },
  );

  it("records a refused command turn with its closed reason and error kind", () => {
    const sink = createBufferedServerLogSink();

    recordPromptInputs(
      sink,
      "run-1",
      { referenceCount: 0, command: { name: "review", argumentBytes: 0 } },
      { outcome: "refused", reason: "command-refused", errorKind: "unavailable" },
    );

    expect(sink.events).toMatchObject([
      {
        level: "warn",
        errorKind: "unavailable",
        extra: { outcome: "refused", reason: "command-refused", command: "review" },
      },
    ]);
    expect(activityLogEventWillBeRejected(sink.events[0] ?? {})).toBe(false);
  });

  // Needs the regenerated Activity Log registry (`npm run generate:op-catalog`), which carries the
  // typed registration this operation declares.
  it("is a registered, persistable line when it names a command", () => {
    const sink = createBufferedServerLogSink();
    recordPromptInputs(
      sink,
      "run-1",
      { referenceCount: 1, command: { name: "review", argumentBytes: 12 }, requestId: "req-1" },
      { outcome: "accepted", attachedBytes: 3 },
    );
    recordPromptInputs(
      sink,
      "run-1",
      { referenceCount: 0, command: { name: "custom", argumentBytes: 0 } },
      { outcome: "refused", reason: "command-unknown" },
    );

    const written = sink.events.map((event) =>
      expectActivityLogProof(
        "coding-runtime.prompt-inputs.settled.emitted-line",
        formatActivityLogProofLine(event),
      ),
    );

    expect(written).toMatchObject([
      { outcome: "accepted", command: "review", commandArgumentBytes: 12, requestId: "req-1" },
      { outcome: "refused", command: "other", reason: "command-unknown" },
    ]);
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
        { id: "msg_minted_1", delivery: "queue", files: admitted.inputs.files },
      ],
    ]);
    expect(lines(h)).toMatchObject([
      {
        runId: "run-1",
        outcome: "accepted",
        delivery: "queue",
        referenceCount: 1,
        attachedBytes: "# readme\n".length,
        inputBinding: "bound",
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
    // Never an accepted line, and nothing charged to the run: the failure is one refused line.
    expect(lines(h)).toMatchObject([
      { outcome: "refused", delivery: "steer", reason: "delivery-unconfirmed" },
    ]);
    expect(h.sink.events.map((event) => (event as { level?: string }).level)).toEqual(["warn"]);
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
  // PR #4064 review (ADR-0137 D10): a delivery whose acknowledgement was lost must resend the id of
  // the unconfirmed attempt, and the answer to a failed attempt must say what the failure proves.
  describe("the native message id bound to the operator request", () => {
    const LOST = new TypeError("fetch failed");

    function admitDelivery(h: Harness, requestId: string | undefined, text = "also this") {
      const admitted = h.port.admitPromptInputs("run-1", {
        delivery: "queue",
        correlationId: "corr-0123456789",
        ...(requestId === undefined ? {} : { requestId }),
      });
      if (!admitted.ok) throw new Error("expected admission");
      return (): Promise<boolean> => h.port.deliverPrompt("run-1", text, admitted.inputs);
    }

    const sentIds = (h: Harness): unknown[] =>
      h.prompts.map((call) => (call[4] as { id?: unknown } | undefined)?.id);

    it("resends the id of an unconfirmed attempt, so a retry is the same native input", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(false);
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_1"]);
      expect(lines(h)).toMatchObject([
        {
          outcome: "refused",
          reason: "delivery-unconfirmed",
          inputBinding: "bound",
          requestId: "req-1",
        },
        { outcome: "accepted", inputBinding: "reused", requestId: "req-1" },
      ]);
      expect(h.failures, "each failed attempt is reported once to the composition").toHaveLength(1);
    });

    it("names the closed error kind of a failed delivery and never its text", async () => {
      const h = harness();
      h.promptFailures.push(new TypeError("PRIVATE-TRANSPORT-DETAIL fetch failed"));
      await admitDelivery(h, "req-1")();
      const [event] = h.sink.events as { errorKind?: string; level?: string }[];
      expect(event?.level).toBe("warn");
      expect(typeof event?.errorKind).toBe("string");
      expect(JSON.stringify(h.sink.events)).not.toContain("PRIVATE-TRANSPORT-DETAIL");
    });

    it("keeps the id through repeated losses and charges the files once, when the id is first sent", async () => {
      const h = harness();
      const attach = h.port.admitPromptInputs("run-1", {
        delivery: "steer",
        requestId: "req-1",
        references: [{ path: "README.md" }],
      });
      if (!attach.ok) throw new Error("expected admission");
      h.promptFailures.push(LOST, new DOMException("timed out", "TimeoutError"));
      const send = (): Promise<boolean> => h.port.deliverPrompt("run-1", "t", attach.inputs);
      await expect(send()).resolves.toBe(false);
      // The producer may already hold the files: they count before any acknowledgement (#4064 review).
      expect(h.run.promptFileBytes).toBe("# readme\n".length);
      await expect(send()).resolves.toBe(false);
      await expect(send()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_1", "msg_minted_1"]);
      // The retries resent the same id and charged nothing again.
      expect(h.run.promptFileBytes).toBe("# readme\n".length);
    });

    it("forgets the id when the producer refused a fresh message: the retry starts clean", async () => {
      const h = harness();
      h.promptFailures.push(new OpenCodeV2HttpStatusError(409));
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(false);
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_2"]);
      expect(lines(h)).toMatchObject([
        { outcome: "refused", reason: "delivery-refused", inputBinding: "bound" },
        { outcome: "accepted", inputBinding: "bound" },
      ]);
    });

    it("forgets the id when the client refused the message before any byte left", async () => {
      const h = harness();
      h.promptFailures.push(new OpenCodeV2PromptRefusedError("opencode-v2-prompt-file-invalid"));
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(false);
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_2"]);
      expect(lines(h)[0]).toMatchObject({ reason: "delivery-refused" });
    });

    it("keeps the id when a refusal answers an attempt that reused it: the first may be stored", async () => {
      const h = harness();
      h.promptFailures.push(LOST, new OpenCodeV2HttpStatusError(409));
      await admitDelivery(h, "req-1")();
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(false);
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_1", "msg_minted_1"]);
      expect(lines(h)[1]).toMatchObject({ reason: "delivery-refused", inputBinding: "reused" });
    });

    it.each([500, 502])("treats an undeclared HTTP %i as possibly accepted", async (status) => {
      const h = harness();
      h.promptFailures.push(new OpenCodeV2HttpStatusError(status));
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(false);
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_1"]);
      expect(lines(h)[0]).toMatchObject({ reason: "delivery-unconfirmed" });
    });

    it("reports a receipt for another id as accepted: it cannot be resent and must not be retried", async () => {
      const h = harness();
      h.promptFailures.push(new OpenCodeV2ReceiptMismatchError());
      await expect(admitDelivery(h, "req-1")()).resolves.toBe(true);
      expect(h.failures).toHaveLength(1);
      expect(lines(h)).toMatchObject([
        { outcome: "accepted", inputBinding: "unreconciled", requestId: "req-1" },
      ]);
      expect(h.sink.events.map((event) => (event as { level?: string }).level)).toEqual(["info"]);
    });

    it("refuses a request id that comes back with another message instead of dropping the new text", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await admitDelivery(h, "req-1", "the first text")();
      await expect(admitDelivery(h, "req-1", "an edited text")()).resolves.toBe(false);
      expect(sentIds(h), "nothing was sent for the conflicting message").toEqual(["msg_minted_1"]);
      expect(lines(h)[1]).toMatchObject({ outcome: "refused", reason: "request-conflict" });
      // The original message is still retryable under its id.
      await expect(admitDelivery(h, "req-1", "the first text")()).resolves.toBe(true);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_1"]);
    });

    it("binds the delivery and the files to the id, not the text alone", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await admitDelivery(h, "req-1")();
      const steered = h.port.admitPromptInputs("run-1", { delivery: "steer", requestId: "req-1" });
      if (!steered.ok) throw new Error("expected admission");
      await expect(h.port.deliverPrompt("run-1", "also this", steered.inputs)).resolves.toBe(false);
      expect(lines(h)[1]).toMatchObject({ reason: "request-conflict" });
      expect(h.prompts).toHaveLength(1);
    });

    it("gives distinct requests distinct ids and a request with no identity a fresh id every time", async () => {
      const h = harness();
      await admitDelivery(h, "req-1")();
      await admitDelivery(h, "req-2")();
      await admitDelivery(h, undefined)();
      await admitDelivery(h, undefined)();
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_2", "msg_minted_3", "msg_minted_4"]);
    });

    it("retains nothing for a request with no identity, so its retry is a new input by design", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await admitDelivery(h, undefined)();
      await admitDelivery(h, undefined)();
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_minted_2"]);
    });

    it("sends nothing and keeps the id when the turn settled before the retry", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      const retry = admitDelivery(h, "req-1");
      await retry();
      h.inFlight = false;
      await expect(retry()).resolves.toBe(false);
      expect(h.prompts).toHaveLength(1);
      expect(lines(h)[1]).toMatchObject({ reason: "turn-not-running", requestId: "req-1" });
    });

    it("keeps each run's ids apart", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await admitDelivery(h, "req-1")();
      const otherRun: PromptInputsRun = { ...h.run, runId: "run-2" };
      const second = createOpenCodePromptInputsRunPort({
        readyRun: (runId) => (runId === "run-2" ? otherRun : undefined),
        capabilities: NATIVE,
        activityLog: h.sink,
        recordPostFailure: () => undefined,
        mintMessageId: () => "msg_other_run",
      });
      const admitted = second.admitPromptInputs("run-2", { delivery: "queue", requestId: "req-1" });
      if (!admitted.ok) throw new Error("expected admission");
      await second.deliverPrompt("run-2", "also this", admitted.inputs);
      expect(sentIds(h)).toEqual(["msg_minted_1", "msg_other_run"]);
    });

    // PR #4064 review: a delivery whose acknowledgement was lost may already reside in the
    // producer, so its files count against the run's budget from the moment it is sent.
    describe("the run's attachment budget across uncertain deliveries", () => {
      const FULL = ["full-a.txt", "full-b.txt", "full-c.txt"];
      const PROMPT_BYTES = FULL.length * OPENCODE_PROMPT_FILE_MAX_BYTES;

      beforeEach(() => {
        for (const name of FULL) {
          writeFileSync(join(workspace, name), "x".repeat(OPENCODE_PROMPT_FILE_MAX_BYTES));
        }
      });

      const admitFull = (h: Harness, requestId: string): PromptInputsAdmission =>
        h.port.admitPromptInputs("run-1", {
          delivery: "queue",
          requestId,
          references: FULL.map((path) => ({ path })),
        });

      async function queueSix(h: Harness): Promise<boolean[]> {
        const admitted: boolean[] = [];
        for (let index = 1; index <= 6; index += 1) {
          const admission = admitFull(h, `req-${String(index)}`);
          admitted.push(admission.ok);
          if (admission.ok) await h.port.deliverPrompt("run-1", "queued", admission.inputs);
        }
        return admitted;
      }

      it("refuses the sixth prompt of three full files when every acknowledgement arrives", async () => {
        const h = harness();
        await expect(queueSix(h)).resolves.toEqual([true, true, true, true, true, false]);
        expect(h.run.promptFileBytes).toBe(5 * PROMPT_BYTES);
        expect(lines(h)[5]).toMatchObject({ outcome: "refused", reason: "references-run-budget" });
      });

      it("refuses the sixth too when every acknowledgement was lost", async () => {
        const h = harness();
        for (let index = 0; index < 6; index += 1) h.promptFailures.push(LOST);
        await expect(queueSix(h)).resolves.toEqual([true, true, true, true, true, false]);
        expect(h.prompts).toHaveLength(5);
        expect(h.run.promptFileBytes).toBe(5 * PROMPT_BYTES);
        expect(lines(h)).toMatchObject([
          ...Array.from({ length: 5 }, () => ({
            outcome: "refused",
            reason: "delivery-unconfirmed",
            reservedBytes: PROMPT_BYTES,
          })),
          { outcome: "refused", reason: "references-run-budget" },
        ]);
      });

      it("returns the reservation of a fresh message the producer refused, and charges its retry once", async () => {
        const h = harness();
        const admission = admitFull(h, "req-1");
        if (!admission.ok) throw new Error("expected admission");
        h.promptFailures.push(new OpenCodeV2HttpStatusError(409));
        await expect(h.port.deliverPrompt("run-1", "t", admission.inputs)).resolves.toBe(false);
        expect(h.run.promptFileBytes).toBe(0);
        expect(lines(h)[0]).toMatchObject({ reason: "delivery-refused", reservedBytes: 0 });
        await expect(h.port.deliverPrompt("run-1", "t", admission.inputs)).resolves.toBe(true);
        expect(h.run.promptFileBytes).toBe(PROMPT_BYTES);
      });

      it("keeps the reservation when a refusal answers a resent id the producer may hold", async () => {
        const h = harness();
        const admission = admitFull(h, "req-1");
        if (!admission.ok) throw new Error("expected admission");
        h.promptFailures.push(LOST, new OpenCodeV2HttpStatusError(409));
        await h.port.deliverPrompt("run-1", "t", admission.inputs);
        await expect(h.port.deliverPrompt("run-1", "t", admission.inputs)).resolves.toBe(false);
        expect(h.run.promptFileBytes).toBe(PROMPT_BYTES);
        expect(lines(h)[1]).toMatchObject({
          reason: "delivery-refused",
          inputBinding: "reused",
          reservedBytes: PROMPT_BYTES,
        });
      });

      it("refuses, unsent, a delivery whose files another admitted delivery already took", async () => {
        const h = harness();
        h.run.promptFileBytes = OPENCODE_PROMPT_RUN_FILES_MAX_BYTES - PROMPT_BYTES;
        const first = admitFull(h, "req-1");
        const second = admitFull(h, "req-2");
        if (!first.ok || !second.ok) throw new Error("expected both admissions");
        await expect(h.port.deliverPrompt("run-1", "one", first.inputs)).resolves.toBe(true);
        await expect(h.port.deliverPrompt("run-1", "two", second.inputs)).resolves.toBe(false);
        expect(h.prompts).toHaveLength(1);
        expect(h.run.promptFileBytes).toBe(OPENCODE_PROMPT_RUN_FILES_MAX_BYTES);
        expect(lines(h)[1]).toMatchObject({
          outcome: "refused",
          reason: "references-run-budget",
          requestId: "req-2",
        });
      });
    });

    // PR #4064 review: forgetting an unresolved id let a retry mint a second id, and the producer,
    // which may hold the first message, stored a second copy.
    it("keeps every unresolved id and refuses a new request while the ledger is full of them", async () => {
      const h = harness();
      for (let index = 0; index < OPENCODE_NATIVE_INPUT_LEDGER_MAX; index += 1) {
        h.promptFailures.push(LOST);
        await admitDelivery(h, `req-${String(index)}`)();
      }
      const before = h.prompts.length;
      await expect(admitDelivery(h, "req-new")()).resolves.toBe(false);
      expect(h.prompts, "nothing was sent for the new request").toHaveLength(before);
      expect(lines(h).at(-1)).toMatchObject({
        outcome: "refused",
        reason: "delivery-unresolved-limit",
        requestId: "req-new",
      });
      await expect(admitDelivery(h, "req-0")()).resolves.toBe(true);
      expect(sentIds(h)[before], "the oldest unresolved id is still resent").toBe("msg_minted_1");
      // Its acknowledgement resolved it, so its room now serves the new request.
      await expect(admitDelivery(h, "req-new")()).resolves.toBe(true);
      expect(sentIds(h)[before + 1]).toBe(
        `msg_minted_${String(OPENCODE_NATIVE_INPUT_LEDGER_MAX + 1)}`,
      );
    });

    it("forgets an acknowledged id before any unresolved one", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await admitDelivery(h, "req-pending")();
      for (let index = 0; index < OPENCODE_NATIVE_INPUT_LEDGER_MAX; index += 1) {
        await admitDelivery(h, `req-ok-${String(index)}`)();
      }
      const before = h.prompts.length;
      await admitDelivery(h, "req-pending")();
      expect(sentIds(h)[before]).toBe("msg_minted_1");
    });

    it("emits lines the registered operation accepts, with the request and the binding", async () => {
      const h = harness();
      h.promptFailures.push(LOST);
      await admitDelivery(h, "req-1")();
      await admitDelivery(h, "req-1")();
      await admitDelivery(h, "req-1", "another text")();
      for (const event of h.sink.events) {
        expect(activityLogEventWillBeRejected(event)).toBe(false);
      }
      expect(JSON.stringify(h.sink.events)).not.toMatch(/also this|another text|msg_minted/u);
    });

    describe("the operator's own text kept for the list of pending messages", () => {
      it("finds a delivered message by its native id and shows it as a one-line preview", async () => {
        const h = harness();
        await admitDelivery(h, "req-1", "  Use the\n\tnew   logger  ")();
        await admitDelivery(h, "req-2", "Second message")();

        expect(h.port.nativeInput("run-1", "msg_minted_1")).toEqual({
          preview: "Use the new logger",
          withdrawn: false,
        });
        expect(h.port.nativeInput("run-1", "msg_minted_2")).toEqual({
          preview: "Second message",
          withdrawn: false,
        });
      });

      it("knows nothing of an id it did not mint for the run, another run's id or a missing run", async () => {
        const h = harness();
        await admitDelivery(h, "req-1")();

        expect(h.port.nativeInput("run-1", "msg_from_the_runtime")).toBeUndefined();
        expect(h.port.nativeInput("run-1", "")).toBeUndefined();
        expect(h.port.nativeInput("run-2", "msg_minted_1")).toBeUndefined();
        expect(
          harness({ missing: true }).port.nativeInput("run-1", "msg_minted_1"),
        ).toBeUndefined();
      });

      it("keeps the first preview when the same request is retried with the same message", async () => {
        const h = harness();
        h.promptFailures.push(LOST);
        await admitDelivery(h, "req-1", "Same words")();
        await admitDelivery(h, "req-1", "Same words")();

        expect(h.port.nativeInput("run-1", "msg_minted_1")).toEqual({
          preview: "Same words",
          withdrawn: false,
        });
        expect(h.port.nativeInput("run-1", "msg_minted_2")).toBeUndefined();
      });

      it("keeps nothing for a message the producer itself refused: its id is forgotten", async () => {
        const h = harness();
        h.promptFailures.push(new OpenCodeV2HttpStatusError(400));
        await admitDelivery(h, "req-1", "Refused words")();

        expect(h.port.nativeInput("run-1", "msg_minted_1")).toBeUndefined();
      });

      it("records a withdrawal on the message, and on no other, and ignores an unknown id", async () => {
        const h = harness();
        await admitDelivery(h, "req-1")();
        await admitDelivery(h, "req-2")();

        h.port.withdrawNativeInput("run-1", "msg_minted_1");
        h.port.withdrawNativeInput("run-1", "msg_unknown");
        h.port.withdrawNativeInput("run-2", "msg_minted_2");

        expect(h.port.nativeInput("run-1", "msg_minted_1")).toMatchObject({ withdrawn: true });
        expect(h.port.nativeInput("run-1", "msg_minted_2")).toMatchObject({ withdrawn: false });
      });

      it("forgets the preview with the id once the ledger is full", async () => {
        const h = harness();
        for (let index = 0; index <= OPENCODE_NATIVE_INPUT_LEDGER_MAX; index += 1) {
          await admitDelivery(h, `req-${String(index)}`)();
        }

        expect(h.port.nativeInput("run-1", "msg_minted_1")).toBeUndefined();
        expect(
          h.port.nativeInput("run-1", `msg_minted_${String(OPENCODE_NATIVE_INPUT_LEDGER_MAX + 1)}`),
        ).toBeDefined();
      });
    });
  });
});

describe("the one-line preview of a delivered message", () => {
  const limit = CODING_WORKBENCH_RUNTIME_INBOX_PREVIEW_MAX_CHARS;
  const accepted = (preview: string): boolean =>
    validateCodingWorkbenchRuntimeInboxChannelPayload({
      session: "active",
      items: [{ itemId: "msg_a", delivery: "queue", preview }],
    }).ok;

  it("collapses every run of whitespace and trims the ends", () => {
    expect(nativeInputPreview("  first\r\n\tsecond \u00a0 third\n")).toBe("first second third");
    expect(nativeInputPreview("")).toBe("");
    expect(nativeInputPreview(" \n\t ")).toBe("");
  });

  it("removes invisible and text-reordering code points and control characters", () => {
    const hostile = "safe\u202egnp.exe\u200b\u2066hidden\u0000\u0007 text\u2028next\ufeff";

    const preview = nativeInputPreview(hostile);

    expect(preview).toBe("safegnp.exehidden textnext");
    expect(accepted(preview)).toBe(true);
  });

  it("keeps a text of exactly the bound whole and cuts a longer one with an ellipsis within it", () => {
    const exact = "a".repeat(limit);
    const longer = `${"word ".repeat(limit)}tail`;

    expect(nativeInputPreview(exact)).toBe(exact);
    const cut = nativeInputPreview(longer);
    expect(cut.length).toBeLessThanOrEqual(limit);
    expect(cut.endsWith("\u2026")).toBe(true);
    expect(cut).not.toContain("tail");
    expect(accepted(cut)).toBe(true);
  });

  it("never splits a surrogate pair at the cut", () => {
    const emoji = "\u{1F600}";
    const cut = nativeInputPreview(emoji.repeat(limit));

    expect(cut.length).toBeLessThanOrEqual(limit);
    expect(cut.endsWith("\u2026")).toBe(true);
    expect(cut.slice(0, -1).replaceAll(emoji, "")).toBe("");
    expect(accepted(cut)).toBe(true);
  });

  it("is always something the contract's display validation accepts", () => {
    for (const text of [
      "plain",
      "ünïcode 名前",
      "a\u200db",
      "tabs\tand\nlines",
      "x".repeat(5000),
    ]) {
      expect(accepted(nativeInputPreview(text)), text.slice(0, 20)).toBe(true);
    }
  });
});
