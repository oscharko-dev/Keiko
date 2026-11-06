import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parseJiraDraft,
  parseJiraDraftReference,
  resolveJiraDraftArguments,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  JIRA_DRAFT_ID_PATTERN,
  JIRA_DRAFT_REF_PATTERN,
  JIRA_FIELD_ID_PATTERN,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  describeCatalogSchemaMismatch,
  validateToolArguments,
} from "@oscharko-dev/keiko-tool-catalog";
import { buildUiHandlerDeps } from "../deps.js";
import { createJiraChatCatalogRuntime } from "./jiraChatCatalogRuntime.js";
import { JIRA_MUTATION_DECLARATIONS } from "./jiraManagedMutationDescriptors.js";
import { KNOWLEDGE_DOCUMENTS_TOOL, KNOWLEDGE_REVIEW_TOOL } from "../requirementsToolName.js";

// Preserve the previously admitted catalog exactly; only the two scoped Knowledge additions join it.
const ORIGINAL_TOOL_ALIASES = [
  "jira_projects",
  "jira_issue_types",
  "jira_create_fields",
  "jira_edit_fields",
  "jira_search",
  "jira_issue",
  "jira_comments",
  "jira_transitions",
  "jira_assignable_users",
  "jira_report",
  "jira_draft_stage",
  "jira_create",
  "jira_edit",
  "jira_assign",
  "jira_comment",
  "jira_transition",
  "jira_draft",
  "jira_attach",
  "knowledge_requirements",
] as const;

const ITEM = {
  ref: "task",
  projectId: "10000",
  issueTypeId: "10001",
  fields: { summary: "Synthetic task" },
};
const REFERENCE = {
  draftId: "b0e5678a-2974-4a6b-a56c-9e74fc989a85",
  draftDigest: "a".repeat(64),
};
const CASES: readonly (readonly [string, CatalogJsonObject, boolean])[] = [
  ["inline items", { items: [ITEM] }, true],
  ["a saved or continuing draft reference", REFERENCE, true],
  ["empty arguments", {}, false],
  ["empty items", { items: [] }, false],
  ["null items", { items: null }, false],
  ["only the draft id", { draftId: REFERENCE.draftId }, false],
  ["only the digest", { draftDigest: REFERENCE.draftDigest }, false],
  ["mixed inline and reference", { items: [ITEM], ...REFERENCE }, false],
  ["stage append arguments", { items: [ITEM], draftId: REFERENCE.draftId }, false],
  ["human selection in inline arguments", { items: [ITEM], selectedRefs: ["task"] }, false],
  ["human selection in reference arguments", { ...REFERENCE, selectedRefs: ["task"] }, false],
  ["invalid draft id", { ...REFERENCE, draftId: "invalid" }, false],
  ["uppercase digest", { ...REFERENCE, draftDigest: "A".repeat(64) }, false],
  ["an invented execute flag", { ...REFERENCE, execute: true }, false],
  ["an invented continue flag", { ...REFERENCE, continue: true }, false],
];
const PATTERNS = [
  {
    name: "item references",
    pattern: JIRA_DRAFT_REF_PATTERN,
    maxLength: 32,
    values: ["a", "Z0", "a-b_c", "a".repeat(32), "a".repeat(33), "1a", "_a", "a.", "ä", "a\n"],
    args: (ref: string): CatalogJsonObject => ({ items: [{ ...ITEM, ref }] }),
  },
  {
    name: "relation field ids",
    pattern: JIRA_FIELD_ID_PATTERN,
    maxLength: 64,
    values: [
      "parent",
      "a9",
      "a".repeat(64),
      "a".repeat(65),
      "customfield_1",
      "customfield_" + "1".repeat(16),
      "customfield_" + "1".repeat(17),
      "customfield_a1",
      "1a",
      "parent\n",
    ],
    args: (fieldId: string): CatalogJsonObject => ({
      items: [{ ...ITEM, parent: { fieldId, issueKey: "SYN-1" } }],
    }),
  },
  {
    name: "saved draft ids",
    pattern: JIRA_DRAFT_ID_PATTERN,
    maxLength: 36,
    values: [
      REFERENCE.draftId,
      "00000000-0000-0000-0000-000000000000",
      REFERENCE.draftId.toUpperCase(),
      REFERENCE.draftId.replaceAll("-", ""),
      "a".repeat(36),
      REFERENCE.draftId + "\n",
    ],
    args: (draftId: string): CatalogJsonObject => ({ ...REFERENCE, draftId }),
  },
];

const root = mkdtempSync(join(tmpdir(), "keiko-jira-input-contract-"));
const deps = buildUiHandlerDeps({
  configPath: undefined,
  evidenceDir: join(root, "evidence"),
  uiDbPath: join(root, "ui.db"),
  env: { KEIKO_STATE_DIR: root },
});
const runtime = createJiraChatCatalogRuntime(deps, {
  primary: { write: vi.fn() },
  diagnostics: { record: vi.fn() },
});
const descriptor = JIRA_MUTATION_DECLARATIONS.find(
  (entry) => entry.name === "jira.draft",
)?.descriptor;

function parameters(alias: string): CatalogJsonObject {
  const schema = runtime.toolDefinitions().find((tool) => tool.name === alias)?.parameters;
  if (schema === undefined) throw new Error("Missing Jira tool definition");
  return schema as CatalogJsonObject;
}

