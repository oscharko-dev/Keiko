import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  API_QUALIFICATION_SCHEMA_CASES,
  OPTION_SCHEMES,
  optionSchemeReview,
} from "../testing/jira-chat-lab/api-qualification-schema-cases.mjs";
import { API_QUALIFICATION_WORKFLOW_CASES } from "../testing/jira-chat-lab/api-qualification-workflow-cases.mjs";
import { API_QUALIFICATION_ASSOCIATION_CASES } from "../testing/jira-chat-lab/api-qualification-association-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const issueScheme = OPTION_SCHEMES.find((entry) => entry.kind === "issue-type");
const priorityScheme = OPTION_SCHEMES.find((entry) => entry.kind === "priority");
const nativeIssueScheme = () => ({
  id: "73",
  name: "AC7 issue-type raw-native-run",
  description: "Synthetic AC7 scheme",
  issueTypes: [
    { id: "10002", name: "Task", subtask: false },
    { id: "10003", name: "Bug", subtask: false },
  ],
  defaultIssueType: { id: "10003", name: "Bug", subtask: false },
});
const roots = [];
function observeNative(handler) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-foundation-oracles-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const selected = new URL(url);
    const value = selected.pathname.endsWith("/myself")
      ? { name: "keiko-admin", key: "native-admin" }
      : handler(selected);
    expect(value).not.toBeUndefined();
    return new globalThis.Response(JSON.stringify(value), { status: 200 });
  });
  return { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reviews the raw native issue-type DTO and ignores conflicting model-side aliases", () => {
  const raw = { ...nativeIssueScheme(), issueTypeIds: ["999"], defaultIssueTypeId: "999" };
  expect(optionSchemeReview(raw, issueScheme)).toEqual({
    id: "73",
    name: "AC7 issue-type raw-native-run",
    description: "Synthetic AC7 scheme",
    issueTypeIds: ["10002", "10003"],
    defaultIssueTypeId: "10003",
  });
});

it.each(["issue-type", "priority"])(
  "preserves an observed null %s default and description",
  (kind) => {
    const spec = kind === "issue-type" ? issueScheme : priorityScheme;
    const raw =
      kind === "issue-type"
        ? { ...nativeIssueScheme(), description: null, defaultIssueType: null }
        : {
            id: "74",
            name: "Synthetic priorities",
            description: null,
            optionIds: ["3", "1"],
            defaultOptionId: null,
            defaultScheme: false,
          };
    const result = optionSchemeReview(raw, spec);
    expect(result[spec.defaultId]).toBeNull();
    expect(result.description).toBeNull();
    expect(result[spec.ids]).toEqual(kind === "issue-type" ? ["10002", "10003"] : ["3", "1"]);
    expect(Object.values(result)).not.toContain("null");
  },
);

it.each([
  {
    name: "model-side aliases without native fields",
    raw: {
      id: "73",
      name: "Synthetic",
      description: "",
      issueTypeIds: ["10002"],
      defaultIssueTypeId: "10002",
    },
  },
  {
    name: "an omitted default",
    raw: {
      id: "73",
      name: "Synthetic",
      description: "",
      issueTypes: [{ id: "10002", name: "Task" }],
    },
  },
  { name: "a default with no native ID", raw: { ...nativeIssueScheme(), defaultIssueType: {} } },
  {
    name: "a default outside the native membership",
    raw: { ...nativeIssueScheme(), defaultIssueType: { id: "999", name: "Foreign" } },
  },
  {
    name: "an omitted member identity",
    raw: { ...nativeIssueScheme(), issueTypes: [{ name: "Task" }] },
  },
  { name: "a null membership", raw: { ...nativeIssueScheme(), issueTypes: null } },
])("refuses to invent issue-scheme review facts from $name", ({ raw }) => {
  expect(() => optionSchemeReview(raw, issueScheme)).toThrow();
});

