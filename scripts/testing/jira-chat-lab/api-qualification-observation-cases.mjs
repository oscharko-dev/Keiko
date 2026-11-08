// Independent field projections are authored here, not imported from the provider's codecs.
import { readCase } from "./api-qualification-cases.mjs";

const single = { nativeRoot: "single", productRoot: "single" };
const page = () => ({ maxResults: 100 });
const project = () => ({ projectIdOrKey: "KEIKO", maxResults: 100 });
const issue = (fixture) => ({ issueIdOrKey: fixture.issueKeys[0], maxResults: 100 });
const issuePath = (fixture, suffix) => `/rest/api/2/issue/${fixture.issueKeys[0]}/${suffix}`;
const users = ["key", "name", "active"];
const primitive = (tool, path, field) =>
  readCase(tool, path, [field], {
    productRoot: "single",
    nativeRoot: (value) => [{ [field]: value }],
  });
const avatars = (value) => [
  ...value.system.map((entry) => ({ ...entry, category: "system" })),
  ...value.custom.map((entry) => ({ ...entry, category: "custom" })),
];
const fieldRows = (value) =>
  Object.entries(value.fields).map(([fieldId, field]) => ({ ...field, fieldId }));

export const API_QUALIFICATION_OBSERVATION_CASES = [
  readCase("jira.fields", "/rest/api/2/field", ["id", "name"], { args: page }),
  readCase(
    "jira.issue-types",
    "/rest/api/2/issue/createmeta/KEIKO/issuetypes?startAt=0&maxResults=100",
    ["id", "name", "subtask"],
    {
      args: () => ({ projectKey: "KEIKO", maxResults: 100 }),
      nativeRoot: "values",
    },
  ),
  readCase(
    "jira.create-fields",
    (f) =>
      `/rest/api/2/issue/createmeta/KEIKO/issuetypes/${f.issueTypeId}?startAt=0&maxResults=100`,
    ["fieldId", "name", "required"],
    {
      args: (f) => ({ projectKey: "KEIKO", issueTypeId: f.issueTypeId, maxResults: 100 }),
      nativeRoot: "values",
    },
  ),
  readCase("jira.edit-fields", (f) => issuePath(f, "editmeta"), ["fieldId", "name", "required"], {
    args: (f) => ({ issueKey: f.issueKeys[0], maxResults: 100 }),
    nativeRoot: fieldRows,
  }),
  readCase(
    "jira.issue-type-alternatives",
    (f) => `/rest/api/2/issuetype/${f.issueTypeId}/alternatives`,
    ["id", "name", "subtask"],
    {
      args: (f) => ({ issueTypeId: f.issueTypeId, maxResults: 100 }),
    },
  ),
  readCase(
    "jira.assignable-users",
    "/rest/api/2/user/assignable/search?project=KEIKO&username=keiko&startAt=0&maxResults=100",
    ["name", "active"],
    {
      args: () => ({ projectKey: "KEIKO", query: "keiko", maxResults: 100 }),
    },
  ),
  readCase(
    "jira.multi-project-assignable-users",
    "/rest/api/2/user/assignable/multiProjectSearch?projectKeys=KEIKO&username=keiko&maxResults=100",
    users,
    {
      args: () => ({ projectKeys: ["KEIKO"], query: "keiko", maxResults: 100 }),
    },
  ),
  readCase(
    "jira.permission-users",
    "/rest/api/2/user/permission/search?permissions=BROWSE_PROJECTS&projectKey=KEIKO&username=keiko&startAt=0&maxResults=100",
    users,
    {
      args: () => ({
        projectKey: "KEIKO",
        query: "keiko",
        permissions: ["BROWSE_PROJECTS"],
        startAt: 0,
        maxResults: 100,
      }),
    },
  ),
  readCase(
    "jira.browse-permission-users",
    "/rest/api/2/user/viewissue/search?projectKey=KEIKO&username=keiko&maxResults=100",
    users,
    {
      args: () => ({ projectKey: "KEIKO", query: "keiko", maxResults: 100 }),
    },
  ),
  readCase(
    "jira.project-picker",
    "/rest/api/2/projects/picker?query=KEIKO&maxResults=100",
    ["id", "key", "name"],
    {
      args: () => ({ query: "KEIKO", maxResults: 100 }),
      nativeRoot: "projects",
    },
  ),
  readCase(
    "jira.project-permissions",
    "/rest/api/2/mypermissions?projectKey=KEIKO",
    ["key", "havePermission"],
    {
      args: () => ({ projectIdOrKey: "KEIKO" }),
      nativeRoot: "permissions",
      productRoot: "permissions",
    },
  ),
  readCase("jira.permission-schemes", "/rest/api/2/permissionscheme", ["id", "name"], {
    args: page,
    nativeRoot: "permissionSchemes",
  }),
  readCase("jira.issue-security-schemes", "/rest/api/2/issuesecurityschemes", ["id", "name"], {
    args: page,
    nativeRoot: "issueSecuritySchemes",
  }),
  readCase(
    "jira.notification-schemes",
    "/rest/api/2/notificationscheme?startAt=0&maxResults=50",
    ["id", "name"],
    {
      args: () => ({ maxResults: 50 }),
      nativeRoot: "values",
    },
  ),
  readCase("jira.issue-type-schemes", "/rest/api/2/issuetypescheme", ["id", "name"], {
    args: page,
    nativeRoot: "schemes",
  }),
  readCase(
    "jira.priority-schemes",
    "/rest/api/2/priorityschemes?startAt=0&maxResults=100",
    ["id", "name"],
    {
      args: page,
      nativeRoot: "schemes",
    },
  ),
  readCase(
    "jira.custom-fields",
    "/rest/api/2/customFields?startAt=0&maxResults=100",
    ["id", "name"],
    {
      args: page,
      nativeRoot: "values",
    },
  ),
  readCase(
    "jira.component-page",
    "/rest/api/2/component/page?startAt=0&maxResults=100",
    ["id", "name"],
    {
      args: page,
      nativeRoot: "values",
    },
  ),
  readCase(
    "jira.global-version-page",
    "/rest/api/2/version?startAt=0&maxResults=100",
    ["versionId", "name"],
    {
      args: page,
      nativeRoot: "values",
      nativeNames: { versionId: "id" },
    },
  ),
  readCase(
    "jira.project-version-page",
    "/rest/api/2/project/KEIKO/version?startAt=0&maxResults=100",
    ["versionId", "name"],
    {
      args: project,
      nativeRoot: "values",
      nativeNames: { versionId: "id" },
    },
  ),
  readCase(
    "jira.password-policy",
    "/rest/api/2/password/policy?hasOldPassword=false",
    ["requirement"],
    {
      args: () => ({ hasOldPassword: false, maxResults: 100 }),
      nativeRoot: (value) => value.map((requirement) => ({ requirement })),
    },
  ),
  readCase(
    "jira.duplicate-user-count",
    "/rest/api/2/user/duplicated/count?flush=false",
    ["count"],
    single,
  ),
  readCase("jira.duplicate-users", "/rest/api/2/user/duplicated/list?flush=false", ["username"], {
    args: page,
    nativeRoot: (value) => Object.keys(value).map((username) => ({ username })),
  }),
  readCase("jira.email-template-types", "/rest/api/2/email-templates/types", ["id", "eventName"], {
    args: page,
    nativeRoot: "emailTypes",
  }),
  readCase("jira.app-monitoring", "/rest/api/2/monitoring/app", ["enabled"], single),
  readCase("jira.ipd-monitoring", "/rest/api/2/monitoring/ipd", ["enabled"], single),
  readCase("jira.cluster-nodes", "/rest/api/2/cluster/nodes", ["nodeId", "state"], { args: page }),
  readCase("jira.cluster-upgrade-state", "/rest/api/2/cluster/zdu/state", ["state"], single),
  readCase("jira.index-snapshots", "/rest/api/2/index-snapshot", ["absolutePath"], { args: page }),
  readCase(
    "jira.index-snapshot-status",
    "/rest/api/2/index-snapshot/isRunning",
    ["running"],
    single,
  ),
  primitive("jira.jmx-metrics-exposed", "/rest/api/2/monitoring/jmx/areMetricsExposed", "exposed"),
  primitive(
    "jira.search-max-aggregation-buckets",
    "/rest/api/2/searchLimits/maxAggregationBuckets",
    "limit",
  ),
  primitive("jira.search-max-result-window", "/rest/api/2/searchLimits/maxResultWindow", "limit"),
  readCase("jira.system-columns", "/rest/api/2/settings/columns", ["value"], { args: page }),
  readCase("jira.user-columns", "/rest/api/2/user/columns", ["value"], { args: page }),
  readCase("jira.accessibility-settings", "/rest/api/2/user/a11y/personal-settings", ["key"], {
    args: page,
  }),
  readCase("jira.system-avatars", "/rest/api/2/avatar/user/system", ["id", "category"], {
    args: () => ({ avatarType: "user", maxResults: 100 }),
    nativeRoot: avatars,
  }),
  readCase("jira.project-avatars", "/rest/api/2/project/KEIKO/avatars", ["id", "category"], {
    args: project,
    nativeRoot: avatars,
  }),
  readCase("jira.user-avatars", "/rest/api/2/user/avatars?username=keiko-api", ["id", "category"], {
    args: () => ({ username: "keiko-api", maxResults: 100 }),
    nativeRoot: avatars,
  }),
  readCase(
    "jira.avatars",
    (f) => `/rest/api/2/universal_avatar/type/project/owner/${f.projectId}`,
    ["id", "category"],
    {
      args: (f) => ({ avatarType: "project", owningObjectId: f.projectId, maxResults: 100 }),
      nativeRoot: avatars,
    },
  ),
  readCase(
    "jira.role-default-actors",
    (f) => `/rest/api/2/role/${f.roleId}/actors`,
    ["id", "type"],
    {
      args: (f) => ({ roleId: f.roleId, maxResults: 100 }),
      nativeRoot: "actors",
    },
  ),
  readCase("jira.project-statuses", "/rest/api/2/project/KEIKO/statuses", ["id", "name"], {
    args: project,
  }),
  readCase("jira.issue-property-keys", (f) => issuePath(f, "properties"), ["key"], {
    args: issue,
    nativeRoot: (value) => value.keys,
  }),
  readCase(
    "jira.issue-type-property-keys",
    (f) => `/rest/api/2/issuetype/${f.issueTypeId}/properties`,
    ["key"],
    {
      args: (f) => ({ issueTypeId: f.issueTypeId, maxResults: 100 }),
      nativeRoot: (value) => value.keys,
    },
  ),
  readCase("jira.project-property-keys", "/rest/api/2/project/KEIKO/properties", ["key"], {
    args: project,
    nativeRoot: (value) => value.keys,
  }),
  readCase("jira.user-property-keys", "/rest/api/2/user/properties?username=keiko-api", ["key"], {
    args: () => ({ username: "keiko-api", maxResults: 100 }),
    nativeRoot: (value) => value.keys,
  }),
  readCase("jira.subtasks", (f) => issuePath(f, "subtask"), ["id", "key"], { args: issue }),
  readCase(
    "jira.subtask-move-availability",
    (f) => issuePath(f, "subtask/move"),
    ["canReorderSubtasks"],
    {
      args: (f) => ({ issueIdOrKey: f.issueKeys[0] }),
      productRoot: "single",
      nativeRoot: (value) => [{ canReorderSubtasks: value }],
    },
  ),
  readCase("jira.remote-links", (f) => issuePath(f, "remotelink"), ["id"], { args: issue }),
  readCase("jira.favourite-filters", "/rest/api/2/filter/favourite", ["id", "name"], {
    args: page,
  }),
].map((entry) => ({ ...entry, actor: "admin", administration: true }));
