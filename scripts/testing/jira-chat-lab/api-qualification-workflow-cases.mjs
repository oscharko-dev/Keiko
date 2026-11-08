// Complete native configurations are reviewed before each governed workflow-scheme operation.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { read, proof, readRecord } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";

function mappings(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.entries(value)
    .map(([issueTypeId, workflow]) => {
      assert.equal(typeof workflow, "string");
      return { issueTypeId, workflow };
    })
    .sort((a, b) => a.issueTypeId.localeCompare(b.issueTypeId));
}
export function workflowReview(value) {
  for (const name of ["id", "name", "description", "defaultWorkflow", "draft", "issueTypeMappings"])
    assert.ok(Object.hasOwn(value, name), "A workflow review cannot invent a missing native fact");
  return {
    id: String(value.id),
    name: value.name,
    description: value.description,
    defaultWorkflow: value.defaultWorkflow,
    draft: value.draft,
    mappings: mappings(value.issueTypeMappings),
    ...(value.draft
      ? {
          originalDefaultWorkflow: value.originalDefaultWorkflow,
          originalMappings: mappings(value.originalIssueTypeMappings),
        }
      : {}),
  };
}
const path = (f, draft) =>
  `/rest/api/2/workflowscheme/${draft ? f.activeWorkflowId : f.ownedWorkflowId}${draft ? "/draft" : ""}`;
async function reviewed(c, f, draft) {
  await observeAdminActor(c, f);
  const parentId = draft ? f.activeWorkflowId : f.ownedWorkflowId;
  f.workflowParent = workflowReview(await read(c, `/rest/api/2/workflowscheme/${parentId}`));
  assert.equal(f.workflowParent.draft, false);
  f.workflowPrior = draft ? workflowReview(await read(c, path(f, true))) : f.workflowParent;
  assert.equal(f.workflowPrior.draft, draft);
}
const args = (f, draft) => ({
  expectedActorKey: f.adminActorKey,
  expectedScheme: f.workflowParent,
  ...(draft ? { expectedDraft: f.workflowPrior } : {}),
});
const selected = (f) => f.workflowName;
function desiredMapping(before, kind, remove, f) {
  if (kind === "default") return { ...before, defaultWorkflow: remove ? null : selected(f) };
  const retained = before.mappings.filter((row) =>
    kind === "issue-type" ? row.issueTypeId !== f.issueTypeId : row.workflow !== selected(f),
  );
  const added = remove ? [] : [{ issueTypeId: f.issueTypeId, workflow: selected(f) }];
  return {
    ...before,
    ...(kind === "workflow" && before.defaultWorkflow === selected(f)
      ? { defaultWorkflow: null }
      : {}),
    mappings: [...retained, ...added].sort((a, b) => a.issueTypeId.localeCompare(b.issueTypeId)),
  };
}
function mappingCase(kind, draft, remove) {
  const tool = `jira.${remove ? "delete" : "set"}-workflow-scheme-${draft ? "draft-" : ""}${kind}`;
  return adminMutationCase(
    tool,
    (f) => ({
      ...args(f, draft),
      ...(kind === "issue-type" ? { issueTypeId: f.issueTypeId } : {}),
      ...(kind === "workflow" || !remove ? { workflowName: selected(f) } : {}),
      ...(kind === "workflow" && !remove
        ? { issueTypeIds: [f.issueTypeId], defaultMapping: false }
        : {}),
    }),
    async (c, _data, f) => {
      const actual = workflowReview(await read(c, path(f, draft)));
      assert.deepEqual(actual, desiredMapping(f.workflowPrior, kind, remove, f));
      return proof(7);
    },
    (c, f) => reviewed(c, f, draft),
  );
}
function updateCase(draft) {
  return adminMutationCase(
    `jira.update-workflow-scheme${draft ? "-draft" : ""}`,
    (f) => ({ ...args(f, draft), description: "Synthetic AC7 workflow revised" }),
    async (c, _data, f) => {
      assert.deepEqual(workflowReview(await read(c, path(f, draft))), {
        ...f.workflowPrior,
        description: "Synthetic AC7 workflow revised",
      });
      return proof(7);
    },
    (c, f) => reviewed(c, f, draft),
  );
}
function deleteCase(draft) {
  return adminMutationCase(
    `jira.delete-workflow-scheme${draft ? "-draft" : ""}`,
    (f) => ({ ...args(f, draft), confirmUnverifiedDeletion: true }),
    async (c, _data, f) => {
      assert.ok(f.workflowPrior.id);
      if (draft) {
        const actual = workflowReview(
          await read(
            c,
            `/rest/api/2/workflowscheme/${f.activeWorkflowId}?returnDraftIfExists=true`,
          ),
        );
        assert.deepEqual(actual, f.workflowParent);
      } else {
        const response = await labRequest(
          c.session,
          "GET",
          path(f, false),
          basicAuth(c.session, c.actor),
        );
        assert.equal(response.status, 404);
      }
      return proof(2);
    },
    (c, f) => reviewed(c, f, draft),
  );
}
const draftRead = (tool, suffix, fields, options = {}) => ({
  ...readCase(
    tool,
    (f) => `${path(f, true)}${typeof suffix === "function" ? suffix(f) : suffix}`,
    fields,
    {
      args: (f) => ({ schemeId: f.activeWorkflowId, ...options.arguments?.(f) }),
      nativeRoot: "single",
      productRoot: "single",
      ...options,
    },
  ),
  actor: "admin",
  administration: true,
});

