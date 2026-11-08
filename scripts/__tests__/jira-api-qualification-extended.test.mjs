import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";
import {
  API_QUALIFICATION_WORKFLOW_CASES,
  workflowReview,
} from "../testing/jira-chat-lab/api-qualification-workflow-cases.mjs";
import { API_QUALIFICATION_SCREEN_CASES } from "../testing/jira-chat-lab/api-qualification-screen-cases.mjs";
import { API_QUALIFICATION_PREFERENCE_CASES } from "../testing/jira-chat-lab/api-qualification-preference-cases.mjs";
import { API_QUALIFICATION_MONITORING_CASES } from "../testing/jira-chat-lab/api-qualification-monitoring-cases.mjs";
import { API_QUALIFICATION_VERSION_LIFECYCLE_CASES } from "../testing/jira-chat-lab/api-qualification-version-lifecycle-cases.mjs";
import { API_QUALIFICATION_ISSUE_LIFECYCLE_CASES } from "../testing/jira-chat-lab/api-qualification-issue-lifecycle-cases.mjs";
import { API_QUALIFICATION_PROJECT_LIFECYCLE_CASES } from "../testing/jira-chat-lab/api-qualification-project-lifecycle-cases.mjs";
import {
  API_QUALIFICATION_SCHEMA_CASES,
  API_QUALIFICATION_SCHEMA_CLEANUP_CASES,
} from "../testing/jira-chat-lab/api-qualification-schema-cases.mjs";
import { API_QUALIFICATION_ASSOCIATION_CASES } from "../testing/jira-chat-lab/api-qualification-association-cases.mjs";
import { fixtureWrite } from "../testing/jira-chat-lab/api-qualification-fixtures.mjs";

