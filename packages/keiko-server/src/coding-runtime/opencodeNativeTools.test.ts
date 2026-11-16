import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isAdmissibleOpenCodeToolName,
  isAdmittedOpenCodeNativeToolContract,
  isOpenCodeToolExecutionFailure,
  isOpenCodeNativeToolName,
  openCodeNativeToolSetDigest,
  openCodeToolLogLabel,
  OPENCODE_NATIVE_PERMISSION_ACTIONS,
  OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS,
  OPENCODE_NATIVE_TOOL_DEFINITIONS,
  OPENCODE_NATIVE_TOOL_NAMES,
} from "./opencodeNativeTools.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";

interface NativeToolFixture {
  readonly producer: { readonly version: string };
  readonly tools: readonly {
    readonly id: string;
    readonly action: string;
    readonly codemode: boolean;
  }[];
  readonly permissionActions: readonly string[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      `./opencodeNativeTools.opencode-${OPENCODE_PINNED_VERSION}.fixture.json`,
      import.meta.url,
    ),
    "utf8",
  ),
) as NativeToolFixture;

describe("native tool inventory", () => {
  it("is the producer-derived capture of the pinned runtime", () => {
    expect(fixture.producer.version).toBe(OPENCODE_PINNED_VERSION);
    expect(OPENCODE_NATIVE_TOOL_DEFINITIONS).toEqual(fixture.tools);
    expect(OPENCODE_NATIVE_PERMISSION_ACTIONS).toEqual(fixture.permissionActions);
    expect(OPENCODE_NATIVE_TOOL_NAMES).toEqual([
      "read",
      "glob",
      "grep",
      "edit",
      "write",
      "patch",
      "shell",
      "webfetch",
      "websearch",
      "skill",
      "subagent",
      "question",
      "todowrite",
    ]);
  });

  it("classifies native, extension and inadmissible tool names body-free", () => {
    expect(isOpenCodeNativeToolName("edit")).toBe(true);
    expect(isOpenCodeNativeToolName("opencode_worktree_list")).toBe(true);
    expect(isOpenCodeNativeToolName("keiko_changeset_edit")).toBe(false);
    expect(isAdmissibleOpenCodeToolName("github_create_issue")).toBe(true);
    expect(isAdmissibleOpenCodeToolName("../escape")).toBe(false);
    expect(isAdmissibleOpenCodeToolName("has space")).toBe(false);
    expect(isAdmissibleOpenCodeToolName("")).toBe(false);
    expect(isAdmissibleOpenCodeToolName("x".repeat(65))).toBe(false);
    expect(openCodeToolLogLabel("shell")).toBe("shell");
    expect(openCodeToolLogLabel("github_create_issue")).toBe("extension");
  });
});

