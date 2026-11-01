import { expect, it } from "vitest";
import { JIRA_DRAFT_RESULT_ROWS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { catalogJsonBytes, validateToolResultEnvelope } from "@oscharko-dev/keiko-tool-catalog";
import { JIRA_MUTATION_DECLARATIONS } from "./jiraManagedMutationDescriptors.js";

const PROJECTION = "c".repeat(64) as CatalogDigest;

function draftDescriptor(): (typeof JIRA_MUTATION_DECLARATIONS)[number]["descriptor"] {
  const declaration = JIRA_MUTATION_DECLARATIONS.find((entry) => entry.name === "jira.draft");
  if (declaration === undefined) throw new Error("Expected the jira.draft declaration");
  return declaration.descriptor;
}

function completedDraft(count: number, extra: CatalogJsonObject = {}, rows = count): unknown {
  const descriptor = draftDescriptor();
  const data: CatalogJsonObject = {
    outcome: "succeeded",
    items: Array.from({ length: rows }, (_, index) => ({
      ref: `item${String(index)}`,
      state: "created",
      issueKey: `REQ-${String(index + 1)}`,
    })),
    createdCount: count,
    ...extra,
  };
  return {
    schemaVersion: 1,
    invocationId: "catalog-invocation-draft",
    toolRef: descriptor.toolRef,
    projectionDigest: PROJECTION,
    effectStarted: true,
    status: "completed",
    reason: "none",
    data,
    page: { truncated: false, reason: "none", cursor: null },
    metrics: {
      inputBytes: 10,
      outputBytes: catalogJsonBytes(data),
      resultCount: rows,
      durationMs: 10,
    },
  };
}

// #4178 (lab S17): every mutation declared at most one result, so a draft that created several
// issues failed its own result contract after Jira had created them, and the model created them
// all again. A draft reports one result per item, up to the draft's own item bound.
it.each([2, 8, JIRA_DRAFT_RESULT_ROWS_MAX])(
  "accepts a completed backlog draft with %i created items under its own contract",
  (count) => {
    const binding = { descriptor: draftDescriptor(), projectionDigest: PROJECTION };
    expect(validateToolResultEnvelope(completedDraft(count), binding)).toMatchObject({
      status: "completed",
      metrics: { resultCount: count },
    });
  },
);

it("accepts the compact result of a draft with thousands of created items", () => {
  const binding = { descriptor: draftDescriptor(), projectionDigest: PROJECTION };
  const compact = completedDraft(
    5000,
    {
      compact: true,
      omittedRowCount: 0,
      createdRanges: ["REQ-1..REQ-4990", "REQ-4995..REQ-5004"],
      existingRanges: [],
      pendingCount: 0,
    },
    0,
  );
  expect(validateToolResultEnvelope(compact, binding)).toMatchObject({ status: "completed" });
});

it("still refuses a draft result with more rows than the catalog carries (a larger result is compact)", () => {
  const binding = { descriptor: draftDescriptor(), projectionDigest: PROJECTION };
  expect(() =>
    validateToolResultEnvelope(completedDraft(JIRA_DRAFT_RESULT_ROWS_MAX + 1), binding),
  ).toThrow();
});

it("keeps every single-issue mutation at one result", () => {
  for (const declaration of JIRA_MUTATION_DECLARATIONS)
    if (declaration.name !== "jira.draft")
      expect(declaration.descriptor.bounds.maxResultCount).toBe(1);
});
