import assert from "node:assert/strict";
import { read, proof, assertNoRecord } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import {
  adminMutationCase,
  observeAdminActor,
  nativeSnapshot,
} from "./api-qualification-admin-cases.mjs";
import { createQualificationProject } from "./api-qualification-fixtures.mjs";

export function issueTypeReview(value) {
  return {
    ...nativeSnapshot(value, ["id", "name", "description", "subtask"]),
    ...(value.avatarId === undefined ? {} : { avatarId: String(value.avatarId) }),
  };
}
const actor = (f) => ({ expectedActorKey: f.adminActorKey });
const title = (f, label) => `AC7 ${label} ${f.runId}`;
const typePath = (f) => `/rest/api/2/issuetype/${f.qualificationTypeId}`;
async function type(c, f) {
  await observeAdminActor(c, f);
  f.qualificationTypeReview = issueTypeReview(await read(c, typePath(f)));
}
export const OPTION_SCHEMES = [
  {
    kind: "issue-type",
    path: "issuetypescheme",
    ids: "issueTypeIds",
    defaultId: "defaultIssueTypeId",
    values: "/rest/api/2/issuetype",
  },
  {
    kind: "priority",
    path: "priorityschemes",
    ids: "optionIds",
    defaultId: "defaultOptionId",
    values: "/rest/api/2/priority",
  },
];
export function optionSchemeReview(value, spec) {
  const result = nativeSnapshot(value, ["id", "name", "description", spec.ids, spec.defaultId]);
  assert.ok(Array.isArray(result[spec.ids]) && result[spec.ids].length > 0);
  result[spec.ids] = result[spec.ids].map(String);
  result[spec.defaultId] = String(result[spec.defaultId]);
  if (spec.kind === "priority") {
    assert.equal(typeof value.defaultScheme, "boolean");
    result.defaultScheme = value.defaultScheme;
  }
  return result;
}
const schemePath = (f, spec) => `/rest/api/2/${spec.path}/${f.optionSchemeIds[spec.kind]}`;
async function scheme(c, f, spec) {
  await observeAdminActor(c, f);
  f.optionSchemeReview = optionSchemeReview(await read(c, schemePath(f, spec)), spec);
}
function optionCases(spec) {
  return [
    adminMutationCase(
      `jira.create-${spec.kind}-scheme`,
      (f) => ({
        ...actor(f),
        name: title(f, spec.kind),
        description: "Synthetic AC7 scheme",
        [spec.ids]: [f.optionIdForScheme],
        [spec.defaultId]: f.optionIdForScheme,
      }),
      async (c, data, f) => {
        assert.match(data.schemeId, /^[1-9][0-9]*$/u);
        (f.optionSchemeIds ??= {})[spec.kind] = data.schemeId;
        const actual = optionSchemeReview(await read(c, schemePath(f, spec)), spec);
        assert.equal(actual.name, title(f, spec.kind));
        assert.equal(actual.description, "Synthetic AC7 scheme");
        assert.deepEqual(actual[spec.ids], [f.optionIdForScheme]);
        assert.equal(actual[spec.defaultId], f.optionIdForScheme);
        return proof(5);
      },
      async (c, f) => {
        await observeAdminActor(c, f);
        const options = await read(c, spec.values);
        assert.ok(Array.isArray(options) && options.length > 0);
        const selected =
          spec.kind === "issue-type"
            ? options.find((row) => String(row.id) === f.issueTypeId && row.subtask === false)
            : options[0];
        assert.ok(selected);
        f.optionIdForScheme = String(selected.id);
      },
    ),
    updateOptionCase(spec),
  ];
}
function updateOptionCase(spec) {
  return adminMutationCase(
    `jira.update-${spec.kind}-scheme`,
    (f) => ({
      ...actor(f),
      expectedScheme: f.optionSchemeReview,
      name: title(f, spec.kind),
      description: "Synthetic AC7 revised scheme",
      [spec.ids]: f.optionSchemeReview[spec.ids],
      [spec.defaultId]: f.optionSchemeReview[spec.defaultId],
    }),
    async (c, _data, f) => {
      assert.deepEqual(optionSchemeReview(await read(c, schemePath(f, spec)), spec), {
        ...f.optionSchemeReview,
        description: "Synthetic AC7 revised scheme",
      });
      return proof(6);
    },
    (c, f) => scheme(c, f, spec),
  );
}
function deleteOptionSchemeCase(spec) {
  return adminMutationCase(
    `jira.delete-${spec.kind}-scheme`,
    (f) => ({
      ...actor(f),
      expectedScheme: f.optionSchemeReview,
      confirmUnverifiedConsequences: true,
    }),
    async (c, _data, f) => {
      const value = await read(c, `/rest/api/2/${spec.path}?startAt=0&maxResults=100`);
      assert.ok(Array.isArray(value.schemes));
      if (value.total !== undefined) assert.equal(value.total, value.schemes.length);
      return assertNoRecord(value.schemes, f.optionSchemeReview.id);
    },
    (c, f) => scheme(c, f, spec),
  );
}
async function associations(c, f) {
  await scheme(c, f, OPTION_SCHEMES[0]);
  f.schemeProjectsBefore = (await read(c, `${schemePath(f, OPTION_SCHEMES[0])}/associations`)).map(
    (row) => nativeSnapshot(row, ["id", "key", "name"]),
  );
}
function associationCase(action, present) {
  return adminMutationCase(
    `jira.${action}-issue-type-scheme-project${action === "remove" ? "" : "s"}`,
    (f) => ({
      ...actor(f),
      expectedScheme: f.optionSchemeReview,
      expectedProjects: f.schemeProjectsBefore,
      projects: action === "clear" ? [] : [f.schemaProject],
      confirmUnverifiedConsequences: true,
    }),
    async (c, _data, f) => {
      const actual = await read(c, `${schemePath(f, OPTION_SCHEMES[0])}/associations`);
      assert.deepEqual(
        actual.map((row) => nativeSnapshot(row, ["id", "key", "name"])),
        present ? [f.schemaProject] : [],
      );
      assert.deepEqual(
        optionSchemeReview(await read(c, schemePath(f, OPTION_SCHEMES[0])), OPTION_SCHEMES[0]),
        f.optionSchemeReview,
      );
      return proof(3);
    },
    async (c, f) => {
      await associations(c, f);
      if (action === "add") {
        assert.deepEqual(f.schemeProjectsBefore, []);
        f.schemaProject = nativeSnapshot(
          await createQualificationProject(c, f, "scheme associations"),
          ["id", "key", "name"],
        );
      } else assert.ok(f.schemaProject?.id);
    },
  );
}
const optionFixture = async (c, f) => {
  await observeAdminActor(c, f);
  assert.match(f.optionFieldId, /^customfield_[1-9][0-9]*$/u);
  assert.match(f.optionId, /^[1-9][0-9]*$/u);
  const fields = await read(c, "/rest/api/2/field");
  assert.equal(fields.filter((row) => row.id === f.optionFieldId && row.custom === true).length, 1);
};
export const API_QUALIFICATION_SCHEMA_CASES = [
  adminMutationCase(
    "jira.create-issue-type",
    (f) => ({
      ...actor(f),
      name: title(f, "issue type"),
      description: "Synthetic AC7 issue type",
      type: "standard",
    }),
    async (c, data, f) => {
      assert.match(data.issueTypeId, /^[1-9][0-9]*$/u);
      f.qualificationTypeId = data.issueTypeId;
      const value = issueTypeReview(await read(c, typePath(f)));
      assert.equal(value.name, title(f, "issue type"));
      assert.equal(value.description, "Synthetic AC7 issue type");
      assert.equal(value.subtask, false);
      return proof(4);
    },
  ),
  adminMutationCase(
    "jira.update-issue-type",
    (f) => ({
      ...actor(f),
      expectedIssueType: f.qualificationTypeReview,
      description: "Synthetic AC7 revised type",
    }),
    async (c, _data, f) => {
      assert.deepEqual(issueTypeReview(await read(c, typePath(f))), {
        ...f.qualificationTypeReview,
        description: "Synthetic AC7 revised type",
      });
      return proof(5);
    },
    type,
  ),
  adminMutationCase(
    "jira.delete-issue-type",
    (f) => ({
      ...actor(f),
      expectedIssueType: f.qualificationTypeReview,
      expectedAlternative: null,
      confirmUnverifiedMigration: true,
    }),
    async (c, _data, f) => {
      const rows = await read(c, "/rest/api/2/issuetype");
      assert.ok(Array.isArray(rows));
      return assertNoRecord(rows, f.qualificationTypeReview.id);
    },
    type,
  ),
  adminMutationCase(
    "jira.create-custom-field",
    (f) => ({
      ...actor(f),
      name: title(f, "custom field"),
      description: "Synthetic AC7 field",
      type: "com.atlassian.jira.plugin.system.customfieldtypes:textfield",
      searcherKey: "com.atlassian.jira.plugin.system.customfieldtypes:textsearcher",
      projectIds: [f.projectId],
      issueTypeIds: [f.issueTypeId],
    }),
    async (c, data, f) => {
      assert.match(data.fieldId, /^customfield_[1-9][0-9]*$/u);
      f.qualificationCustomFieldId = data.fieldId;
      const found = (await read(c, "/rest/api/2/field")).filter((row) => row.id === data.fieldId);
      assert.equal(found.length, 1);
      assert.equal(found[0].name, title(f, "custom field"));
      assert.equal(found[0].custom, true);
      return proof(4);
    },
  ),
  {
    ...readCase(
      "jira.custom-field-option",
      (f) => `/rest/api/2/customFieldOption/${f.optionId}`,
      ["id", "value"],
      { args: (f) => ({ optionId: f.optionId }), nativeRoot: "single", productRoot: "single" },
    ),
    actor: "admin",
    administration: true,
    prepare: optionFixture,
  },
  {
    ...readCase(
      "jira.custom-field-options",
      (f) =>
        `/rest/api/2/customFields/${f.optionFieldId.slice(12)}/options?page=1&maxResults=100&useAllContexts=true`,
      ["id", "value"],
      {
        args: (f) => ({
          customFieldId: f.optionFieldId.slice(12),
          page: 1,
          maxResults: 100,
          useAllContexts: true,
        }),
        nativeRoot: "values",
      },
    ),
    actor: "admin",
    administration: true,
    prepare: optionFixture,
  },
  adminMutationCase(
    "jira.delete-custom-fields",
    (f) => ({
      ...actor(f),
      expectedFields: [f.customFieldBefore],
      confirmUnverifiedDeletion: true,
    }),
    async (c, _data, f) => {
      const rows = await read(c, "/rest/api/2/field");
      assert.ok(Array.isArray(rows));
      return assertNoRecord(rows, f.customFieldBefore.id);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const rows = (await read(c, "/rest/api/2/field")).filter(
        (row) => row.id === f.qualificationCustomFieldId,
      );
      assert.equal(rows.length, 1);
      f.customFieldBefore = nativeSnapshot(rows[0], ["id", "name", "custom"]);
      assert.equal(f.customFieldBefore.custom, true);
    },
  ),
  ...OPTION_SCHEMES.flatMap(optionCases),
  associationCase("add", true),
  associationCase("remove", false),
  associationCase("set", true),
  associationCase("clear", false),
];
export const API_QUALIFICATION_SCHEMA_CLEANUP_CASES = OPTION_SCHEMES.map(deleteOptionSchemeCase);
