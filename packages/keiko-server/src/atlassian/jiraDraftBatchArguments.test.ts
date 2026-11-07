import { describe, expect, it } from "vitest";
import { parseJiraDraftBatchArguments } from "./jiraDraftBatchArguments.js";

const BASE = { granularity: "per-requirement", create: false } as const;

describe("parseJiraDraftBatchArguments (#4173)", () => {
  it("accepts a numeric project id with a numeric issue type id", () => {
    expect(
      parseJiraDraftBatchArguments({ ...BASE, projectId: "10000", issueTypeId: "10001" }),
    ).toMatchObject({ projectId: "10000", issueTypeId: "10001" });
  });

  it("accepts a project key and leaves an omitted issue type omitted", () => {
    const parsed = parseJiraDraftBatchArguments({ ...BASE, projectId: "KER" });
    expect(parsed).toMatchObject({ projectId: "KER" });
    expect(parsed?.issueTypeId).toBeUndefined();
  });

  it("accepts an issue type name, trimmed", () => {
    expect(
      parseJiraDraftBatchArguments({ ...BASE, projectId: "KER", issueTypeId: " Story " }),
    ).toMatchObject({ issueTypeId: "Story" });
  });

  it.each([
    ["a key with a space", { projectId: "K E R" }],
    ["a key starting with a digit and letters", { projectId: "1KER" }],
    ["a missing project", {}],
    ["an over-long issue type", { projectId: "KER", issueTypeId: "x".repeat(121) }],
    ["a blank issue type", { projectId: "KER", issueTypeId: "  " }],
    ["a non-text issue type", { projectId: "KER", issueTypeId: 5 }],
  ])("refuses %s", (_name, args) => {
    expect(parseJiraDraftBatchArguments({ ...BASE, ...args })).toBeUndefined();
  });
});