const groups = [
  API_QUALIFICATION_WORKFLOW_CASES,
  API_QUALIFICATION_SCREEN_CASES,
  API_QUALIFICATION_PREFERENCE_CASES,
  API_QUALIFICATION_MONITORING_CASES,
  API_QUALIFICATION_VERSION_LIFECYCLE_CASES,
  API_QUALIFICATION_ISSUE_LIFECYCLE_CASES,
  API_QUALIFICATION_PROJECT_LIFECYCLE_CASES,
  API_QUALIFICATION_SCHEMA_CASES,
  API_QUALIFICATION_ASSOCIATION_CASES,
  API_QUALIFICATION_SCHEMA_CLEANUP_CASES,
];
const parent = {
  id: "41",
  draft: false,
  name: "Synthetic scheme",
  description: "Synthetic",
  defaultWorkflow: "jira",
  mappings: [],
};
const version = {
  name: "Synthetic version",
  description: "Synthetic",
  startDate: "2026-11-08",
  releaseDate: "2026-12-01",
  released: false,
  archived: false,
};
const project = { id: "10100", key: "SYN", name: "Synthetic project", archived: false };
const priority = {
  id: "72",
  name: "Synthetic priorities",
  description: "Synthetic",
  optionIds: ["3"],
  defaultOptionId: "3",
  defaultScheme: false,
};
const permission = {
  id: "74",
  name: "Synthetic permissions",
  description: "Synthetic",
  permissions: [],
};
function fixture(tool) {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    projectId: "10000",
    issueTypeId: "10002",
    adminActorKey: "admin-key",
    workflowName: "jira",
    workflowParent: parent,
    workflowPrior: tool.includes("-draft")
      ? { ...parent, id: "42", draft: true, originalDefaultWorkflow: "jira", originalMappings: [] }
      : parent,
    activeWorkflowId: "41",
    ownedWorkflowId: "41",
    qualificationScreenId: "11",
    qualificationScreenName: "Synthetic screen",
    qualificationTabId: "21",
    qualificationTabName: "Synthetic tab",
    qualificationTabs: [
      { id: "20", name: "Original" },
      { id: "21", name: "Synthetic tab" },
    ],
    qualificationField: { id: "customfield_10001", name: "Synthetic field" },
    qualificationFields: [
      { id: "customfield_10001", name: "Synthetic field", type: null, showWhenEmpty: false },
    ],
    defaultScreenField: { id: "customfield_10002", name: "Synthetic default field" },
    clonePrefix: "Clone",
    systemColumns: ["summary", "status"],
    columnsUser: { key: "admin-key", name: "keiko-admin" },
    userColumns: ["status", "summary"],
    readOnlyEnabled: false,
    baseUrl: "http://127.0.0.1:18080",
    sessionHttpsOrigin: "https://127.0.0.1:18443",
    shareScope: "PRIVATE",
    preferenceOriginal: 50,
    preferenceTarget: 100,
    preferenceBefore: 100,
    terminologyBefore: [
      {
        originalName: "epic",
        originalNamePlural: "epics",
        newName: "epic",
        newNamePlural: "epics",
        isDefault: true,
      },
      {
        originalName: "sprint",
        originalNamePlural: "sprints",
        newName: "sprint",
        newNamePlural: "sprints",
        isDefault: true,
      },
    ],
    monitoringBefore: false,
    exposureBefore: tool === "jira.stop-jmx-metrics",
    lifecycleVersionSource: "51",
    lifecycleVersionTarget: "52",
    lifecycleVersionReview: version,
    lifecycleTargetReview: { ...version, name: "Target" },
    lifecycleVersionIds: ["51", "52"],
    lifecycleIssue: {
      id: "10010",
      key: "KEIKO-10",
      summary: "Synthetic issue",
      projectId: "10000",
      issueTypeId: "10002",
    },
    pinCommentId: "61",
    subtasksBefore: [
      { id: "10011", key: "KEIKO-11" },
      { id: "10012", key: "KEIKO-12" },
    ],
    lifecycleProjectId: project.id,
    lifecycleProjectReview:
      tool === "jira.update-project-type" ? { ...project, projectTypeKey: "software" } : project,
    qualificationTypeId: "71",
    qualificationTypeReview: {
      id: "71",
      name: "Synthetic type",
      description: "Synthetic",
      subtask: false,
    },
    optionFieldId: "customfield_10010",
    optionId: "81",
    customFieldBefore: { id: "customfield_10011", name: "Synthetic field", custom: true },
    optionIdForScheme: tool.includes("priority") ? "3" : "10002",
    optionSchemeIds: { priority: "72", "issue-type": "73" },
    optionSchemeReview: tool.includes("priority")
      ? priority
      : {
          id: "73",
          name: "Synthetic types",
          description: "Synthetic",
          issueTypeIds: ["10002"],
          defaultIssueTypeId: "10002",
        },
    schemaProject: { id: project.id, key: project.key, name: project.name },
    schemeProjectsBefore: [],
    associationProject: project,
    associationPriorityBefore: { ...priority, id: "75", defaultScheme: true },
    associationPriorityTarget: priority,
    associationPermissionBefore: { ...permission, id: "0" },
    associationPermissionTarget: permission,
    permissionAttributeSchemeId: "74",
    permissionAttributeKey: "synthetic",
    attributeParent: permission,
    attributeBefore: "true",
  };
}
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function context(responses) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-extended-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const selected = responses(new URL(url));
    expect(selected).toBeDefined();
    return new globalThis.Response(JSON.stringify(selected), { status: 200 });
  });
  return { actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } };
}
it.each(groups.map((cases, index) => [index, cases]))(
  "binds every new case in group %i to a real typed product operation",
  (_index, cases) => {
    const identities = new Set();
    for (const entry of cases) {
      const operation = jiraOperationForTool(entry.tool);
      expect(operation, entry.tool).toBeDefined();
      expect(identities.has(operation.binding.identity), entry.tool).toBe(false);
      identities.add(operation.binding.identity);
      expect(
        describeCatalogSchemaMismatch(
          operation.declaration.descriptor.inputSchema,
          entry.arguments(fixture(entry.tool)),
        ),
        entry.tool,
      ).toBeUndefined();
      expect(operation.definition.effects.includes("remote-write"), entry.tool).toBe(
        entry.mutation === true,
      );
      expect(typeof entry.readback, entry.tool).toBe("function");
      expect(entry, entry.tool).toMatchObject({ actor: "admin", administration: true });
      if (entry.mutation) expect(entry.destructiveAdministration, entry.tool).toBe(true);
    }
  },
);
it("never manufactures a missing native workflow fact as null or an empty mapping", () => {
  const native = {
    id: 41,
    draft: false,
    name: "Synthetic",
    description: null,
    defaultWorkflow: null,
    issueTypeMappings: {},
  };
  expect(workflowReview(native)).toMatchObject({
    id: "41",
    description: null,
    defaultWorkflow: null,
    mappings: [],
  });
  for (const field of Object.keys(native))
    expect(() =>
      workflowReview(Object.fromEntries(Object.entries(native).filter(([key]) => key !== field))),
    ).toThrow();
});
it("reads the draft mapping using its native selector and the actual product field name", async () => {
  const entry = API_QUALIFICATION_WORKFLOW_CASES.find(
    (row) => row.tool === "jira.workflow-scheme-draft-issue-type",
  );
  const ctx = context((url) => {
    expect(url.pathname).toBe("/rest/api/2/workflowscheme/41/draft/issuetype/10002");
    return { issueType: "10002", workflow: "jira" };
  });
  await expect(
    entry.readback(ctx, { issueTypeId: "10002", workflow: "jira" }, fixture(entry.tool)),
  ).resolves.toMatchObject({ matched: true });
});
it("refuses a layout readback that changes an earlier field while adding the requested field", async () => {
  const entry = API_QUALIFICATION_SCREEN_CASES.find(
    (row) => row.tool === "jira.add-screen-tab-field",
  );
  const f = fixture(entry.tool);
  f.qualificationFields = [{ id: "summary", name: "Summary", type: null, showWhenEmpty: null }];
  let changed = false;
  const ctx = context((url) =>
    url.pathname.endsWith("/tabs")
      ? f.qualificationTabs
      : [
          { id: "summary", name: changed ? "Different" : "Summary" },
          { id: f.qualificationField.id, name: f.qualificationField.name },
        ],
  );
  await expect(entry.readback(ctx, {}, f)).resolves.toMatchObject({ matched: true });
  changed = true;
  await expect(entry.readback(ctx, {}, f)).rejects.toThrow();
});
it("requires an explicit native archive flag instead of a missing-value default", async () => {
  const entry = API_QUALIFICATION_ISSUE_LIFECYCLE_CASES.find(
    (row) => row.tool === "jira.archive-issue",
  );
  const f = fixture(entry.tool);
  let includeFlag = true;
  const ctx = context(() => ({
    id: f.lifecycleIssue.id,
    key: f.lifecycleIssue.key,
    fields: {
      summary: f.lifecycleIssue.summary,
      project: { id: f.projectId },
      issuetype: { id: f.issueTypeId },
      ...(includeFlag ? { archived: true } : {}),
    },
  }));
  await expect(entry.readback(ctx, {}, f)).resolves.toMatchObject({ matched: true });
  includeFlag = false;
  await expect(entry.readback(ctx, {}, f)).rejects.toThrow();
});
it("refuses an auxiliary fixture without the governed dispatcher instead of sending HTTP", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(
    fixtureWrite({}, "jira.create", {}, async () => ({ matched: true, assertionCount: 1 })),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
