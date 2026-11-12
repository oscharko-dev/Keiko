// Native reads select existing fixture identities; only the governed provider qualifies them.
import assert from "./api-qualification-assert.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { basicAuth, labRequest } from "./lab-client.mjs";

const single = { nativeRoot: "single", productRoot: "single" };
const page = () => ({ maxResults: 100 });
const project = () => ({ projectIdOrKey: "KEIKO" });
const id = (f, key) => {
  assert.match(f[key], /^(?:0|[1-9][0-9]{0,18})$/u);
  return f[key];
};
function selecting(specification, key, path, select) {
  return {
    ...specification,
    prepare: async (context, fixture) => {
      const response = await labRequest(
        context.session,
        "GET",
        typeof path === "function" ? path(fixture) : path,
        basicAuth(context.session, context.actor),
      );
      assert.equal(response.status, 200);
      const selected = select(response.value);
      assert.notEqual(selected, undefined, "An existing native fixture identity is required");
      fixture[key] = String(selected);
      id(fixture, key);
      await specification.prepare?.(context, fixture);
    },
  };
}
const permission = (specification) =>
  selecting(
    specification,
    "permissionSchemeId",
    "/rest/api/2/project/KEIKO/permissionscheme",
    (value) => value.id,
  );
const workflow = (specification) =>
  selecting(
    specification,
    "workflowSchemeId",
    "/rest/api/2/project/KEIKO/workflowscheme",
    (value) => value.id,
  );
const issueTypeScheme = (specification) =>
  selecting(
    specification,
    "issueTypeSchemeId",
    "/rest/api/2/issuetypescheme",
    (value) => value.schemes[0]?.id,
  );
const priority = (specification) =>
  selecting(
    specification,
    "prioritySchemeId",
    "/rest/api/2/priorityschemes?startAt=0&maxResults=100",
    (value) => value.schemes[0]?.id,
  );
const screen = (specification) =>
  selecting(
    specification,
    "screenId",
    "/rest/api/2/screens?startAt=0&maxResults=100",
    (value) => value.screens[0]?.id,
  );

