import { describe, expect, it } from "vitest";

import { codingToolRequiredActionClasses, parseCodingToolRequest } from "./codingToolIpc.js";

const changeset = {
  patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-old\n+new\n",
  files: [{ file: "src/a.ts", expectedContentHash: "a".repeat(64) }],
};

describe("coding tool IPC exact changesets", () => {
  it("rejects unknown nested changeset keys before an edit reaches a producer", () => {
    const body = JSON.stringify({
      action: "edit",
      actionId: "edit-1",
      idempotencyKey: "edit-key",
      changeset: { ...changeset, untrusted: "SENTINEL_UNKNOWN_KEY" },
    });

    expect(parseCodingToolRequest(body, 262_144)).toBeUndefined();
  });
});

describe("coding tool IPC authority effects", () => {
  it("requires workspace-write for both proposing and redeeming a stage operation", () => {
    const base = {
      action: "git",
      operation: "stage",
      actionId: "stage-1",
      paths: ["src/a.ts"],
    } as const;
    expect(
      codingToolRequiredActionClasses({
        ...base,
        idempotencyKey: "stage-propose",
        phase: "propose",
      }),
    ).toEqual(["workspace-write"]);
    expect(
      codingToolRequiredActionClasses({
        ...base,
        idempotencyKey: "stage-execute",
        phase: "execute",
        proposalId: "stage-1",
      }),
    ).toEqual(["workspace-write"]);
  });
});

describe("coding tool IPC read windows (#2473)", () => {
  const read = {
    action: "read",
    actionId: "read-1",
    idempotencyKey: "read-key",
    relativePath: "src/a.ts",
  };

  it("admits a windowless read and bounded optional window parameters unchanged", () => {
    expect(parseCodingToolRequest(JSON.stringify(read), 262_144)).toEqual(read);
    const windowed = { ...read, startLine: 120, maxLines: 200 };
    expect(parseCodingToolRequest(JSON.stringify(windowed), 262_144)).toEqual(windowed);
  });

  it.each([
    ["a Windows drive-qualified path", { relativePath: "C:/Users/evil.txt" }],
    ["an NTFS alternate-data-stream path", { relativePath: "note.txt:ads" }],
    ["a zero startLine", { startLine: 0 }],
    ["a negative startLine", { startLine: -3 }],
    ["a fractional startLine", { startLine: 1.5 }],
    ["a string startLine", { startLine: "2" }],
    ["an oversized startLine", { startLine: 1_000_001 }],
    ["a zero maxLines", { maxLines: 0 }],
    ["an oversized maxLines", { maxLines: 5_001 }],
    ["a null maxLines", { maxLines: null }],
    ["an unknown window key", { endLine: 9 }],
  ])("rejects %s instead of silently widening the read", (_name, extra) => {
    expect(parseCodingToolRequest(JSON.stringify({ ...read, ...extra }), 262_144)).toBeUndefined();
  });
});

describe("coding tool IPC repository discovery", () => {
  const discover = {
    action: "discover",
    actionId: "discover-1",
    idempotencyKey: "discover-key",
    query: "safeActivity",
    maxResults: 20,
  };

  it("admits only an exact bounded discovery request", () => {
    expect(parseCodingToolRequest(JSON.stringify(discover), 262_144)).toEqual(discover);
    expect(
      parseCodingToolRequest(
        JSON.stringify({ ...discover, query: "ä".repeat(128), maxResults: 100 }),
        262_144,
      ),
    ).toEqual({ ...discover, query: "ä".repeat(128), maxResults: 100 });
    for (const invalid of [
      { query: "" },
      { query: "ä".repeat(129) },
      { maxResults: 0 },
      { maxResults: -1 },
      { maxResults: 1.5 },
      { maxResults: "20" },
    ]) {
      expect(
        parseCodingToolRequest(JSON.stringify({ ...discover, ...invalid }), 262_144),
      ).toBeUndefined();
    }
    expect(
      parseCodingToolRequest(JSON.stringify({ ...discover, maxResults: 101 }), 262_144),
    ).toBeUndefined();
    expect(
      parseCodingToolRequest(JSON.stringify({ ...discover, workspaceRoot: "/private" }), 262_144),
    ).toBeUndefined();
  });
});

