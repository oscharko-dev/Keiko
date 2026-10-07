import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  existsSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerLogEvent } from "@oscharko-dev/keiko-activity-log";
import type { EditorAgentAction, WorkspaceInfo } from "@oscharko-dev/keiko-contracts";
import { EDITOR_AGENT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import { applyPatch } from "@oscharko-dev/keiko-tools";

import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../../tests/support/activity-log-proof.js";
import { createCodingToolReadEditPorts } from "./codingToolReadEditPorts.js";
import { EMPTY_CONTENT_SHA256 } from "./codingToolReplacementEdits.js";
import {
  createSecureWorkspaceTextReadPort,
  secureWorkspaceTextDigest,
} from "./secureWorkspaceTextRead.js";
import type { SecureWorkspaceTextReadArtifact } from "./secureWorkspaceTextReadArtifact.js";
import {
  SECURE_WORKSPACE_TEXT_READ_MAX_BYTES,
  decodeSecureWorkspaceReadRequest,
  decodeSecureWorkspaceText,
  encodeSecureWorkspaceReadResponse,
  type SecureWorkspaceReadHelperResponse,
} from "./secureWorkspaceTextReadProtocol.js";

// F27 (#3876), live run `run-239576713111602440078422494491005945472` on 2e830ff7a: the model
// created a new test file with `keiko_changeset_edit` (an empty `oldString`, the empty-content
// digest) and the edit was refused six times as `EDIT_PREPARE_FAILED` with
// `prepareCause=replacement-read-failed readReason=denied`, because the materialization read of a
// path that did not exist answered `denied`: the native helper has no not-found status and the
// wrapper mapped its `access-denied` straight through. No live run had ever created a file.
//
// Every test below composes the REAL governed read, the REAL secure-read wrapper and the REAL patch
// engine over a real temporary workspace. Only the native helper is emulated, and it answers what
// the compiled helper answers (checked against a helper built from native/secure-workspace-read):
// `access-denied` for every path it cannot open, a missing one included. A reader stub that answers
// `not-found` for a missing path models a port production never was, which is how the defect
// survived its unit tests.

const DIGEST = "a".repeat(64);
const RUN_ID = "run-file-creation";
const SESSION_ID = "session-file-creation";
const NEW_FILE = "src/cli.test.ts";
const NEW_TEXT = 'import { it } from "vitest";\n\nit("runs", () => undefined);\n';
const EXISTING_TEXT = "export const cli = 1;\n";

const artifact: SecureWorkspaceTextReadArtifact = {
  target: "darwin-arm64",
  installRelativePath: "runtime/native/keiko-secure-workspace-read",
  sha256: "a".repeat(64),
  protocol: "KSR1/KSS1",
  sourceCommit: "b".repeat(40),
  sourceTreeSha256: "c".repeat(64),
  signed: true,
};

const liveBinding = {
  runId: RUN_ID,
  envelopeDigest: DIGEST,
  workspaceId: "workspace-file-creation",
  workspaceRootDigest: DIGEST,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

// The compiled helper opens the root and every component with O_NOFOLLOW and answers
// KSR_ACCESS_DENIED for any open that fails: missing, a link, a file used as a directory.
function openedParent(root: string, directories: readonly string[]): string | undefined {
  if (lstatOrUndefined(root)?.isDirectory() !== true) return undefined;
  let current = root;
  for (const directory of directories) {
    current = join(current, directory);
    if (lstatOrUndefined(current)?.isDirectory() !== true) return undefined;
  }
  return current;
}

function fileAnswer(file: string): SecureWorkspaceReadHelperResponse {
  const stat = lstatOrUndefined(file);
  if (stat === undefined || stat.isSymbolicLink()) return { status: "access-denied" };
  if (!stat.isFile() || stat.nlink !== 1) return { status: "not-regular" };
  if (stat.size > SECURE_WORKSPACE_TEXT_READ_MAX_BYTES) return { status: "content-too-large" };
  const bytes = readFileSync(file);
  return decodeSecureWorkspaceText(bytes).ok
    ? { status: "ok", bytes }
    : { status: "content-not-text" };
}

function helperAnswer(root: string, relativePath: string): SecureWorkspaceReadHelperResponse {
  const components = relativePath.split("/");
  const parent = openedParent(root, components.slice(0, -1));
  if (parent === undefined) return { status: "access-denied" };
  return fileAnswer(join(parent, components.at(-1) ?? ""));
}

function nativeHelper(stdin: Uint8Array): Uint8Array {
  const { root, relativePath } = decodeSecureWorkspaceReadRequest(stdin);
  return encodeSecureWorkspaceReadResponse(helperAnswer(root, relativePath));
}

function workspaceInfo(root: string): WorkspaceInfo {
  return {
    root,
    selectedRoot: root,
    name: undefined,
    version: undefined,
    testFramework: "unknown",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
}

describe("file creation through the governed edit path (F27)", () => {
  const bases: string[] = [];

  afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  function workspace(): { readonly root: string; readonly outside: string } {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "keiko-file-creation-")));
    bases.push(base);
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "src", "cli.ts"), EXISTING_TEXT);
    return { root, outside };
  }

  interface Harness {
    readonly ports: ReturnType<typeof createCodingToolReadEditPorts>;
    readonly events: ServerLogEvent[];
    readonly actions: EditorAgentAction[];
  }

  function harness(root: string): Harness {
    const events: ServerLogEvent[] = [];
    const actions: EditorAgentAction[] = [];
    const ports = createCodingToolReadEditPorts({
      secureWorkspaceTextRead: createSecureWorkspaceTextReadPort({
        resolveWorkspaceRoot: () => root,
        artifact,
        artifactVerifier: { verify: () => true },
        processFactory: {
          create: () => ({
            run: ({ stdin }): Promise<Uint8Array> => Promise.resolve(nativeHelper(stdin)),
          }),
        },
        platform: { os: "darwin", arch: "arm64" },
      }),
      resolveRepositoryReadContext: () => liveBinding,
      editorAgentClient: {
        action: (action) => {
          actions.push(action);
          return Promise.resolve({
            ok: true as const,
            value: {
              result: {
                schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
                actionId: action.actionId,
                sessionId: SESSION_ID,
                status: "queued" as const,
              },
            },
          });
        },
      },
      resolveEditorActionContext: () => ({
        sessionId: SESSION_ID,
        authorityRef: { runId: RUN_ID, envelopeDigest: DIGEST },
        origin: "agent",
        workspaceId: liveBinding.workspaceId,
        workspaceRootDigest: liveBinding.workspaceRootDigest,
        expiresAt: liveBinding.expiresAt,
      }),
      requiresEditorReview: () => true,
      mutationLeaseCoordinator: {
        register: () => true,
        discard: () => true,
        waitForMutation: () => Promise.resolve("succeeded"),
      },
      activityLog: { write: (event): void => void events.push(event) },
    });
    return { ports, events, actions };
  }

  type EditChangeset = Parameters<
    ReturnType<typeof createCodingToolReadEditPorts>["editorChangeset"]["execute"]
  >[0]["changeset"];

  function edit(
    ports: Harness["ports"],
    changeset: EditChangeset,
  ): ReturnType<Harness["ports"]["editorChangeset"]["execute"]> {
    return ports.editorChangeset.execute(
      { action: "edit", actionId: "edit-1", idempotencyKey: "edit-1-key", changeset },
      undefined,
      { check: (): true => true, binding: liveBinding },
    );
  }

  function creation(file: string, text: string): EditChangeset {
    return {
      edits: [{ file, oldString: "", newString: text }],
      files: [{ file, expectedContentHash: EMPTY_CONTENT_SHA256 }],
    };
  }

  function applyDispatched(root: string, actions: readonly EditorAgentAction[]): void {
    const dispatched = actions[0];
    if (dispatched?.type !== "applyChangeset" || dispatched.changeset === undefined) {
      throw new Error("expected one dispatched applyChangeset action");
    }
    applyPatch(workspaceInfo(root), dispatched.changeset.patch, {
      applyEnabled: true,
      signal: new AbortController().signal,
    });
  }

  function readLines(events: readonly ServerLogEvent[]): readonly ServerLogEvent[] {
    return events.filter((event) => event.op === "coding-runtime.workspace-read");
  }

  it("creates the file the live run could not: an empty oldString on a path that is not there", async () => {
    const { root } = workspace();
    const { ports, events, actions } = harness(root);

    await expect(edit(ports, creation(NEW_FILE, NEW_TEXT))).resolves.toEqual({
      status: "completed",
    });

    expect(actions).toHaveLength(1);
    expect(existsSync(join(root, NEW_FILE))).toBe(false);
    applyDispatched(root, actions);
    expect(readFileSync(join(root, NEW_FILE), "utf8")).toBe(NEW_TEXT);
    expect(secureWorkspaceTextDigest(readFileSync(join(root, NEW_FILE), "utf8"))).toBe(
      secureWorkspaceTextDigest(NEW_TEXT),
    );

    // The precondition is on the timeline as an absent file, under the run's correlation id, with
    // the digest of the path and nothing else about it; no failed read and no refusal line exist.
    const reads = readLines(events);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      correlationId: RUN_ID,
      extra: { state: "absent", purpose: "edit-materialization" },
    });
    expect(reads[0]?.errorKind).toBeUndefined();
    expect(reads[0]?.extra).not.toHaveProperty("reason");
    expect(events.some((event) => event.op === "coding-runtime.edit.refused")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("cli.test.ts");
    const persisted = expectActivityLogProof(
      "coding-runtime.workspace-read.emitted-line",
      formatActivityLogProofLine(reads[0] ?? {}),
    );
    expect(persisted).toMatchObject({ state: "absent", purpose: "edit-materialization" });
    expect(persisted).not.toHaveProperty("reason");
  });

  it("creates a file below directories that do not exist yet", async () => {
    const { root } = workspace();
    const { ports, actions } = harness(root);
    const nested = "src/generated/deep/cli.test.ts";

    await expect(edit(ports, creation(nested, NEW_TEXT))).resolves.toEqual({
      status: "completed",
    });

    applyDispatched(root, actions);
    expect(readFileSync(join(root, nested), "utf8")).toBe(NEW_TEXT);
  });

  it("moves a file to a path that is not there: the rename target is absent, not denied", async () => {
    const { root } = workspace();
    const { ports, events, actions } = harness(root);

    await expect(
      edit(ports, {
        edits: [],
        renames: [{ from: "src/cli.ts", to: "src/main.ts" }],
        files: [
          { file: "src/cli.ts", expectedContentHash: secureWorkspaceTextDigest(EXISTING_TEXT) },
          { file: "src/main.ts", expectedContentHash: EMPTY_CONTENT_SHA256 },
        ],
      }),
    ).resolves.toEqual({ status: "completed" });

    applyDispatched(root, actions);
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toBe(EXISTING_TEXT);
    expect(existsSync(join(root, "src/cli.ts"))).toBe(false);
    expect(readLines(events).map((event) => event.extra?.state)).toEqual(["completed", "absent"]);
  });

  it("refuses to create over a file that has content, and reads it as present", async () => {
    const { root } = workspace();
    const { ports, actions } = harness(root);

    await expect(
      edit(ports, {
        edits: [{ file: "src/cli.ts", oldString: "", newString: NEW_TEXT }],
        files: [{ file: "src/cli.ts", expectedContentHash: EMPTY_CONTENT_SHA256 }],
      }),
    ).resolves.toMatchObject({ status: "failed" });
    // The read found the file, so the creation's empty-content precondition cannot hold: refused
    // before any editor action exists, and the file is untouched.
    expect(actions).toHaveLength(0);
    expect(readFileSync(join(root, "src/cli.ts"), "utf8")).toBe(EXISTING_TEXT);
  });

  it("refuses to create a policy-denied file, whether or not it exists", async () => {
    const { root } = workspace();
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    const { ports, events, actions } = harness(root);

    for (const file of [".env", ".env.production", ".git/hooks/pre-commit"]) {
      await expect(edit(ports, creation(file, "SECRET=2\n"))).resolves.toMatchObject({
        status: "failed",
        reasonCode: "EDIT_PREPARE_FAILED",
        prepareCause: "replacement-read-failed",
        readReason: "preflight-refused",
      });
    }

    expect(actions).toHaveLength(0);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(existsSync(join(root, ".env.production"))).toBe(false);
    // The two outcomes are the same line, so the deny list cannot be used to probe what exists.
    expect(readLines(events).map((event) => event.extra?.reason)).toEqual([
      "preflight-refused",
      "preflight-refused",
      "preflight-refused",
    ]);
  });

  it("refuses to create through a symlinked directory and never writes beyond the workspace", async () => {
    const { root, outside } = workspace();
    symlinkSync(outside, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const { ports, events, actions } = harness(root);

    await expect(edit(ports, creation("link/cli.test.ts", NEW_TEXT))).resolves.toMatchObject({
      status: "failed",
      reasonCode: "EDIT_PREPARE_FAILED",
      prepareCause: "replacement-read-failed",
      readReason: "denied",
    });

    expect(actions).toHaveLength(0);
    expect(existsSync(join(outside, "cli.test.ts"))).toBe(false);
    expect(readLines(events)[0]).toMatchObject({
      level: "warn",
      errorKind: "authority-denied",
      extra: { state: "failed", purpose: "edit-materialization", reason: "denied" },
    });
  });

  it("tells the model a path it asked to read is not there, not that it is denied", async () => {
    const { root } = workspace();
    const { ports, events } = harness(root);

    await expect(
      ports.repositoryRead.execute(
        {
          action: "read",
          actionId: "read-1",
          idempotencyKey: "read-1-key",
          relativePath: "src/missing.ts",
        },
        undefined,
        { check: (): true => true, binding: liveBinding },
      ),
    ).resolves.toEqual({ status: "failed", reasonCode: "workspace-read-not-found" });

    expect(readLines(events)[0]).toMatchObject({
      level: "warn",
      errorKind: "unavailable",
      extra: { state: "failed", purpose: "tool-result", reason: "not-found" },
    });
  });
});
