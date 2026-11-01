// #4179: the change set of a new document version, derived from the labels the trace wrote into
// Jira and the current inventory. No earlier inventory is needed or invented.
import { describe, expect, it } from "vitest";

import {
  deriveRequirementInventory,
  type RequirementInventoryEntry,
} from "../domain/requirementInventory.js";
import { compareRequirementsWithTrace } from "../domain/requirementChanges.js";
import {
  REQUIREMENT_TRACE_MARKER_LABEL,
  documentLabel,
  requirementLabel,
  revisionLabel,
} from "../domain/requirementTrace.js";

function text(limit: Record<string, number> = {}, ids = ["LH-001", "LH-002", "LH-003"]): string {
  return ids
    .map(
      (id) =>
        `${id}: Thema ${id}\nDas Portal unterstützt ${id}; die Bearbeitung ist innerhalb von ${String(limit[id] ?? 10)} Minuten abgeschlossen.\nPriorität: Muss.\n`,
    )
    .join("\n");
}
function entriesOf(source: string, documentKey = "doc:a"): readonly RequirementInventoryEntry[] {
  return deriveRequirementInventory({ text: source, documentKey }).entries;
}
function entry(list: readonly RequirementInventoryEntry[], id: string): RequirementInventoryEntry {
  const found = list.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`expected ${id}`);
  return found;
}
function labels(members: readonly RequirementInventoryEntry[]): readonly string[] {
  return [
    REQUIREMENT_TRACE_MARKER_LABEL,
    ...new Set(members.map((member) => documentLabel(member.documentScope))),
    ...members.map((member) => requirementLabel(member.id)),
    ...members.map((member) => revisionLabel(member.digest)),
  ];
}

describe("compareRequirementsWithTrace", () => {
  const version1 = entriesOf(text());
  const scope = entry(version1, "LH-001").documentScope;

  it("classifies a revised, a removed, an untouched and a not yet traced requirement", () => {
    const version2 = entriesOf(text({ "LH-002": 15 }, ["LH-002", "LH-003", "LH-004"]));
    const issues = [
      { key: "REQ-1", labels: labels([entry(version1, "LH-001")]) },
      { key: "REQ-2", labels: labels([entry(version1, "LH-002")]) },
      { key: "REQ-3", labels: labels([entry(version1, "LH-003")]) },
      { key: "REQ-9", labels: ["unrelated"] },
    ];

    const result = compareRequirementsWithTrace(version2, [scope], issues);

    expect(result.items.map((item) => [item.status, item.id, item.issues])).toEqual([
      ["changed", "LH-002", ["REQ-2"]],
      ["removed", "LH-001", ["REQ-1"]],
      ["untraced", "LH-004", []],
    ]);
    expect(result.unchangedCount).toBe(1);
    expect(result.unchanged.map((unchanged) => unchanged.id)).toEqual(["LH-003"]);
    expect(result.affectedIssues).toEqual(["REQ-1", "REQ-2"]);
    expect(result.tracedIssueCount).toBe(3);
    expect(result.unmatchedIssueCount).toBe(0);
  });

  it("judges each requirement of an item that traces several on its own revision label", () => {
    const version2 = entriesOf(text({ "LH-002": 15 }));
    const both = [entry(version1, "LH-001"), entry(version1, "LH-002")];
    const issues = [{ key: "REQ-1", labels: labels(both) }];

    const result = compareRequirementsWithTrace(version2, [scope], issues);

    expect(result.items.filter((item) => item.status !== "untraced")).toMatchObject([
      { status: "changed", id: "LH-002", issues: ["REQ-1"] },
    ]);
    expect(result.unchangedCount).toBe(1);
  });

  it("treats an item that names a requirement but no revision as outdated", () => {
    const issues = [
      {
        key: "REQ-1",
        labels: [REQUIREMENT_TRACE_MARKER_LABEL, documentLabel(scope), requirementLabel("LH-001")],
      },
    ];

    const result = compareRequirementsWithTrace(version1, [scope], issues);

    expect(result.items[0]).toMatchObject({ status: "changed", id: "LH-001", issues: ["REQ-1"] });
  });

  it("does not claim a removal for an item of a document that is not in the Pods", () => {
    const foreign = entriesOf(text(), "doc:other");
    const issues = [{ key: "REQ-1", labels: labels([entry(foreign, "LH-001")]) }];

    const result = compareRequirementsWithTrace(version1, [scope], issues);

    expect(result.items.map((item) => item.status)).toEqual(["untraced", "untraced", "untraced"]);
    expect(result.unmatchedIssueCount).toBe(1);
    expect(result.affectedIssues).toEqual([]);
  });

  it("keeps equal identifiers of two documents apart", () => {
    const other = entriesOf(text(), "doc:b");
    const scopeB = entry(other, "LH-001").documentScope;
    const issues = [{ key: "REQ-1", labels: labels([entry(other, "LH-001")]) }];

    const result = compareRequirementsWithTrace([...version1, ...other], [scope, scopeB], issues);

    expect(result.unchangedCount).toBe(1);
    const untracedOfFirst = result.items.filter(
      (item) => item.id === "LH-001" && item.status === "untraced",
    );
    expect(untracedOfFirst.map((item) => item.documentScope)).toEqual([scope]);
  });

  it("orders the issue keys of an affected requirement by project and number", () => {
    const version2 = entriesOf(text({ "LH-001": 15 }));
    const stale = labels([entry(version1, "LH-001")]);
    const issues = [
      { key: "REQ-10", labels: stale },
      { key: "REQ-2", labels: stale },
    ];

    const result = compareRequirementsWithTrace(version2, [scope], issues);

    expect(result.items[0]?.issues).toEqual(["REQ-2", "REQ-10"]);
    expect(result.affectedIssues).toEqual(["REQ-2", "REQ-10"]);
  });
});