describe("coding tool IPC repository search (#3386 H1)", () => {
  const search = {
    action: "search",
    actionId: "search-1",
    idempotencyKey: "search-key",
    repositoryRequest: {
      kind: "search",
      mode: "literal",
      query: "parseConfig",
      caseSensitive: false,
      includeGlobs: [],
      excludeGlobs: [],
      maxResults: 50,
    },
  };
  const read = {
    action: "search",
    actionId: "search-2",
    idempotencyKey: "search-key-2",
    repositoryRequest: {
      kind: "read",
      path: "src/a.ts",
      startLine: 1,
      endLine: 10,
      maxBytes: 4096,
    },
  };

  it("admits an exact search request and an exact ranged-read handoff, never restating the contract's limits", () => {
    expect(parseCodingToolRequest(JSON.stringify(search), 262_144)).toEqual(search);
    expect(parseCodingToolRequest(JSON.stringify(read), 262_144)).toEqual(read);
  });

  it("rejects a query beyond the contract's own bound instead of a locally restated one", () => {
    const oversized = {
      ...search,
      repositoryRequest: { ...search.repositoryRequest, query: "q".repeat(201) },
    };
    expect(parseCodingToolRequest(JSON.stringify(oversized), 262_144)).toBeUndefined();
  });

  it.each([
    ["an unknown envelope key", { workspaceRoot: "/private" }],
    ["a missing repositoryRequest", { repositoryRequest: undefined }],
    [
      "an unknown nested repository-request key",
      { repositoryRequest: { ...search.repositoryRequest, untrusted: "x" } },
    ],
    [
      "a non-relative read path",
      { repositoryRequest: { ...read.repositoryRequest, path: "/etc/passwd" } },
    ],
    [
      "an oversized maxResults beyond the contract's returned-hits limit",
      { repositoryRequest: { ...search.repositoryRequest, maxResults: 51 } },
    ],
  ])("rejects %s before a search request exists", (_name, extra) => {
    expect(
      parseCodingToolRequest(JSON.stringify({ ...search, ...extra }), 262_144),
    ).toBeUndefined();
  });
});

describe("coding tool IPC auxiliary requests", () => {
  it("admits only model-safe skill fields", () => {
    const body = {
      action: "skill",
      actionId: "skill-1",
      idempotencyKey: "skill-key",
      skillId: "skl_repo-structure-summary@1",
    };
    expect(parseCodingToolRequest(JSON.stringify(body), 262_144)).toEqual(body);
    expect(
      parseCodingToolRequest(JSON.stringify({ ...body, invocation: "explicit" }), 262_144),
    ).toBeUndefined();
  });

  it("clamps child input and rejects model-supplied authority", () => {
    const body = {
      action: "child-agent",
      actionId: "child-1",
      idempotencyKey: "child-key",
      objective: "Inspect repository structure",
      maxToolCalls: 4,
    };
    expect(parseCodingToolRequest(JSON.stringify(body), 262_144)).toEqual(body);
    expect(
      parseCodingToolRequest(JSON.stringify({ ...body, childRunId: "chr_model" }), 262_144),
    ).toBeUndefined();
    expect(
      parseCodingToolRequest(JSON.stringify({ ...body, maxToolCalls: 33 }), 262_144),
    ).toBeUndefined();
  });
});

