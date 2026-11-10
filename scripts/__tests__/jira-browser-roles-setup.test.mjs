import { describe, expect, it, vi } from "vitest";
import { seedBrowserRoles } from "../testing/jira-chat-lab/browser-roles-setup.mjs";
import { actorDetails } from "../testing/jira-chat-lab/lab-client.mjs";
import { browserRolePermissionPlan } from "../testing/jira-chat-lab/seed-permissions.mjs";

const NATIVE = {
  project: "830021",
  filter: "920041",
  board: "570031",
  scheme: "640031",
  screen: "450021",
  tab: "450029",
  epicName: "customfield_71011",
  epicLink: "customfield_71012",
  points: "customfield_71013",
  manage: "synthetic.plugin:manage-sprints-native",
  types: { Epic: "301", Story: "307", Task: "311" },
};
const PERMISSIONS = [
  "BROWSE_PROJECTS",
  "CREATE_ISSUES",
  "EDIT_ISSUES",
  "ASSIGN_ISSUES",
  "ASSIGNABLE_USER",
  "TRANSITION_ISSUES",
  "WORK_ISSUES",
  "ADD_COMMENTS",
  "EDIT_OWN_COMMENTS",
  "LINK_ISSUES",
  "RESOLVE_ISSUES",
  "CLOSE_ISSUES",
  "VIEW_VOTERS_AND_WATCHERS",
  "MANAGE_WATCHERS",
  "ADMINISTER_PROJECTS",
  "SCHEDULE_ISSUES",
];
function permissions() {
  return {
    permissions: Object.fromEntries([
      ...PERMISSIONS.map((key) => [key, { key, name: key, type: "PROJECT" }]),
      [NATIVE.manage, { key: NATIVE.manage, name: "Manage Sprints", type: "PROJECT" }],
      ["ADMINISTER", { key: "ADMINISTER", name: "Global administration", type: "GLOBAL" }],
    ]),
  };
}
function actors() {
  return Object.fromEntries(
    ["admin", "projectLead", "developer", "techLead"].map((role) => [
      role,
      {
        key: `synthetic-${role}-key`,
        name: actorDetails(role).name,
        tokenFile: `/private/session/secrets/${role}-token`,
      },
    ]),
  );
}
function initialState(options) {
  return {
    options,
    actors: actors(),
    calls: [],
    snapshots: [],
    issues: new Map(),
    project: undefined,
    filter: undefined,
    board: undefined,
    scope: "GLOBAL",
    screenPoints: false,
    scheme: undefined,
    schemeReads: 0,
  };
}
function boardConfiguration() {
  return {
    id: NATIVE.board,
    type: "scrum",
    filter: { id: NATIVE.filter },
    estimation: { type: "field", field: { fieldId: NATIVE.points } },
  };
}
function fieldInventory(state) {
  const fields = [
    {
      id: NATIVE.epicName,
      schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" },
    },
    {
      id: NATIVE.epicLink,
      schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
    },
  ];
  if (!state.options.noPoints)
    fields.push({
      id: NATIVE.points,
      name: "Story Points",
      schema: {
        type: "number",
        custom: "com.pyxis.greenhopper.jira:jsw-story-points",
      },
    });
  return fields;
}
function createMetadata(state) {
  return {
    isLast: true,
    values: [
      { fieldId: "summary", required: true, schema: { type: "string" } },
      ...(state.screenPoints ? [{ fieldId: NATIVE.points, schema: { type: "number" } }] : []),
    ],
  };
}
function nativePermissions(state, role) {
  const plan = browserRolePermissionPlan(permissions());
  const expected = new Set(plan.byActor[role]);
  return {
    permissions: Object.fromEntries(
      ["ADMINISTER", ...PERMISSIONS, NATIVE.manage].map((key) => [
        key,
        {
          havePermission:
            (state.options.developerAdmin &&
              role === "developer" &&
              key === "ADMINISTER_PROJECTS") ||
            expected.has(key),
        },
      ]),
    ),
  };
}
function readRoutes(state, role) {
  const projectKey = state.project?.key;
  return new Map([
    ["/rest/api/2/permissions", () => permissions()],
    [`/rest/api/2/project/${projectKey}`, () => state.project],
    [
      `/rest/api/2/permissionscheme/${NATIVE.scheme}?expand=permissions`,
      () => {
        state.schemeReads += 1;
        if (state.options.schemeBeforeShare && state.schemeReads === 2)
          state.scheme.permissions.push({
            permission: "BROWSE_PROJECTS",
            holder: { type: "group", parameter: "unexpected-audience" },
          });
        return state.scheme;
      },
    ],
    [`/rest/api/2/project/${projectKey}/permissionscheme`, () => ({ id: NATIVE.scheme })],
    ["/rest/api/2/filter/defaultShareScope", () => ({ scope: state.scope })],
    [`/rest/api/2/filter/${NATIVE.filter}`, () => state.filter],
    [`/rest/agile/1.0/board/${NATIVE.board}`, () => state.board],
    [`/rest/agile/1.0/board/${NATIVE.board}/configuration`, () => boardConfiguration()],
    ["/rest/api/2/field", () => fieldInventory(state)],
    [
      `/rest/api/2/issue/createmeta/${projectKey}/issuetypes?maxResults=100`,
      () => ({
        isLast: true,
        values: Object.entries(NATIVE.types).map(([name, id]) => ({ name, id, subtask: false })),
      }),
    ],
    [`/rest/api/2/screens/${NATIVE.screen}/tabs`, () => [{ id: NATIVE.tab }]],
    [
      `/rest/api/2/screens/${NATIVE.screen}/tabs/${NATIVE.tab}/fields`,
      () => [{ id: "summary" }, ...(state.screenPoints ? [{ id: NATIVE.points }] : [])],
    ],
    ["permissions-for-actor", () => nativePermissions(state, role)],
  ]);
}
function readNative(state, role, path) {
  if (
    path === `/rest/agile/1.0/board/${NATIVE.board}` &&
    role === state.options.inaccessibleBoardRole
  )
    throw new TypeError("Native board access is denied for the selected principal");
  const routes = readRoutes(state, role);
  if (path.startsWith("/rest/api/2/mypermissions?")) return routes.get("permissions-for-actor")();
  if (routes.has(path)) return structuredClone(routes.get(path)());
  if (/\/createmeta\/[^/]+\/issuetypes\/\d+\?/u.test(path)) return createMetadata(state);
  const issue = /^\/rest\/api\/2\/issue\/(\d+)(?:\?fields=\*all|\/editmeta)$/u.exec(path);
  if (issue !== null)
    return path.endsWith("/editmeta")
      ? { fields: { [NATIVE.points]: {} } }
      : structuredClone(state.issues.get(issue[1]));
  throw new TypeError(`Unexpected stub read: ${path}`);
}
function newIssue(state, body) {
  const id = String(990000 + state.issues.size + 1);
  const key = `${state.project.key}-${String(state.issues.size + 1)}`;
  const assignee = body.fields.assignee === null ? null : state.actors.developer;
  const fields = { ...body.fields, project: state.project, assignee };
  state.issues.set(id, { id, key, fields });
  return { id, key };
}
function nativeShareDto(state, permission) {
  if (state.options.nullPrincipals)
    Object.assign(permission, { role: null, group: null, user: null });
  if (state.options.omitProjectKey) Reflect.deleteProperty(permission.project, "key");
  if (state.options.deviatingProjectKey) permission.project.key = "FOREIGN";
  if (state.options.extraPrincipal !== undefined)
    permission[state.options.extraPrincipal.name] = state.options.extraPrincipal.value;
}
function writeRoutes(state, role) {
  return new Map([
    [
      "roles-create-project",
      (body) => {
        state.project = {
          id: NATIVE.project,
          ...body,
          projectTypeKey: "software",
          lead: { name: body.lead },
        };
        return { id: NATIVE.project, key: body.key };
      },
    ],
    [
      "roles-create-permission-scheme",
      (body) => {
        state.scheme = { id: NATIVE.scheme, ...body };
        if (state.options.schemeAtCreation)
          state.scheme.permissions.push({
            permission: "BROWSE_PROJECTS",
            holder: { type: "group", parameter: "unexpected-audience" },
          });
        return state.scheme;
      },
    ],
    ["roles-associate-permission-scheme", () => undefined],
    [
      "roles-private-default",
      (body) => {
        state.scope = body.scope;
      },
    ],
    [
      "roles-create-filter",
      (body) => {
        state.filter = {
          id: NATIVE.filter,
          ...body,
          owner: state.actors[role],
          sharePermissions: state.options.publicFilter ? [{ type: "global" }] : [],
        };
        return state.filter;
      },
    ],
    [
      "roles-share-filter",
      (body) => {
        state.schemeAtShare = structuredClone(state.scheme);
        const permission = {
          id: "960051",
          type: "project",
          view: true,
          edit: false,
          project: { id: NATIVE.project, key: state.project.key },
        };
        expect(body).toEqual({
          type: "project",
          projectId: NATIVE.project,
          view: true,
          edit: false,
        });
        nativeShareDto(state, permission);
        state.filter.sharePermissions = [permission];
        if (state.options.shareAudience === "global") permission.type = "global";
        if (state.options.shareAudience === "group") permission.type = "group";
        if (state.options.shareAudience === "other-project") permission.project.id = "830099";
        if (state.options.shareAudience === "project-role") permission.role = { id: "15" };
        if (state.options.shareAudience === "duplicate")
          state.filter.sharePermissions.push(structuredClone(permission));
        if (state.options.schemeAfterShare)
          state.scheme.permissions.push({
            permission: "BROWSE_PROJECTS",
            holder: { type: "user", parameter: "unexpected-user" },
          });
        return permission;
      },
    ],
    [
      "roles-create-board",
      (body) => {
        state.board = { id: NATIVE.board, ...body };
        return state.board;
      },
    ],
    [
      "screen-add",
      () => {
        state.screenPoints = true;
      },
    ],
    ["roles-create-issue", (body) => newIssue(state, body)],
  ]);
}
function requestNative(state, path) {
  if (path === "/rest/api/2/screens")
    return {
      status: 200,
      value: {
        values: [{ id: NATIVE.screen, name: `${state.project.key}: Synthetic issue screen` }],
      },
    };
  if (path.startsWith("/rest/agile/1.0/board?"))
    return { status: 200, value: { values: [state.board] } };
  if (path.endsWith("/configuration")) return { status: 200, value: boardConfiguration() };
  if (path.startsWith("/rest/api/2/project/")) return { status: 404 };
  throw new TypeError(`Unexpected stub request: ${path}`);
}
function fixture(options = {}) {
  const state = initialState(options);
  const group = { id: "01234567-89ab-4cde-8fab-0123456789ab" };
  const persist = vi.fn(() => {
    state.snapshots.push(structuredClone(group));
  });
  const ports = {
    ensureActor: vi.fn(async (role) => state.actors[role]),
    forActor: (role) => ({
      request: async (_method, path) => requestNative(state, path),
      call: async (name, method, path, body) => {
        state.calls.push({ role, name, method, path, body: structuredClone(body) });
        if (method === "GET") return readNative(state, role, path);
        expect(state.snapshots.at(-1).rolesSetup.currentIntent).toMatchObject({
          actor: role,
          name,
          method,
          path,
        });
        const run = writeRoutes(state, role).get(name);
        if (run === undefined) throw new TypeError(`Unexpected stub write: ${name}`);
        const result = run(body);
        if (options.unclear === name)
          throw new TypeError("Synthetic acknowledgement lost after native effect");
        return structuredClone(result);
      },
    }),
  };
  const run = () =>
    seedBrowserRoles({ directory: "/private/session" }, group, persist, {
      ports,
      now: () => Date.UTC(2026, 10, 8, 12),
    });
  return { state, group, persist, ports, run };
}