export const API_QUALIFICATION_WORKFLOW_CASES = [
  adminMutationCase(
    "jira.create-workflow-scheme",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      name: `AC7 workflow ${f.runId}`,
      description: "Synthetic AC7 workflow",
      defaultWorkflow: f.workflowName,
      mappings: [],
    }),
    async (c, data, f) => {
      const value = await readRecord(
        c,
        data.schemeId,
        `/rest/api/2/workflowscheme/${data.schemeId}`,
      );
      f.ownedWorkflowId = data.schemeId;
      const observed = workflowReview(value);
      assert.equal(observed.name, `AC7 workflow ${f.runId}`);
      assert.equal(observed.defaultWorkflow, f.workflowName);
      assert.deepEqual(observed.mappings, []);
      assert.equal(observed.draft, false);
      return proof(5);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const active = await read(c, "/rest/api/2/project/KEIKO/workflowscheme");
      f.activeWorkflowId = String(active.id);
      f.workflowName = active.defaultWorkflow;
      assert.equal(typeof f.workflowName, "string");
    },
  ),
  updateCase(false),
  mappingCase("default", false, true),
  mappingCase("default", false, false),
  mappingCase("issue-type", false, false),
  mappingCase("issue-type", false, true),
  mappingCase("workflow", false, false),
  mappingCase("workflow", false, true),
  deleteCase(false),
  adminMutationCase(
    "jira.create-workflow-scheme-draft",
    (f) => ({ expectedActorKey: f.adminActorKey, expectedScheme: f.workflowParent }),
    async (c, data, f) => {
      const actual = workflowReview(await read(c, path(f, true)));
      assert.equal(actual.id, data.draftSchemeId);
      assert.equal(actual.draft, true);
      assert.equal(actual.name, f.workflowParent.name);
      assert.deepEqual(actual.mappings, f.workflowParent.mappings);
      return proof(4);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.workflowParent = workflowReview(
        await read(c, `/rest/api/2/workflowscheme/${f.activeWorkflowId}`),
      );
      assert.equal(f.workflowParent.draft, false);
      const selectedParent = workflowReview(
        await read(c, `/rest/api/2/workflowscheme/${f.activeWorkflowId}?returnDraftIfExists=true`),
      );
      assert.deepEqual(selectedParent, f.workflowParent);
    },
  ),
  draftRead("jira.workflow-scheme-draft", "", ["id", "name", "defaultWorkflow"]),
  updateCase(true),
  mappingCase("default", true, true),
  mappingCase("default", true, false),
  draftRead("jira.workflow-scheme-draft-default", "/default", ["workflow"]),
  mappingCase("issue-type", true, false),
  draftRead(
    "jira.workflow-scheme-draft-issue-type",
    (f) => `/issuetype/${f.issueTypeId}`,
    ["issueTypeId", "workflow"],
    {
      arguments: (f) => ({ issueTypeId: f.issueTypeId }),
      nativeNames: { issueTypeId: "issueType" },
    },
  ),
  mappingCase("issue-type", true, true),
  mappingCase("workflow", true, false),
  draftRead("jira.workflow-scheme-draft-workflows", "/workflow", ["workflow", "issueTypeIds"], {
    nativeRoot: undefined,
    productRoot: undefined,
  }),
  mappingCase("workflow", true, true),
  deleteCase(true),
];