it("uses raw native fields for create readback and the next mutation's complete review", async () => {
  let raw = {
    ...nativeIssueScheme(),
    issueTypes: [nativeIssueScheme().issueTypes[0]],
    defaultIssueType: nativeIssueScheme().issueTypes[0],
  };
  const c = observeNative((url) => {
    expect(url.pathname).toBe("/rest/api/2/issuetypescheme/73");
    return raw;
  });
  const f = { runId: "raw-native-run", optionIdForScheme: "10002" };
  const create = API_QUALIFICATION_SCHEMA_CASES.find(
    (entry) => entry.tool === "jira.create-issue-type-scheme",
  );
  await expect(create.readback(c, { schemeId: "73" }, f)).resolves.toMatchObject({ matched: true });
  const update = API_QUALIFICATION_SCHEMA_CASES.find(
    (entry) => entry.tool === "jira.update-issue-type-scheme",
  );
  await update.prepare(c, f);
  expect(update.arguments(f).expectedScheme).toEqual({
    id: "73",
    name: raw.name,
    description: "Synthetic AC7 scheme",
    issueTypeIds: ["10002"],
    defaultIssueTypeId: "10002",
  });
  raw = { ...raw, description: "Synthetic AC7 revised scheme" };
  await expect(update.readback(c, {}, f)).resolves.toMatchObject({ matched: true });
  raw = {
    ...raw,
    issueTypes: [{ id: "999", name: "Foreign" }],
    defaultIssueType: { id: "999", name: "Foreign" },
    issueTypeIds: ["10002"],
    defaultIssueTypeId: "10002",
  };
  await expect(update.readback(c, {}, f)).rejects.toThrow();
});

it("compares native workflow issueTypes with projected issueTypeIds and preserves their order", async () => {
  let raw = [
    { workflow: "Native workflow", issueTypes: ["10002", "10003"], defaultMapping: false },
  ];
  const c = observeNative((url) => {
    expect(url.pathname).toBe("/rest/api/2/workflowscheme/41/draft/workflow");
    return raw;
  });
  const entry = API_QUALIFICATION_WORKFLOW_CASES.find(
    (row) => row.tool === "jira.workflow-scheme-draft-workflows",
  );
  const data = {
    items: [
      { workflow: "Native workflow", issueTypeIds: ["10002", "10003"], defaultMapping: false },
    ],
  };
  await expect(entry.readback(c, data, { activeWorkflowId: "41" })).resolves.toMatchObject({
    matched: true,
  });
  raw = [{ workflow: "Native workflow", issueTypes: ["10003", "10002"], defaultMapping: false }];
  await expect(entry.readback(c, data, { activeWorkflowId: "41" })).rejects.toThrow();
  raw = [{ workflow: "Native workflow", issueTypeIds: ["10002", "10003"], defaultMapping: false }];
  await expect(entry.readback(c, data, { activeWorkflowId: "41" })).rejects.toThrow();
});

it.each([
  {
    cases: API_QUALIFICATION_SCHEMA_CASES,
    tool: "jira.custom-field-option",
    field: "optionFieldId",
  },
  {
    cases: API_QUALIFICATION_SCHEMA_CASES,
    tool: "jira.custom-field-options",
    field: "optionFieldId",
  },
  {
    cases: API_QUALIFICATION_ASSOCIATION_CASES,
    tool: "jira.permission-scheme-attribute",
    field: "permissionAttributeSchemeId",
  },
  {
    cases: API_QUALIFICATION_ASSOCIATION_CASES,
    tool: "jira.set-permission-scheme-attribute",
    field: "permissionAttributeSchemeId",
  },
])(
  "names the required operator fixture when $tool has no $field",
  async ({ cases, tool, field }) => {
    const c = observeNative(() => {
      throw new TypeError("Missing operator fixtures must not dispatch resource reads");
    });
    const entry = cases.find((row) => row.tool === tool);
    await expect(entry.prepare(c, {})).rejects.toThrow(
      new RegExp(`operator-supplied.*${field}`, "u"),
    );
  },
);

it.each([
  {
    cases: API_QUALIFICATION_SCHEMA_CASES,
    tool: "jira.custom-field-option",
    f: { optionFieldId: "customfield_10001" },
    field: "optionId",
  },
  {
    cases: API_QUALIFICATION_ASSOCIATION_CASES,
    tool: "jira.permission-scheme-attribute",
    f: { permissionAttributeSchemeId: "0" },
    field: "permissionAttributeKey",
  },
])(
  "names the missing companion fixture $field without guessing a native identity",
  async ({ cases, tool, f, field }) => {
    const c = observeNative(() => {
      throw new TypeError("Missing operator fixtures must not dispatch resource reads");
    });
    await expect(cases.find((row) => row.tool === tool).prepare(c, f)).rejects.toThrow(
      new RegExp(`operator-supplied.*${field}`, "u"),
    );
  },
);