describe("coding tool IPC approval proofs", () => {
  const proof = { approvalId: "call-1", approvalDigest: "b".repeat(64) };

  it.each([
    { action: "command", commandId: "typecheck" },
    { action: "verification", verifierId: "typecheck" },
    // 3941816393: a "git ci" observation and a generic "connector" read redeem a Workbench-issued
    // approval through the exact same wire shape as command/verification.
    { action: "git", operation: "ci" },
    { action: "connector", scope: "issue-tracker.write" },
  ] as const)("admits an exact $action proof and preserves its action binding", (action) => {
    const request = {
      ...action,
      actionId: "call-1",
      idempotencyKey: "call-1",
      approvalProof: proof,
    };
    expect(parseCodingToolRequest(JSON.stringify(request), 262_144)).toEqual(request);
  });

  it("rejects an invalid proof on a git ci observation before the request exists", () => {
    expect(
      parseCodingToolRequest(
        JSON.stringify({
          action: "git",
          operation: "ci",
          actionId: "call-1",
          idempotencyKey: "call-1",
          approvalProof: { ...proof, approvalDigest: "not-a-digest" },
        }),
        262_144,
      ),
    ).toBeUndefined();
  });

  it("rejects an invalid proof on a connector request before the request exists", () => {
    expect(
      parseCodingToolRequest(
        JSON.stringify({
          action: "connector",
          scope: "issue-tracker.write",
          actionId: "call-1",
          idempotencyKey: "call-1",
          approvalProof: { ...proof, approvalId: "" },
        }),
        262_144,
      ),
    ).toBeUndefined();
  });

  it("still admits an egress request with no approvalProof field defined", () => {
    // #3941816393: egress deliberately never gained an approvalProof (only connector did) --
    // pinned so a future shared refactor of simpleNamedRequest cannot silently widen it.
    const request = {
      action: "egress",
      target: "https://example.test",
      actionId: "e-1",
      idempotencyKey: "e-1",
    };
    expect(parseCodingToolRequest(JSON.stringify(request), 262_144)).toEqual(request);
    expect(
      parseCodingToolRequest(JSON.stringify({ ...request, approvalProof: proof }), 262_144),
    ).toBeUndefined();
  });

  it.each([
    ["an unknown proof key", { ...proof, authority: "model-supplied" }],
    ["an empty approval id", { ...proof, approvalId: "" }],
    ["a malformed digest", { ...proof, approvalDigest: "not-a-digest" }],
  ])("rejects %s", (_label, approvalProof) => {
    expect(
      parseCodingToolRequest(
        JSON.stringify({
          action: "verification",
          actionId: "call-1",
          idempotencyKey: "call-1",
          verifierId: "typecheck",
          approvalProof,
        }),
        262_144,
      ),
    ).toBeUndefined();
  });
});

describe("coding tool IPC targeted verification", () => {
  const request = {
    action: "verification" as const,
    actionId: "targeted-1",
    idempotencyKey: "targeted-1",
    verifierId: "targeted-test",
  };

  it("carries one bounded contained target into the governed verification request", () => {
    expect(
      parseCodingToolRequest(
        JSON.stringify({ ...request, targetPath: "src/math.test.ts" }),
        262_144,
      ),
    ).toEqual({ ...request, targetPath: "src/math.test.ts" });
  });

  it.each([undefined, "/tmp/x.test.ts", "../x.test.ts", ".env", "secrets/.env"])(
    "rejects missing, escaping, absolute, or sensitive target %s",
    (targetPath) => {
      expect(
        parseCodingToolRequest(JSON.stringify({ ...request, targetPath }), 262_144),
      ).toBeUndefined();
    },
  );

  it("rejects a targetPath on a non-targeted verifier", () => {
    expect(
      parseCodingToolRequest(
        JSON.stringify({ ...request, verifierId: "test", targetPath: "src/math.test.ts" }),
        262_144,
      ),
    ).toBeUndefined();
  });
});

