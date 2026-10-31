import { expect, it } from "vitest";
import { JIRA_DRAFT_ITEMS_MAX } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
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

function completedDraft(count: number): unknown {
  const descriptor = draftDescriptor();
  const data: CatalogJsonObject = {
    outcome: "succeeded",
    items: Array.from({ length: count }, (_, index) => ({
      ref: `item${String(index)}`,
      state: "created",
      issueKey: `REQ-${String(index + 1)}`,
    })),
    createdCount: count,
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
      resultCount: count,
      durationMs: 10,
    },
  };
}

// #4178 (lab S17): every mutation declared at most one result, so a draft that created several
// issues failed its own result contract after Jira had created them, and the model created them
// all again. A draft reports one result per item, up to the draft's own item bound.
it.each([2, 8, JIRA_DRAFT_ITEMS_MAX])(
  "accepts a completed backlog draft with %i created items under its own contract",
  (count) => {
    const binding = { descriptor: draftDescriptor(), projectionDigest: PROJECTION };
    expect(validateToolResultEnvelope(completedDraft(count), binding)).toMatchObject({
      status: "completed",
      metrics: { resultCount: count },
    });
  },
);

it("still refuses a draft result that reports more items than a draft may hold", () => {
  const binding = { descriptor: draftDescriptor(), projectionDigest: PROJECTION };
  expect(() =>
    validateToolResultEnvelope(completedDraft(JIRA_DRAFT_ITEMS_MAX + 1), binding),
  ).toThrow();
});

it("keeps every single-issue mutation at one result", () => {
  for (const declaration of JIRA_MUTATION_DECLARATIONS)
    if (declaration.name !== "jira.draft")
      expect(declaration.descriptor.bounds.maxResultCount).toBe(1);
});
