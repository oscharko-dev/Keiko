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
