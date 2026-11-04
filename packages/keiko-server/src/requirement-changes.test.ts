// #4179 review: a removal is claimed only against a complete document inventory, and the change
// view fits its bytes however many items trace one requirement.
import type { KnowledgeCapsuleId } from "@oscharko-dev/keiko-contracts";
import {
  deriveRequirementInventory,
  documentLabel,
  requirementLabel,
  revisionLabel,
  type RequirementInventory,
} from "@oscharko-dev/keiko-quality-intelligence";
import { describe, expect, it } from "vitest";

import { storeFinishedReport } from "./_requirementSupport.js";
import { changesView } from "./requirement-changes.js";
import type { RequirementCollection } from "./requirement-inventory.js";
import { createJiraReportStore, type JiraReport } from "@oscharko-dev/keiko-connectors";

const KEY = "doc:omitted";

function text(count: number): string {
  return Array.from(
    { length: count },
    (_, index) =>
      `LH-${String(index + 1).padStart(3, "0")}: Thema ${String(index + 1)}\nDas Portal unterstützt Thema ${String(index + 1)}; die Frist beträgt 10 Tage.\nPriorität: Muss.\n`,
  ).join("\n");
}

/** The collection a read of one document leaves, with the inventory cut at `maxEntries`. */
function collectionOf(inventory: RequirementInventory): RequirementCollection {
  const scope = inventory.entries[0]?.documentScope ?? "";
  return {
    units: inventory.entries.map((entry) => ({
      entry,
      source: { documentName: "Spec.md", documentDigest: "d".repeat(64) },
      findings: [],
      capsuleId: "cap-a" as KnowledgeCapsuleId,
      documentId: "doc-a",
    })),
    documents: [
      {
        documentScope: scope,
        name: "Spec.md",
        digest: "d".repeat(64),
        unitCount: inventory.entries.length,
        unitsOmitted: inventory.totalCount - inventory.entries.length,
      },
    ],
    documentsScanned: 1,
    documentsNotExtracted: 0,
    documentsOmitted: 0,
    unitsOmitted: inventory.totalCount - inventory.entries.length,
    cutReasons: inventory.truncated ? ["unit-bound"] : [],
    refusals: [],
    conflictingIds: [],
    ambiguousIds: [],
    referenceOnlyCount: 0,
    rejectedCandidateCount: 0,
  };
}

function reportOf(labels: readonly string[], count = 1): JiraReport {
  return finished(
    Array.from({ length: count }, (_, index) => ({ key: `REQ-${String(index + 1)}`, labels })),
  );
}
function finished(issues: readonly { key: string; labels: readonly string[] }[]): JiraReport {
  const store = createJiraReportStore();
  const id = storeFinishedReport(store, "chat-1", issues);
  const report = store.get(id, "chat-1")?.report;
  if (report === undefined) throw new Error("expected a report");
  return report;
}

describe("removals against a bounded inventory (#4179 review)", () => {
  const full = deriveRequirementInventory({ text: text(3), documentKey: KEY });
  const second = full.entries[1];
  if (second === undefined) throw new Error("expected a requirement");
  const tracedLabels = [
    documentLabel(second.documentScope),
    requirementLabel(second.id),
    revisionLabel(second.digest),
  ];

  it("does not declare a requirement removed that a cut inventory merely did not show", () => {
    const cut = deriveRequirementInventory({ text: text(3), documentKey: KEY, maxEntries: 1 });
    expect(cut.truncated).toBe(true);

    const view = changesView(collectionOf(cut), reportOf(tracedLabels), (value) => value);

    expect(view.counts.removed).toBe(0);
    expect(view.data).toMatchObject({
      counts: { removed: 0 },
      removed: [],
      affectedIssues: [],
      unverifiedRemoved: ["LH-002"],
      unverifiedRemovedCount: 1,
    });
  });

  it("still declares a genuinely removed requirement of a complete inventory removed", () => {
    const gone = deriveRequirementInventory({
      text: text(3).replace(/LH-002: [\s\S]*?(?=LH-003)/u, ""),
      documentKey: KEY,
    });
    expect(gone.truncated).toBe(false);

    const view = changesView(collectionOf(gone), reportOf(tracedLabels), (value) => value);

    expect(view.counts.removed).toBe(1);
    expect(view.data).toMatchObject({
      removed: [{ id: "LH-002", issues: ["REQ-1"] }],
      affectedIssues: ["REQ-1"],
    });
    expect(view.data).not.toHaveProperty("unverifiedRemoved");
  });
});

describe("the change view within a byte bound (#4179 review)", () => {
  const inventory = deriveRequirementInventory({ text: text(3), documentKey: KEY });
  const first = inventory.entries[0];
  if (first === undefined) throw new Error("expected a requirement");
  const outdated = [
    documentLabel(first.documentScope),
    requirementLabel(first.id),
    "keiko-rev-oldoldoldold",
  ];

  it("shrinks the lists until the whole object fits and names what it cut", () => {
    const report = reportOf(outdated, 4000);
    const unbounded = changesView(collectionOf(inventory), report, (value) => value);
    const bounded = changesView(collectionOf(inventory), report, (value) => value, 900);

    expect(Buffer.byteLength(JSON.stringify(unbounded.data))).toBeGreaterThan(900);
    expect(Buffer.byteLength(JSON.stringify(bounded.data))).toBeLessThanOrEqual(900);
    expect(bounded.counts).toEqual(unbounded.counts);
    expect(bounded.data).toMatchObject({
      counts: { changed: 1 },
      changed: [{ id: "LH-001", issueCount: 4000 }],
    });
    expect(bounded.data.truncated).toEqual(expect.arrayContaining(["issues"]));
  });
});
