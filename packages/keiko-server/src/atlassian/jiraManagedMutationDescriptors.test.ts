import { describe, expect, it } from "vitest";
import {
  JIRA_DRAFT_RESULT_ROWS_MAX,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_LINKS_MAX,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
  sanitizeJiraMutationFailureDetail,
  type JiraMutationAttempt,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogDigest,
  CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  catalogJsonBytes,
  validateToolArguments,
  validateToolResultEnvelope,
} from "@oscharko-dev/keiko-tool-catalog";
import { KEY_RANGE_ENTRY_CHARS } from "./jiraDraftKeyRanges.js";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./actionApprovalLimits.js";
import { checkJiraDraft } from "@oscharko-dev/keiko-connectors";
import { JIRA_DRAFT_STAGE_DECLARATION } from "./jiraDraftDescriptor.js";
import { JIRA_MUTATION_DECLARATIONS } from "./jiraManagedMutationDescriptors.js";
import { JIRA_REJECTED_GUIDANCE, jiraAttemptToolResult } from "./jiraMutationResult.js";

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

it("accepts the packed key lists of a draft whose created keys are scattered, and the count of unlisted keys", () => {
  const binding = { descriptor: draftDescriptor(), projectionDigest: PROJECTION };
  const entry = Array.from({ length: 60 }, (_, index) => `REQ-${String(index * 2 + 1001)}`)
    .join(",")
    .slice(0, KEY_RANGE_ENTRY_CHARS);
  const compact = completedDraft(
    90_000,
    {
      compact: true,
      omittedRowCount: 0,
      createdRanges: Array.from({ length: 350 }, () => entry),
      existingRanges: [],
      pendingCount: 0,
      rangesTruncated: true,
      unlistedKeyCount: 30_000,
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
describe("a write tool waits in place for the human's decision", () => {
  it.each(JIRA_MUTATION_DECLARATIONS.map((entry) => [entry.name, entry] as const))(
    "%s keeps its work budget on top of the time the human has to decide",
    (_name, declaration) => {
      expect(declaration.descriptor.bounds.maxDurationMs).toBeGreaterThanOrEqual(
        ATLASSIAN_ACTION_APPROVAL_TTL_MS + 60_000,
      );
    },
  );
});

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

// Review (#4176 AC4): a refused write must return every field error Jira gave, with the display
// names and guidance that let the model correct it. The result bound is the encoded worst case of
// what the sanitizer admits, not an ASCII one, for every operation that can return it.
describe("the refusal detail of every single-issue mutation fits its descriptor (review)", () => {
  const TEXTS: readonly (readonly [string, string])[] = [
    ["ASCII", "x".repeat(200)],
    ["quotes", '"'.repeat(200)],
    ["backslashes", "\\".repeat(200)],
    ["CJK", "漢".repeat(200)],
    ["emoji", "😀".repeat(200)],
    ["lone surrogates", "\ud800".repeat(200)],
  ];
  const OPERATIONS = [
    "jira.create",
    "jira.edit",
    "jira.assign",
    "jira.comment",
    "jira.transition",
    "jira.attach",
  ];
  const GATED = ["jira.create", "jira.edit", "jira.transition"];
  const descriptorOf = (
    name: string,
  ): (typeof JIRA_MUTATION_DECLARATIONS)[number]["descriptor"] => {
    const declaration = JIRA_MUTATION_DECLARATIONS.find((entry) => entry.name === name);
    if (declaration === undefined) throw new Error(`Expected the ${name} declaration`);
    return declaration.descriptor;
  };
  function envelopeOf(
    descriptor: (typeof JIRA_MUTATION_DECLARATIONS)[number]["descriptor"],
    data: CatalogJsonObject,
  ): unknown {
    return {
      schemaVersion: 1,
      invocationId: "catalog-invocation-refused",
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
  }
  function refusedWith(text: string, fieldId: string): JiraMutationAttempt {
    const detail = sanitizeJiraMutationFailureDetail({
      fieldErrors: Array.from({ length: 16 }, () => ({ fieldId, fieldName: text, message: text })),
      messages: [text, text, text, text],
    });
    return { ok: false, reason: "field-validation", ...(detail === undefined ? {} : { detail }) };
  }

  it.each(OPERATIONS.flatMap((name) => TEXTS.map(([kind, text]) => [name, kind, text] as const)))(
    "%s returns eight named field errors and three messages made of %s",
    (name, _kind, text) => {
      const descriptor = descriptorOf(name);
      const attempt = refusedWith(text, "a".repeat(64));
      const result = jiraAttemptToolResult("rejected", attempt).data;
      expect(Reflect.get(result, "fieldErrors") as unknown[]).toHaveLength(
        JIRA_MUTATION_DETAIL_LIMITS.fieldErrors,
      );
      expect(Reflect.get(result, "messages") as unknown[]).toHaveLength(
        JIRA_MUTATION_DETAIL_LIMITS.messages,
      );
      expect(Reflect.get(result, "guidance")).toBe(JIRA_REJECTED_GUIDANCE);
      const bound = descriptor.bounds.maxResultBytes;
      expect(catalogJsonBytes(result)).toBeLessThanOrEqual(bound);
      expect(
        validateToolResultEnvelope(envelopeOf(descriptor, result), {
          descriptor,
          projectionDigest: PROJECTION,
        }),
      ).toMatchObject({ status: "completed" });
    },
  );

  it.each(GATED.flatMap((name) => TEXTS.map(([kind, text]) => [name, kind, text] as const)))(
    "%s returns the largest template refusal beside the largest detail, made of %s",
    (name, _kind, text) => {
      const descriptor = descriptorOf(name);
      const refused = refusedWith(text, "a".repeat(64));
      const attempt: JiraMutationAttempt = {
        ...refused,
        violations: Array.from({ length: JIRA_TEMPLATE_VIOLATIONS_MAX }, () => ({
          ruleId: "template-unreadable" as const,
          subject: text.repeat(2).slice(0, 120),
          template: text.repeat(2).slice(0, 256),
        })),
      } as JiraMutationAttempt;
      const result = jiraAttemptToolResult("rejected", attempt).data;
      expect(Reflect.get(result, "violations") as unknown[]).toHaveLength(
        JIRA_TEMPLATE_VIOLATIONS_MAX,
      );
      expect(catalogJsonBytes(result)).toBeLessThanOrEqual(descriptor.bounds.maxResultBytes);
      expect(
        validateToolResultEnvelope(envelopeOf(descriptor, result), {
          descriptor,
          projectionDigest: PROJECTION,
        }),
      ).toMatchObject({ status: "completed" });
    },
  );

  it("needed more than the former 4,096 bytes for the largest named refusal", () => {
    const result = jiraAttemptToolResult("rejected", refusedWith("x".repeat(200), "a".repeat(64)));
    expect(catalogJsonBytes(result.data)).toBeGreaterThan(4096);
  });
});

describe("staged drafts declare the item shape their handler accepts", () => {
  const item = {
    ref: "migration",
    projectId: "10000",
    issueTypeId: "10001",
    fields: {
      summary: "Synthetic migration",
      description: "Synthetic description",
      labels: ["synthetic"],
      customfield_10010: { value: "Synthetic choice" },
    },
  };
  const descriptors = [JIRA_DRAFT_STAGE_DECLARATION.descriptor, draftDescriptor()];

  it("accepts the same complete item and dynamic Jira fields for staging and execution", () => {
    expect(checkJiraDraft({ items: [item] }).ok).toBe(true);
    for (const descriptor of descriptors)
      expect(validateToolArguments({ items: [item] }, descriptor)).toEqual({ items: [item] });
  });

  it.each([
    ["missing fields", { ref: item.ref, projectId: item.projectId, issueTypeId: item.issueTypeId }],
    ["top-level summary", { ...item, summary: "Synthetic title" }],
    ["top-level description and labels", { ...item, description: "Synthetic", labels: [] }],
    ["missing summary", { ...item, fields: { description: "Synthetic" } }],
  ])("rejects %s at the catalog boundary before handler work", (_kind, invalid) => {
    expect(checkJiraDraft({ items: [invalid] }).ok).toBe(false);
    for (const descriptor of descriptors)
      expect(() => validateToolArguments({ items: [invalid] }, descriptor)).toThrow(
        "invalid-shape",
      );
  });
});