beforeAll(async () => {
  await runtime.get(); // Admit the same declarations through the real managed MCP SDK host.
});
afterAll(async () => {
  await runtime.close();
  await deps.dispose?.();
  rmSync(root, { recursive: true, force: true });
});

describe("the Jira draft schema actually offered to Chat", () => {
  it("imports and offers the staged UUID conjunction with the exact native identifier grammar", () => {
    for (const value of PATTERNS.find((fixture) => fixture.name === "saved draft ids")?.values ??
      []) {
      const accepted = new RegExp(JIRA_DRAFT_ID_PATTERN).test(value);
      expect(
        describeCatalogSchemaMismatch(parameters("jira_draft_stage"), {
          draftId: value,
          items: [ITEM],
        }) === undefined,
        value,
      ).toBe(accepted);
    }
  });

  it("offers only the four canonical lowercase document-scope widths through real MCP schemas", () => {
    for (const width of Array.from({ length: 40 }, (_, index) => index + 1)) {
      const documentScope = "a".repeat(width);
      const accepted = [8, 16, 24, 32].includes(width);
      for (const alias of ["knowledge_documents", "knowledge_review", "knowledge_requirements"]) {
        const args =
          alias === "knowledge_requirements"
            ? { documents: [documentScope] }
            : {
                ...(alias === "knowledge_documents" ? { view: "read" } : {}),
                documentScope,
                revisionDigest: "0".repeat(64),
              };
        expect(
          describeCatalogSchemaMismatch(parameters(alias), args) === undefined,
          `${alias}:${String(width)}`,
        ).toBe(accepted);
      }
    }
    for (const documentScope of ["g".repeat(8), "A".repeat(16), "a".repeat(8) + "\n"]) {
      expect(
        describeCatalogSchemaMismatch(parameters("knowledge_review"), {
          documentScope,
          revisionDigest: "0".repeat(64),
        }),
      ).toBeDefined();
    }
  });

  it.each(CASES)("matches the handler's root forms: %s", (_label, args, accepted) => {
    const handlerAccepts =
      parseJiraDraft(args) !== undefined || parseJiraDraftReference(args) !== undefined;
    expect(handlerAccepts).toBe(accepted);
    expect(describeCatalogSchemaMismatch(parameters("jira_draft"), args) === undefined).toBe(
      accepted,
    );
    if (descriptor === undefined) throw new Error("Missing Jira draft descriptor");
    if (accepted) expect(validateToolArguments(args, descriptor)).toEqual(args);
    else expect(() => validateToolArguments(args, descriptor)).toThrow();
  });

  it("preserves the declared union in the model projection without changing the other tools", () => {
    expect(ORIGINAL_TOOL_ALIASES).toHaveLength(19);
    expect([KNOWLEDGE_DOCUMENTS_TOOL, KNOWLEDGE_REVIEW_TOOL]).toEqual([
      "knowledge.documents",
      "knowledge.review",
    ]);
    const addedAliases = [KNOWLEDGE_DOCUMENTS_TOOL, KNOWLEDGE_REVIEW_TOOL].map((name) =>
      name.replaceAll(".", "_"),
    );
    expect(
      runtime
        .toolDefinitions()
        .map((tool) => tool.name)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual([...ORIGINAL_TOOL_ALIASES, ...addedAliases].sort());
    expect(parameters("jira_draft")).toEqual(descriptor?.inputSchema);
    expect(parameters("jira_draft").oneOf).toHaveLength(2);
    expect(parameters("jira_create")).toMatchObject({
      required: ["fields", "issueTypeId", "projectId"],
      properties: {
        projectId: { type: "string", pattern: "^[0-9]{1,32}$" },
        issueTypeId: { type: "string", pattern: "^[0-9]{1,32}$" },
        fields: { type: "object", additionalProperties: true },
      },
    });
    expect(parameters("jira_create_fields")).toMatchObject({
      required: ["issueTypeId", "projectKey"],
      properties: {
        projectKey: { type: "string" },
        issueTypeId: { type: "string", pattern: "^[0-9]{1,32}$" },
      },
    });
  });

  it("leaves an unknown, syntactically valid saved reference to the existing runtime guard", () => {
    expect(describeCatalogSchemaMismatch(parameters("jira_draft"), REFERENCE)).toBeUndefined();
    const lookup = vi.fn(() => undefined);
    expect(resolveJiraDraftArguments(REFERENCE, lookup)).toEqual({
      ok: false,
      reason: "draft-not-found",
    });
    expect(lookup).toHaveBeenCalledWith(REFERENCE.draftId);
  });

  it.each(PATTERNS)("retains the existing bounded patterns for $name", (fixture) => {
    for (const value of fixture.values) {
      const accepted = value.length <= fixture.maxLength && new RegExp(fixture.pattern).test(value);
      expect(
        describeCatalogSchemaMismatch(parameters("jira_draft"), fixture.args(value)) === undefined,
        value,
      ).toBe(accepted);
    }
  });

  it.each(["ref", "projectId", "issueTypeId", "fields"])(
    "still requires item property %s",
    (key) => {
      const item = Object.fromEntries(Object.entries(ITEM).filter(([name]) => name !== key));
      expect(
        describeCatalogSchemaMismatch(parameters("jira_draft"), {
          items: [item],
        }),
      ).toBeDefined();
    },
  );
});
