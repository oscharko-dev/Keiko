import { describe, expect, it } from "vitest";
import {
  JIRA_DRAFT_RESULT_ROWS_MAX,
  JIRA_MUTATION_LINKS_MAX,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { catalogJsonBytes, validateToolResultEnvelope } from "@oscharko-dev/keiko-tool-catalog";
import { JIRA_MUTATION_DECLARATIONS } from "./jiraManagedMutationDescriptors.js";
import { jiraAttemptToolResult } from "./jiraMutationResult.js";

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

// A create or edit that landed but whose further links did not must still return its receipt and
// the missing links through the descriptor's own result contract, whatever the link type names are
// written in (review): the bound is the encoded worst case, not the ASCII one.
describe("the partial-effect result of a create or edit fits its descriptor (review)", () => {
  const LINK_TYPES: readonly (readonly [string, (index: number) => string])[] = [
    ["ASCII", (index: number): string => `${"t".repeat(254)}${String(index % 10)}`],
    ["CJK", (index: number): string => `${"漢".repeat(254)}${String.fromCharCode(0x4e00 + index)}`],
    [
      "emoji",
      (index: number): string => `${"😀".repeat(126)}${String.fromCharCode(0x4e00 + index)}`,
    ],
    [
      "lone surrogate",
      (index: number): string => `${"\ud800".repeat(254)}${String.fromCharCode(0xdc00 + index)}`,
    ],
  ];
  const descriptorOf = (
    name: string,
  ): (typeof JIRA_MUTATION_DECLARATIONS)[number]["descriptor"] => {
    const declaration = JIRA_MUTATION_DECLARATIONS.find((entry) => entry.name === name);
    if (declaration === undefined) throw new Error(`Expected the ${name} declaration`);
    return declaration.descriptor;
  };
  function partial(typeOf: (index: number) => string): CatalogJsonObject {
    const requested = Array.from({ length: JIRA_MUTATION_LINKS_MAX }, (_, index) => ({
      type: typeOf(index),
      direction: "outward" as const,
      issueKey: `${"K".repeat(100)}-${String(index + 1)}`,
    }));
    const attempt: JiraMutationAttempt = {
      ok: false,
      reason: "malformed-payload",
      receipt: { issueKey: "SYN-1", issueId: "10001" },
      links: {
        requested: requested.length,
        created: 1,
        unconfirmed: false,
        missing: requested.slice(1),
      },
    };
    return jiraAttemptToolResult("succeeded-unconfirmed", attempt).data;
  }

  it.each(
    ["jira.create", "jira.edit"].flatMap((name) =>
      LINK_TYPES.map(([kind, typeOf]) => [name, kind, typeOf] as const),
    ),
  )("%s returns its receipt and %s link types at the request's maximum", (name, _kind, typeOf) => {
    const descriptor = descriptorOf(name);
    const data = partial(typeOf);
    expect(data).toMatchObject({ issueKey: "SYN-1", issueId: "10001", linksCreated: 1 });
    expect(Reflect.get(data, "linksMissing") as unknown[]).toHaveLength(
      JIRA_MUTATION_LINKS_MAX - 1,
    );
    const envelope = {
      schemaVersion: 1,
      invocationId: "catalog-invocation-partial",
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
        resultCount: 1,
        durationMs: 10,
      },
    };
    expect(
      validateToolResultEnvelope(envelope, { descriptor, projectionDigest: PROJECTION }),
    ).toMatchObject({ status: "completed" });
  });
});

it("keeps every single-issue mutation at one result", () => {
  for (const declaration of JIRA_MUTATION_DECLARATIONS)
    if (declaration.name !== "jira.draft")
      expect(declaration.descriptor.bounds.maxResultCount).toBe(1);
});
