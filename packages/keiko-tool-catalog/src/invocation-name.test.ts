import { describe, expect, it } from "vitest";
import { foldToolOperationName } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { resolveToolName } from "./invocation.js";

// The one spelling rule: a name the model wrote is matched against the aliases a round offers.
describe("the one fold of tool names", () => {
  it("folds dots and hyphens to underscores and nothing else", () => {
    expect(foldToolOperationName("jira.set-issue-property")).toBe("jira_set_issue_property");
    expect(foldToolOperationName("jira_set_issue_property")).toBe("jira_set_issue_property");
    // Case, spaces and every other character are untouched: no second rule.
    expect(foldToolOperationName("Jira.Set Issue")).toBe("Jira_Set Issue");
    expect(foldToolOperationName("a/b:c")).toBe("a/b:c");
  });
});

describe("what a called name means in one round", () => {
  const offered = ["jira_describe", "jira_set_issue_property", "read_file"];
  const projected = [...offered, "jira_delete_issue", "write_file"];
  it("an exact offered alias wins, even when another alias folds to the same name", () => {
    expect(resolveToolName(["a_b", "a-b"], ["a_b", "a-b"], "a-b")).toEqual({
      kind: "exact",
      alias: "a-b",
    });
    expect(resolveToolName(offered, projected, "read_file")).toEqual({
      kind: "exact",
      alias: "read_file",
    });
  });
  it("a name that equals exactly one offered alias after the fold binds to it", () => {
    expect(resolveToolName(offered, projected, "jira.set-issue-property")).toEqual({
      kind: "folded",
      alias: "jira_set_issue_property",
    });
    expect(resolveToolName(offered, projected, "read.file")).toEqual({
      kind: "folded",
      alias: "read_file",
    });
  });
  it("a name that equals several offered aliases after the fold is refused, never the first", () => {
    expect(resolveToolName(["a_b", "a-b"], ["a_b", "a-b"], "a.b")).toEqual({ kind: "ambiguous" });
  });
  it("a name of a tool the catalog has but this round did not offer stays refused", () => {
    expect(resolveToolName(offered, projected, "jira.delete-issue")).toEqual({
      kind: "not-offered",
    });
    expect(resolveToolName(offered, projected, "write_file")).toEqual({ kind: "not-offered" });
  });
  it("a name nothing matches, or that differs by more than the fold, is unknown", () => {
    expect(resolveToolName(offered, projected, "frobnicate")).toEqual({ kind: "unknown" });
    expect(resolveToolName(offered, projected, "Read_File")).toEqual({ kind: "unknown" });
    expect(resolveToolName(offered, projected, "read file")).toEqual({ kind: "unknown" });
    expect(resolveToolName([], [], "read_file")).toEqual({ kind: "unknown" });
  });
});