/**
 * Where the shipped OpenCode runtime's edit containment actually lives.
 *
 * `decideSupervisedFileEdit` (supervisedCodingPolicy) also performs a realpath containment check,
 * but it is reached only from `supervisedCodingRuntimeEvent`, which requires a permission ask in
 * `supervised-coding` mode — and the generated child source asks for EDIT permission only when its
 * captured mode is `governed-assist` (opencodeRuntimeAdapter's explicit mode/action branch). For
 * the bundled OpenCode child that branch therefore never runs. The containment the edit
 * path really depends on is (1) THIS parse boundary and (2) the `keiko-tools` contained writer's
 * `assertContained` / `assertNoSymlink` / realpath-parent checks at the effect edge.
 *
 * These cases pin layer (1) explicitly. Note the deliberate scope: the changeset file predicate
 * (`isContainedAgentPath`) is NARROWER than the read path's `normalizedRelativePath` in this
 * same module — it does not reject `~`-anchored, UNC, colon-bearing or empty-segment paths,
 * which the read path does. Those shapes are contained at layer (2) instead, so this pin asserts
 * only what layer (1) genuinely guarantees; asserting more here would be a fixture that lies about
 * the code. If layer (1) is ever narrowed, the edit path is left standing on layer (2) alone.
 */
describe("coding tool IPC edit containment is the live workspace-escape gate", () => {
  function editBody(file: string): string {
    return JSON.stringify({
      action: "edit",
      actionId: "edit-1",
      idempotencyKey: "edit-key",
      changeset: {
        patch: "--- a/x\n+++ b/x\n@@\n-old\n+new\n",
        files: [{ file, expectedContentHash: "a".repeat(64) }],
      },
    });
  }

  it("admits a contained relative changeset file", () => {
    expect(parseCodingToolRequest(editBody("src/a.ts"), 262_144)).toMatchObject({
      action: "edit",
    });
  });

  it.each([
    ["a POSIX absolute path", "/etc/passwd"],
    ["a parent escape", "../outside.ts"],
    ["an embedded parent escape", "src/../../outside.ts"],
    ["a backslash-separated parent escape", "..\\outside.ts"],
    ["a Windows drive-qualified path", "C:/Windows/system32/drivers/etc/hosts"],
    ["a NUL-bearing path", "src/a.ts\u0000.png"],
    ["an empty path", ""],
  ])("rejects %s before an edit request exists", (_name, file) => {
    expect(parseCodingToolRequest(editBody(file), 262_144)).toBeUndefined();
  });
});

describe("coding tool IPC CI observation (#3388)", () => {
  function ciBody(extra: Record<string, unknown>): string {
    return JSON.stringify({
      action: "git",
      operation: "ci",
      actionId: "ci-1",
      idempotencyKey: "ci-key",
      ...extra,
    });
  }

  it("admits a CI request with no forceFresh", () => {
    expect(parseCodingToolRequest(ciBody({}), 262_144)).toEqual({
      action: "git",
      operation: "ci",
      actionId: "ci-1",
      idempotencyKey: "ci-key",
    });
  });

  it.each([
    ["forceFresh true", true],
    ["forceFresh false", false],
  ])("admits an explicit %s", (_name, forceFresh) => {
    expect(parseCodingToolRequest(ciBody({ forceFresh }), 262_144)).toEqual({
      action: "git",
      operation: "ci",
      actionId: "ci-1",
      idempotencyKey: "ci-key",
      forceFresh,
    });
  });

  it("admits forceFresh alongside an approvalProof (3941816393)", () => {
    const proof = { approvalId: "ci-1", approvalDigest: "b".repeat(64) };
    expect(
      parseCodingToolRequest(ciBody({ forceFresh: true, approvalProof: proof }), 262_144),
    ).toEqual({
      action: "git",
      operation: "ci",
      actionId: "ci-1",
      idempotencyKey: "ci-key",
      forceFresh: true,
      approvalProof: proof,
    });
  });

  it.each([
    ["a non-boolean forceFresh", { forceFresh: "true" }],
    ["an unexpected extra key alongside forceFresh", { forceFresh: true, extra: "SENTINEL" }],
    ["an unexpected extra key with no forceFresh", { extra: "SENTINEL" }],
  ])("rejects %s before a CI observation request exists", (_name, extra) => {
    expect(parseCodingToolRequest(ciBody(extra), 262_144)).toBeUndefined();
  });
});
