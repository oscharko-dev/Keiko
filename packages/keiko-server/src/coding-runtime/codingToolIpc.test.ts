import { describe, expect, it } from "vitest";

import { parseCodingToolRequest } from "./codingToolIpc.js";

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