// OpenCode 2.1.4 Code Mode returns a program's uncaught exception, including one thrown by a nested
// `tools.opencode.*` call, as a COMPLETED `execute` part whose `metadata.error` is `true` (#3897).
describe("Code Mode execution failure predicate", () => {
  const completed = (metadata?: unknown): Record<string, unknown> => ({
    status: "completed",
    ...(metadata === undefined ? {} : { metadata }),
  });

  it("marks only a completed execute part with the boolean metadata.error true", () => {
    expect(isOpenCodeToolExecutionFailure("execute", completed({ error: true }))).toBe(true);
    expect(isOpenCodeToolExecutionFailure("execute", completed({ error: false }))).toBe(false);
    expect(isOpenCodeToolExecutionFailure("execute", completed({}))).toBe(false);
    expect(isOpenCodeToolExecutionFailure("execute", completed())).toBe(false);
  });

  it.each(["true", 1, {}, [true], null, undefined, "PRIVATE"])(
    "ignores a non-boolean error value %j",
    (error) => {
      expect(isOpenCodeToolExecutionFailure("execute", completed({ error }))).toBe(false);
    },
  );

  it.each([
    ["a non-zero exit", { exit: 3 }],
    ["a timeout with no exit status", { timeout: true, truncated: false }],
    ["a kill by signal with no exit status", { signal: "SIGKILL", truncated: false }],
    ["a timeout with an exit status of zero", { timeout: true, exit: 0 }],
  ])("marks a completed shell part with %s as failed (#4271)", (_name, metadata) => {
    expect(isOpenCodeToolExecutionFailure("shell", completed(metadata))).toBe(true);
  });

  it.each([
    ["an exit status of zero", { exit: 0, truncated: false }],
    ["a job moved to the background", { status: "running", shellID: "s", truncated: false }],
    ["no metadata fields", {}],
    ["a false timeout", { timeout: false, exit: 0 }],
    ["a non-string signal", { signal: 9 }],
    ["a non-numeric exit", { exit: "1" }],
    ["a fractional exit", { exit: 1.5 }],
  ])("does not mark a completed shell part with %s as failed", (_name, metadata) => {
    expect(isOpenCodeToolExecutionFailure("shell", completed(metadata))).toBe(false);
  });

  it("does not read one tool's failure field for another", () => {
    expect(isOpenCodeToolExecutionFailure("shell", completed({ error: true }))).toBe(false);
    expect(isOpenCodeToolExecutionFailure("execute", completed({ exit: 1 }))).toBe(false);
    expect(isOpenCodeToolExecutionFailure("read", completed({ timeout: true }))).toBe(false);
  });

  it("ignores another tool, another status and a malformed state or metadata", () => {
    expect(isOpenCodeToolExecutionFailure("read", completed({ error: true }))).toBe(false);
    expect(isOpenCodeToolExecutionFailure(undefined, completed({ error: true }))).toBe(false);
    for (const status of ["running", "error", "streaming", undefined, true]) {
      expect(isOpenCodeToolExecutionFailure("execute", { status, metadata: { error: true } })).toBe(
        false,
      );
    }
    for (const state of [undefined, null, "completed", [], 7]) {
      expect(isOpenCodeToolExecutionFailure("execute", state)).toBe(false);
    }
    for (const metadata of [true, "error", [{ error: true }], null]) {
      expect(isOpenCodeToolExecutionFailure("execute", completed(metadata))).toBe(false);
    }
  });
});

describe("native tool contract admission", () => {
  const tool = (
    name: string,
    parameters: Record<string, unknown> = { type: "object" },
  ): {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  } => ({
    name,
    description: "",
    parameters,
  });

  it("admits a bounded advertisement and refuses every bound violation", () => {
    const admitted = [tool("read"), tool("edit"), tool("github_create_issue")];
    expect(isAdmittedOpenCodeNativeToolContract(admitted)).toBe(true);
    expect(isAdmittedOpenCodeNativeToolContract(undefined)).toBe(false);
    expect(isAdmittedOpenCodeNativeToolContract([])).toBe(false);
    expect(isAdmittedOpenCodeNativeToolContract([tool("read"), tool("read")])).toBe(false);
    expect(isAdmittedOpenCodeNativeToolContract([tool("not valid")])).toBe(false);
    expect(
      isAdmittedOpenCodeNativeToolContract(
        Array.from({ length: OPENCODE_NATIVE_TOOL_CONTRACT_MAX_TOOLS + 1 }, (_, index) =>
          tool(`tool_${String(index)}`),
        ),
      ),
    ).toBe(false);
    expect(
      isAdmittedOpenCodeNativeToolContract([
        tool("read", { type: "object", description: "x".repeat(64 * 1024 + 1) }),
      ]),
    ).toBe(false);
  });

  it("digests the name set independently of order and never of schemas", () => {
    const a = openCodeNativeToolSetDigest([tool("read"), tool("edit", { type: "object", x: 1 })]);
    const b = openCodeNativeToolSetDigest([tool("edit"), tool("read")]);
    expect(a).toBe(b);
    expect(a).not.toBe(openCodeNativeToolSetDigest([tool("read")]));
  });
});
