// Unit tests for `parseRunRequest` (ADR-0011 D5 route 5). The parser is the shape-only validator
// between the BFF and the workflow/harness entry points. Issue #65 composer runs must always carry
// a selected local project workspaceRoot; verify adds targetFiles-specific validation on top.

import { describe, expect, it } from "vitest";
import { parseRunRequest } from "../../src/ui/run-request.js";

function ok(value: ReturnType<typeof parseRunRequest>): asserts value is Exclude<
  ReturnType<typeof parseRunRequest>,
  { code: "BAD_REQUEST" }
> {
  if ("code" in value) {
    throw new Error(`expected success, got BAD_REQUEST: ${value.message}`);
  }
}

function bad(value: ReturnType<typeof parseRunRequest>): asserts value is {
  readonly code: "BAD_REQUEST";
  readonly message: string;
} {
  if (!("code" in value)) {
    throw new Error("expected BAD_REQUEST, got success");
  }
}

describe("parseRunRequest verify variant", () => {
  it("parses a verify request with workspaceRoot", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        modelId: "m",
        input: { workspaceRoot: "/repo" },
      }),
    );
    ok(result);
    expect(result.kind).toBe("verify");
    expect(result.input).toEqual({ workspaceRoot: "/repo" });
    expect(result.apply).toBe(false);
  });

  it("parses a verify request with workspaceRoot and a non-empty targetFiles array", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        modelId: "m",
        input: { workspaceRoot: "/repo", targetFiles: ["src/a.ts", "src/b.ts"] },
      }),
    );
    ok(result);
    expect(result.kind).toBe("verify");
    expect(result.input.targetFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("forces apply to false even when the body sets apply:true", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        modelId: "m",
        apply: true,
        input: { workspaceRoot: "/repo" },
      }),
    );
    ok(result);
    expect(result.apply).toBe(false);
  });

  it("rejects when workspaceRoot is missing", () => {
    const result = parseRunRequest(
      JSON.stringify({ taskType: "verify", modelId: "m", input: {} }),
    );
    bad(result);
    expect(result.message).toMatch(/workspaceRoot/);
  });

  it("rejects when workspaceRoot is empty", () => {
    const result = parseRunRequest(
      JSON.stringify({ taskType: "verify", modelId: "m", input: { workspaceRoot: "" } }),
    );
    bad(result);
    expect(result.message).toMatch(/workspaceRoot/);
  });

  it("rejects when workspaceRoot is the wrong type", () => {
    const result = parseRunRequest(
      JSON.stringify({ taskType: "verify", modelId: "m", input: { workspaceRoot: 42 } }),
    );
    bad(result);
    expect(result.message).toMatch(/workspaceRoot/);
  });

  it("rejects when targetFiles is not an array", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        modelId: "m",
        input: { workspaceRoot: "/repo", targetFiles: "src/a.ts" },
      }),
    );
    bad(result);
    expect(result.message).toMatch(/targetFiles/);
  });

  it("rejects when targetFiles contains a non-string entry", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        modelId: "m",
        input: { workspaceRoot: "/repo", targetFiles: ["src/a.ts", 7] },
      }),
    );
    bad(result);
    expect(result.message).toMatch(/non-empty strings/);
  });

  it("rejects when targetFiles contains an empty string", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        modelId: "m",
        input: { workspaceRoot: "/repo", targetFiles: [""] },
      }),
    );
    bad(result);
    expect(result.message).toMatch(/non-empty strings/);
  });

  it("rejects an unsupported taskType", () => {
    const result = parseRunRequest(
      JSON.stringify({ taskType: "frobnicate", modelId: "m", input: {} }),
    );
    bad(result);
    expect(result.message).toMatch(/Unsupported taskType/);
  });

  it("rejects when both workflowId and taskType are present", () => {
    const result = parseRunRequest(
      JSON.stringify({
        taskType: "verify",
        workflowId: "unit-test-generation",
        modelId: "m",
        input: { workspaceRoot: "/repo" },
      }),
    );
    bad(result);
    expect(result.message).toMatch(/exactly one of workflowId or taskType/);
  });

  it("rejects when modelId is empty", () => {
    const result = parseRunRequest(
      JSON.stringify({ taskType: "verify", modelId: "", input: { workspaceRoot: "/repo" } }),
    );
    bad(result);
    expect(result.message).toMatch(/modelId/);
  });
});

describe("parseRunRequest selected-project workspaceRoot invariant", () => {
  it.each([
    {
      label: "unit-test-generation",
      body: { workflowId: "unit-test-generation", modelId: "m", input: { target: { kind: "moduleDir", moduleDir: "/repo" } } },
    },
    {
      label: "bug-investigation",
      body: { workflowId: "bug-investigation", modelId: "m", input: { report: { description: "bug" } } },
    },
    {
      label: "explain-plan",
      body: { taskType: "explain-plan", modelId: "m", input: { filePath: "src/a.ts" } },
    },
  ])("rejects $label when workspaceRoot is missing", ({ body }) => {
    const result = parseRunRequest(JSON.stringify(body));
    bad(result);
    expect(result.message).toMatch(/workspaceRoot/);
  });
});
