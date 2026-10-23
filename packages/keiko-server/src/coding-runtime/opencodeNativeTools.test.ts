import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  isAdmissibleOpenCodeToolName,
  isAdmittedOpenCodeNativeToolContract,
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
      "todo",
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