export const API_QUALIFICATION_CONFIGURATION_CASES = [
  readCase(
    "jira.application-properties",
    "/rest/api/2/application-properties?key=jira.clone.prefix",
    ["key", "stringValue"],
    {
      args: () => ({ key: "jira.clone.prefix" }),
      productRoot: "single",
      nativeRoot: (value) => (Array.isArray(value) ? value : [value]),
      nativeNames: { stringValue: "value" },
    },
  ),
  readCase(
    "jira.advanced-settings",
    "/rest/api/2/application-properties/advanced-settings",
    ["key"],
    { args: page },
  ),
  readCase(
    "jira.project-type",
    "/rest/api/2/project/type/software/accessible",
    ["projectTypeKey", "name"],
    {
      ...single,
      args: () => ({ projectTypeKey: "software" }),
      nativeNames: { projectTypeKey: "key", name: "formattedKey" },
    },
  ),
  readCase(
    "jira.pinned-comments",
    (f) => `/rest/api/2/issue/${f.issueKeys[0]}/pinned-comments`,
    ["id", "body"],
    {
      args: (f) => ({ issueIdOrKey: f.issueKeys[0], maxResults: 100 }),
    },
  ),
  readCase(
    "jira.group-user-picker",
    "/rest/api/2/groupuserpicker?query=keiko&maxResults=100",
    ["name", "kind"],
    {
      args: () => ({ query: "keiko", maxResults: 100 }),
      nativeRoot: (value) => [
        ...value.users.users.map((user) => ({ name: user.name, kind: "user" })),
        ...value.groups.groups.map((group) => ({ name: group.name, kind: "group" })),
      ],
      productRoot: (value) => [
        ...value.users.map((user) => ({ name: user.name, kind: "user" })),
        ...value.groups.map((group) => ({ name: group.name, kind: "group" })),
      ],
    },
  ),
  readCase(
    "jira.project-permission-scheme",
    "/rest/api/2/project/KEIKO/permissionscheme",
    ["id", "name"],
    {
      ...single,
      args: project,
    },
  ),
  readCase(
    "jira.project-priority-scheme",
    "/rest/api/2/project/KEIKO/priorityscheme",
    ["id", "name"],
    {
      ...single,
      args: project,
    },
  ),
  readCase(
    "jira.project-workflow-scheme",
    "/rest/api/2/project/KEIKO/workflowscheme",
    ["id", "name", "defaultWorkflow"],
    {
      ...single,
      args: project,
    },
  ),
  readCase(
    "jira.project-notification-scheme",
    "/rest/api/2/project/KEIKO/notificationscheme",
    ["id", "name"],
    {
      nativeRoot: "single",
      args: project,
    },
  ),
  readCase(
    "jira.project-security-levels",
    "/rest/api/2/project/KEIKO/securitylevel",
    ["id", "name"],
    {
      args: () => ({ ...project(), maxResults: 100 }),
      nativeRoot: "levels",
    },
  ),
  permission(
    readCase(
      "jira.permission-scheme",
      (f) => `/rest/api/2/permissionscheme/${id(f, "permissionSchemeId")}`,
      ["id", "name"],
      {
        ...single,
        args: (f) => ({ schemeId: id(f, "permissionSchemeId") }),
      },
    ),
  ),
  permission(
    readCase(
      "jira.permission-grants",
      (f) => `/rest/api/2/permissionscheme/${id(f, "permissionSchemeId")}/permission`,
      ["id", "permission", "holder"],
      {
        args: (f) => ({ schemeId: id(f, "permissionSchemeId"), maxResults: 100 }),
        // Jira's holder contains ancillary expanded metadata. Compare only native type/parameter facts.
        productRoot: (data) =>
          data.items.map((row) => ({
            ...row,
            holder: { type: row.holder.type, parameter: row.holder.parameter ?? null },
          })),
        nativeRoot: (data) =>
          data.permissions.map((row) => ({
            ...row,
            holder: { type: row.holder.type, parameter: row.holder.parameter ?? null },
          })),
      },
    ),
  ),
  permission(
    selecting(
      readCase(
        "jira.permission-grant",
        (f) =>
          `/rest/api/2/permissionscheme/${id(f, "permissionSchemeId")}/permission/${id(f, "permissionGrantId")}`,
        ["id", "permission"],
        {
          ...single,
          args: (f) => ({
            schemeId: id(f, "permissionSchemeId"),
            permissionId: id(f, "permissionGrantId"),
          }),
        },
      ),
      "permissionGrantId",
      (f) => `/rest/api/2/permissionscheme/${id(f, "permissionSchemeId")}/permission`,
      (value) => value.permissions[0]?.id,
    ),
  ),
  selecting(
    readCase(
      "jira.notification-scheme",
      (f) => `/rest/api/2/notificationscheme/${id(f, "notificationSchemeId")}`,
      ["id", "name"],
      {
        nativeRoot: "single",
        args: (f) => ({ schemeId: id(f, "notificationSchemeId") }),
      },
    ),
    "notificationSchemeId",
    "/rest/api/2/notificationscheme?startAt=0&maxResults=100",
    (value) => value.values[0]?.id,
  ),
  priority(
    readCase(
      "jira.priority-scheme",
      (f) => `/rest/api/2/priorityschemes/${id(f, "prioritySchemeId")}`,
      ["id", "name"],
      {
        ...single,
        args: (f) => ({ schemeId: id(f, "prioritySchemeId") }),
      },
    ),
  ),
  issueTypeScheme(
    readCase(
      "jira.issue-type-scheme",
      (f) => `/rest/api/2/issuetypescheme/${id(f, "issueTypeSchemeId")}`,
      ["id", "name"],
      {
        args: (f) => ({ schemeId: id(f, "issueTypeSchemeId") }),
        nativeRoot: "single",
      },
    ),
  ),
  issueTypeScheme(
    readCase(
      "jira.issue-type-scheme-projects",
      (f) => `/rest/api/2/issuetypescheme/${id(f, "issueTypeSchemeId")}/associations`,
      ["id", "key", "name"],
      {
        args: (f) => ({ schemeId: id(f, "issueTypeSchemeId"), maxResults: 100 }),
      },
    ),
  ),
  workflow(
    readCase(
      "jira.workflow-scheme",
      (f) => `/rest/api/2/workflowscheme/${id(f, "workflowSchemeId")}`,
      ["id", "name", "defaultWorkflow"],
      {
        ...single,
        args: (f) => ({ schemeId: id(f, "workflowSchemeId"), maxResults: 100 }),
      },
    ),
  ),
  workflow(
    readCase(
      "jira.workflow-scheme-default",
      (f) => `/rest/api/2/workflowscheme/${id(f, "workflowSchemeId")}/default`,
      ["workflow"],
      {
        ...single,
        args: (f) => ({ schemeId: id(f, "workflowSchemeId") }),
      },
    ),
  ),
  workflow(
    readCase(
      "jira.workflow-scheme-issue-type",
      (f) => `/rest/api/2/workflowscheme/${id(f, "workflowSchemeId")}/issuetype/${f.issueTypeId}`,
      ["issueTypeId"],
      {
        ...single,
        args: (f) => ({ schemeId: id(f, "workflowSchemeId"), issueTypeId: f.issueTypeId }),
        nativeNames: { issueTypeId: "issueType" },
        optionalFields: ["workflow"],
      },
    ),
  ),
  workflow(
    readCase(
      "jira.workflow-scheme-workflows",
      (f) => `/rest/api/2/workflowscheme/${id(f, "workflowSchemeId")}/workflow`,
      ["workflow"],
      {
        args: (f) => ({ schemeId: id(f, "workflowSchemeId"), maxResults: 100 }),
      },
    ),
  ),
  screen(
    readCase(
      "jira.screen-tabs",
      (f) => `/rest/api/2/screens/${id(f, "screenId")}/tabs`,
      ["id", "name"],
      {
        args: (f) => ({ screenId: id(f, "screenId"), maxResults: 100 }),
      },
    ),
  ),
  screen(
    readCase(
      "jira.screen-available-fields",
      (f) => `/rest/api/2/screens/${id(f, "screenId")}/availableFields`,
      ["id", "name"],
      {
        args: (f) => ({ screenId: id(f, "screenId"), maxResults: 100 }),
      },
    ),
  ),
  screen(
    selecting(
      readCase(
        "jira.screen-tab-fields",
        (f) => `/rest/api/2/screens/${id(f, "screenId")}/tabs/${id(f, "tabId")}/fields`,
        ["id", "name"],
        {
          args: (f) => ({ screenId: id(f, "screenId"), tabId: id(f, "tabId"), maxResults: 100 }),
        },
      ),
      "tabId",
      (f) => `/rest/api/2/screens/${id(f, "screenId")}/tabs`,
      (value) => value[0]?.id,
    ),
  ),
  selecting(
    readCase(
      "jira.link-type",
      (f) => `/rest/api/2/issueLinkType/${id(f, "linkTypeId")}`,
      ["id", "name", "inward", "outward"],
      {
        ...single,
        args: (f) => ({ linkTypeId: id(f, "linkTypeId") }),
      },
    ),
    "linkTypeId",
    "/rest/api/2/issueLinkType",
    (value) => value.issueLinkTypes[0]?.id,
  ),
].map((entry) => ({ ...entry, actor: "admin", administration: true }));
