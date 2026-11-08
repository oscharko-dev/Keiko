import { JIRA_PROJECT_REFERENCE_PATTERN } from "@oscharko-dev/keiko-connectors";
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

  it("accepts exactly what the tool schema's project pattern accepts", () => {
    const pattern = new RegExp(JIRA_PROJECT_REFERENCE_PATTERN, "u");
    for (const projectId of ["_AB", "1AB", "KER", "10000", "k_9"])
      expect(parseJiraDraftBatchArguments({ ...BASE, projectId }) !== undefined).toBe(
        pattern.test(projectId),
      );
  });

  it.each([
    ["a key with a space", { projectId: "K E R" }],
    ["a key with a hyphen", { projectId: "K-E" }],
    ["a missing project", {}],
    ["an over-long issue type", { projectId: "KER", issueTypeId: "x".repeat(121) }],
    ["a blank issue type", { projectId: "KER", issueTypeId: "  " }],
    ["a non-text issue type", { projectId: "KER", issueTypeId: 5 }],
  ])("refuses %s", (_name, args) => {
    expect(parseJiraDraftBatchArguments({ ...BASE, ...args })).toBeUndefined();
  });
});