describe("model-free browser role setup", () => {
  it("seeds a fresh Scrum project and cohort board with native identities and exact role fixtures", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.project).toMatchObject({
      id: NATIVE.project,
      key: expect.stringMatching(/^ZR[A-F\d]{8}$/u),
    });
    expect(result.board.id).toBe(NATIVE.board);
    expect(result.epics).toHaveLength(2);
    expect(result.stories.map((issue) => issue.storyPoints)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.stories[0].assigneeKey).toBe(f.state.actors.developer.key);
    expect(result.stories.slice(1).every((issue) => issue.assigneeKey === undefined)).toBe(true);
    expect(result.stories.slice(0, 4).every((issue) => issue.epicKey === result.epics[0].key)).toBe(
      true,
    );
    expect(result.stories.slice(4).every((issue) => issue.epicKey === result.epics[1].key)).toBe(
      true,
    );
    expect(result.task.issueType).toBe("Task");
    expect(result.storyPointsField.id).toBe(NATIVE.points);
    expect(f.state.screenPoints).toBe(true);
    expect(f.state.issues.size).toBe(11);
    expect(f.state.filter.sharePermissions).toHaveLength(1);
    expect(f.state.filter.owner.key).toBe(f.state.actors.admin.key);
    expect(f.group.rolesSetup.phase).toBe("ready");
    expect(f.group.rolesSetup.currentIntent).toBeUndefined();
    expect(
      f.state.calls.some((call) => /\/rest\/agile\/1\.0\/sprint|timetracking/iu.test(call.path)),
    ).toBe(false);
    expect(JSON.stringify(f.state.snapshots)).not.toContain("Bearer ");
    await expect(f.run()).rejects.toThrow("already started");
  });
  it("shares only the exact project cohort and verifies board access through all three PATs and the admin oracle", async () => {
    const f = fixture();
    await f.run();
    const share = f.state.calls.filter((call) => call.name === "roles-share-filter");
    expect(share).toEqual([
      {
        role: "admin",
        name: "roles-share-filter",
        method: "POST",
        path: `/rest/api/2/filter/${NATIVE.filter}/permission`,
        body: { type: "project", projectId: NATIVE.project, view: true, edit: false },
      },
    ]);
    expect(f.state.filter.owner).toEqual(f.state.actors.admin);
    expect(f.state.filter.sharePermissions).toEqual([
      {
        id: "960051",
        type: "project",
        view: true,
        edit: false,
        project: { id: NATIVE.project, key: f.state.project.key },
      },
    ]);
    const reads = f.state.calls.filter((call) => call.name === "roles-verify-board-access");
    expect(reads.map((call) => call.role)).toEqual([
      "admin",
      "projectLead",
      "developer",
      "techLead",
    ]);
    expect(
      reads.every(
        (call) => call.method === "GET" && call.path === `/rest/agile/1.0/board/${NATIVE.board}`,
      ),
    ).toBe(true);
    expect(f.state.scheme).toEqual(f.state.schemeAtShare);
    const grants = f.state.scheme.permissions;
    const browse = grants.filter((grant) => grant.permission === "BROWSE_PROJECTS");
    expect(browse.map((grant) => grant.holder)).toEqual(
      ["admin", "projectLead", "developer", "techLead"].map((role) => ({
        type: "user",
        parameter: f.state.actors[role].name,
      })),
    );
    expect(
      grants
        .filter((grant) => grant.permission === NATIVE.manage)
        .map((grant) => grant.holder.parameter),
    ).toEqual([f.state.actors.admin.name, f.state.actors.projectLead.name]);
    expect(
      f.state.calls.filter((call) => call.name === "roles-create-permission-scheme"),
    ).toHaveLength(1);
    expect(
      f.state.calls.some(
        (call) => call.name === "roles-share-filter" && call.role === "projectLead",
      ),
    ).toBe(false);
  });
  it.each([false, true])(
    "accepts native null recipient fields with optional project key omitted=%s",
    async (omitProjectKey) => {
      const f = fixture({ nullPrincipals: true, omitProjectKey });
      await expect(f.run()).resolves.toHaveProperty("board.id", NATIVE.board);
      expect(f.state.filter.sharePermissions[0]).toMatchObject({
        role: null,
        group: null,
        user: null,
        project: { id: NATIVE.project },
      });
      expect(
        f.state.calls.filter((call) => call.name === "roles-verify-board-access"),
      ).toHaveLength(4);
    },
  );
  it.each([
    { name: "role", value: {} },
    { name: "role", value: { id: "15" } },
    { name: "group", value: {} },
    { name: "group", value: { name: "foreign" } },
    { name: "user", value: {} },
    { name: "user", value: { name: "foreign" } },
  ])("refuses an additional native principal $name=$value", async (extraPrincipal) => {
    const f = fixture({ extraPrincipal });
    await expect(f.run()).rejects.toThrow("exact project cohort");
    expect(f.state.board).toBeUndefined();
  });
  it("refuses a deviating native project key when the optional key is present", async () => {
    const f = fixture({ deviatingProjectKey: true });
    await expect(f.run()).rejects.toThrow("exact project cohort");
    expect(f.state.board).toBeUndefined();
  });
  it.each(["admin", "projectLead", "developer", "techLead"])(
    "refuses inaccessible native board access for %s before seeding issues",
    async (role) => {
      const f = fixture({ inaccessibleBoardRole: role });
      await expect(f.run()).rejects.toThrow("board access");
      expect(f.state.issues.size).toBe(0);
      expect(f.group.rolesSetup.phase).not.toBe("ready");
    },
  );
  it.each(["global", "group", "other-project", "project-role", "duplicate"])(
    "refuses unexpected %s filter sharing before creating the board",
    async (shareAudience) => {
      const f = fixture({ shareAudience });
      await expect(f.run()).rejects.toThrow("exact project cohort");
      expect(f.state.board).toBeUndefined();
    },
  );
  it.each(["schemeBeforeShare", "schemeAfterShare"])(
    "refuses permission audience drift at %s without widening grants",
    async (option) => {
      const f = fixture({ [option]: true });
      await expect(f.run()).rejects.toThrow("exact requested scheme");
      expect(f.state.board).toBeUndefined();
      expect(f.state.calls.filter((call) => call.name === "roles-share-filter")).toHaveLength(
        option === "schemeBeforeShare" ? 0 : 1,
      );
    },
  );
  it("verifies exact created grants before associating the scheme", async () => {
    const f = fixture({ schemeAtCreation: true });
    await expect(f.run()).rejects.toThrow("exact requested scheme");
    expect(f.state.calls.some((call) => call.name === "roles-associate-permission-scheme")).toBe(
      false,
    );
    expect(f.state.filter).toBeUndefined();
  });
  it("retains a durable intent after a native commit loses its acknowledgement and never retries", async () => {
    const f = fixture({ unclear: "roles-create-board" });
    await expect(f.run()).rejects.toThrow("acknowledgement lost");
    expect(f.state.board).toBeDefined();
    expect(f.group.rolesSetup.currentIntent).toMatchObject({
      name: "roles-create-board",
      actor: "admin",
    });
    const calls = f.state.calls.length;
    await expect(f.run()).rejects.toThrow("already started");
    expect(f.state.calls).toHaveLength(calls);
    expect(f.ports.ensureActor).toHaveBeenCalledTimes(4);
  });
  it("persists only closed PAT intent metadata and retains uncertainty without replay", async () => {
    const f = fixture();
    f.ports.ensureActor.mockImplementation(async (role, lifecycle) => {
      if (role !== "developer") return f.state.actors[role];
      await lifecycle.beforeWrite({
        actor: role,
        name: "create-pat",
        method: "POST",
        path: "/rest/pat/latest/tokens",
        authorization: "synthetic-authorization-must-not-persist",
        body: { apiToken: "synthetic-private-value-must-not-persist" },
      });
      throw new TypeError("Synthetic PAT acknowledgement unavailable");
    });

    await expect(f.run()).rejects.toThrow("PAT acknowledgement unavailable");
    expect(f.group.rolesSetup.currentIntent).toEqual({
      actor: "developer",
      name: "create-pat",
      method: "POST",
      path: "/rest/pat/latest/tokens",
    });
    const saved = JSON.stringify(f.state.snapshots);
    expect(saved).not.toContain("synthetic-authorization-must-not-persist");
    expect(saved).not.toContain("synthetic-private-value-must-not-persist");
    await expect(f.run()).rejects.toThrow("already started");
    expect(f.state.calls).toHaveLength(0);
  });
  it("refuses a shared filter before creating its board", async () => {
    const f = fixture({ publicFilter: true });
    await expect(f.run()).rejects.toThrow("not privately owned");
    expect(f.state.board).toBeUndefined();
  });
  it("requires native Story Points and never falls back to time tracking", async () => {
    const f = fixture({ noPoints: true });
    await expect(f.run()).rejects.toThrow("real Story Points field");
    expect(f.state.issues.size).toBe(0);
    expect(
      f.state.calls.some((call) => /timetracking|timeoriginalestimate/iu.test(call.path)),
    ).toBe(false);
  });
  it("refuses unexpectedly privileged developer permissions before creating a filter or board", async () => {
    const f = fixture({ developerAdmin: true });
    await expect(f.run()).rejects.toThrow("do not isolate");
    expect(f.state.filter).toBeUndefined();
    expect(f.state.board).toBeUndefined();
  });
});

describe("observed native browser role permissions", () => {
  it("resolves a plugin-defined Manage Sprints key and isolates administrative grants", () => {
    const plan = browserRolePermissionPlan(permissions());
    expect(plan.manageSprintsKey).toBe(NATIVE.manage);
    expect(plan.byActor.projectLead).toEqual(
      expect.arrayContaining([NATIVE.manage, "SCHEDULE_ISSUES", "ADMINISTER_PROJECTS"]),
    );
    expect(plan.byActor.developer).toEqual(
      expect.arrayContaining(["WORK_ISSUES", "CREATE_ISSUES", "LINK_ISSUES", "MANAGE_WATCHERS"]),
    );
    expect(plan.byActor.developer).not.toEqual(expect.arrayContaining([NATIVE.manage]));
    expect(plan.byActor.developer).not.toContain("ADMINISTER_PROJECTS");
    expect(plan.byActor.techLead).toEqual(
      expect.arrayContaining(["EDIT_ISSUES", "LINK_ISSUES", "ADMINISTER_PROJECTS"]),
    );
    expect(plan.byActor.techLead).not.toContain(NATIVE.manage);
    expect(Object.values(plan.byActor).flat()).not.toContain("ADMINISTER");
  });
  it("rejects missing or ambiguous native sprint permission metadata instead of guessing a key", () => {
    const absent = permissions();
    expect(Reflect.deleteProperty(absent.permissions, NATIVE.manage)).toBe(true);
    expect(() => browserRolePermissionPlan(absent)).toThrow("missing or ambiguous");
    const ambiguous = permissions();
    ambiguous.permissions["another-plugin:sprint"] = {
      key: "another-plugin:sprint",
      name: "Manage Sprints",
      type: "PROJECT",
    };
    expect(() => browserRolePermissionPlan(ambiguous)).toThrow("missing or ambiguous");
  });
  it("gives the three PAT seed identities separate existing-lab owners", () => {
    expect(actorDetails("projectLead").name).toBe("keiko-project-lead");
    expect(actorDetails("developer").name).toBe("keiko-developer");
    expect(actorDetails("techLead").name).toBe("keiko-tech-lead");
    expect(actorDetails("api").passwordFile).toBe("api-user-password");
    expect(() => actorDetails("unknown-role")).toThrow();
  });
});
