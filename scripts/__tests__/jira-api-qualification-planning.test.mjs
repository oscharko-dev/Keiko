import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describeCatalogSchemaMismatch } from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationForTool } from "../../packages/keiko-server/dist/atlassian/jiraManagedProvider.js";
import { API_QUALIFICATION_PLANNING_CASES } from "../testing/jira-chat-lab/api-qualification-planning-cases.mjs";
import { API_QUALIFICATION_APPLICATION_ROLE_CASES } from "../testing/jira-chat-lab/api-qualification-application-role-cases.mjs";
import { DEFAULT_LAB_CONNECTION } from "../testing/jira-chat-lab/lab-client.mjs";

const cases = [...API_QUALIFICATION_PLANNING_CASES, ...API_QUALIFICATION_APPLICATION_ROLE_CASES];
const entry = (tool) => cases.find((item) => item.tool === tool);
const response = (value, status = 200) => ({ value, status });
const actor = { name: "keiko-admin", key: "actor-key" };
const sprint = (id = "15", extra = {}) => ({
  id,
  originBoardId: "13",
  name: `Synthetic sprint ${id}`,
  state: "future",
  synced: false,
  startDate: null,
  endDate: null,
  goal: "Synthetic goal",
  autoStartStop: false,
  incompleteIssuesDestinationId: null,
  ...extra,
});
const role = {
  key: "jira-software",
  groups: ["jira-software-users"],
  defaultGroups: ["jira-software-users"],
};
const issue = {
  id: "17",
  key: "KEIKO-17",
  fields: { project: { id: "10" }, issuetype: { id: "2" }, summary: "Synthetic summary" },
};
function fixture() {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    projectId: "10",
    issueTypeId: "2",
    adminActorKey: actor.key,
    planningBoard: {
      id: "13",
      name: "Synthetic planning board",
      type: "scrum",
      filter: { id: "11" },
      ranking: { rankCustomFieldId: 10019 },
      estimation: { type: "field", field: { fieldId: "customfield_10016" } },
    },
    planningEpic: {
      id: "31",
      key: "KEIKO-31",
      name: "Synthetic epic",
      summary: "Synthetic epic summary",
      done: false,
    },
    planningMember: issue,
    planningRank: {
      fieldId: "customfield_10019",
      direction: "after",
      selected: { id: "17", key: "KEIKO-17", rank: "opaque-first" },
      anchor: { id: "19", key: "KEIKO-19", rank: "opaque-second" },
    },
    planningEstimateIssue: issue,
    planningEstimate: { fieldId: "customfield_10016", value: 1 },
    planningEstimateUnit: "board-number",
    planningEstimateTarget: 2,
    planningSprint: sprint(),
    planningSwapSprint: sprint("16"),
    planningSprintOrder: ["15", "16"],
    planningSyncedSprints: [sprint("21", { synced: true })],
    planningReplacement: {
      name: "Revised sprint",
      state: "future",
      startDate: null,
      endDate: null,
      goal: "Revised goal",
      autoStartStop: false,
      incompleteIssuesDestinationId: null,
    },
    applicationRoleBefore: [role],
    applicationRoleChange: {
      expected: role,
      value: { ...role, groups: ["jira-software-users", "synthetic-empty"] },
    },
  };
}
async function withNative(handler, run) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-ac7-planning-"));
  mkdirSync(join(directory, "secrets"));
  writeFileSync(join(directory, "secrets/admin-password"), "synthetic-admin", { mode: 0o600 });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(options.method).toBe("GET");
    const result = await handler(new URL(url));
    return new globalThis.Response(JSON.stringify(result.value), { status: result.status });
  });
  try {
    return await run({ actor: "admin", session: { ...DEFAULT_LAB_CONNECTION, directory } });
  } finally {
    fetch.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
}
const page = (values) => ({
  startAt: 0,
  maxResults: 100,
  isLast: true,
  total: values.length,
  values,
});

it("covers exactly the 17 assigned native identities with typed arguments and explicit admin scope", () => {
  expect(API_QUALIFICATION_PLANNING_CASES).toHaveLength(15);
  expect(API_QUALIFICATION_APPLICATION_ROLE_CASES).toHaveLength(2);
  expect(cases.map((item) => item.tool)).toEqual([
    "jira.board-epic-issues",
    "jira.epic-remove-issues",
    "jira.epic",
    "jira.epic-update",
    "jira.epic-issues",
    "jira.epic-move-issues",
    "jira.rank-epic",
    "jira.rank-issues",
    "jira.issue-estimation",
    "jira.set-issue-estimation",
    "jira.unmap-sprints",
    "jira.unmap-all-sprints",
    "jira.delete-sprint",
    "jira.replace-sprint",
    "jira.swap-sprints",
    "jira.set-application-roles",
    "jira.set-application-role",
  ]);
  const identities = new Set();
  for (const specification of cases) {
    const operation = jiraOperationForTool(specification.tool);
    expect(operation, specification.tool).toBeDefined();
    expect(identities.has(operation.binding.identity)).toBe(false);
    identities.add(operation.binding.identity);
    expect(
      describeCatalogSchemaMismatch(
        operation.declaration.descriptor.inputSchema,
        specification.arguments(fixture()),
      ),
      specification.tool,
    ).toBeUndefined();
    expect(operation.definition.effects.includes("remote-write"), specification.tool).toBe(
      specification.mutation === true,
    );
    expect(specification).toMatchObject({ actor: "admin", administration: true });
    expect(typeof specification.prepare).toBe("function");
    if (specification.mutation) expect(specification.destructiveAdministration).toBe(true);
  }
  expect(identities.size).toBe(17);
});

it.each(["jira.board-epic-issues", "jira.epic-issues"])(
  "compares %s issue fields to independent native observations",
  async (tool) => {
    await withNative(
      () => response({ issues: [issue], total: 1 }),
      async (context) => {
        const data = { items: [{ id: issue.id, key: issue.key, summary: issue.fields.summary }] };
        await expect(entry(tool).readback(context, data, fixture())).resolves.toMatchObject({
          matched: true,
        });
        data.items[0].summary = "Contradictory summary";
        await expect(entry(tool).readback(context, data, fixture())).rejects.toThrow();
      },
    );
  },
);

it("compares an epic's native identity and mutable fields", async () => {
  const f = fixture();
  await withNative(
    () => response(f.planningEpic),
    async (context) => {
      const data = { items: [f.planningEpic] };
      await expect(entry("jira.epic").readback(context, data, f)).resolves.toMatchObject({
        matched: true,
      });
      await expect(
        entry("jira.epic").readback(context, { items: [{ ...f.planningEpic, done: true }] }, f),
      ).rejects.toThrow();
    },
  );
});

it.each(["jira.epic-remove-issues", "jira.epic-move-issues"])(
  "requires both canonical Epic Link and Agile membership for %s",
  async (tool) => {
    const f = fixture();
    const expected = tool === "jira.epic-remove-issues" ? null : f.planningEpic;
    let link = expected?.key ?? null;
    let membership = expected;
    await withNative(
      (url) => {
        if (url.pathname === "/rest/api/2/field")
          return response([
            {
              id: "customfield_10014",
              schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
            },
          ]);
        if (url.pathname.startsWith("/rest/agile/"))
          return response({ id: issue.id, key: issue.key, fields: { epic: membership } });
        return response({ id: issue.id, key: issue.key, fields: { customfield_10014: link } });
      },
      async (context) => {
        await expect(entry(tool).readback(context, {}, f)).resolves.toMatchObject({
          matched: true,
        });
        link = "KEIKO-999";
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
        link = expected?.key ?? null;
        membership = expected === null ? { id: "999", key: "KEIKO-999" } : null;
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
      },
    );
  },
);

it("requires an actual epic done-state change while preserving the observed identity", async () => {
  const f = fixture();
  let current = { ...f.planningEpic, done: true };
  await withNative(
    () => response(current),
    async (context) => {
      expect(entry("jira.epic-update").arguments(f)).toEqual({ epicIdOrKey: "31", done: true });
      await expect(entry("jira.epic-update").readback(context, {}, f)).resolves.toMatchObject({
        matched: true,
      });
      current = f.planningEpic;
      await expect(entry("jira.epic-update").readback(context, {}, f)).rejects.toThrow();
    },
  );
});

it.each(["jira.rank-epic", "jira.rank-issues"])(
  "requires changed opaque ranks and scoped order for %s without claiming global confirmation",
  async (tool) => {
    const f = fixture();
    let order = ["KEIKO-19", "KEIKO-17"];
    let rank = "opaque-changed";
    await withNative(
      (url) => {
        if (url.pathname.endsWith("/issue")) {
          expect(url.searchParams.get("jql")).toContain("ORDER BY cf[10019] ASC");
          return response({ startAt: 0, total: 2, issues: order.map((key) => ({ key })) });
        }
        const key = url.pathname.split("/").at(-1);
        return response({
          id: key === "KEIKO-17" ? "17" : "19",
          key,
          fields: { customfield_10019: key === "KEIKO-17" ? rank : "opaque-second" },
        });
      },
      async (context) => {
        await expect(entry(tool).readback(context, {}, f)).resolves.toMatchObject({
          matched: true,
          globalRankConfirmed: false,
        });
        rank = f.planningRank.selected.rank;
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
        rank = "opaque-changed";
        order = ["KEIKO-17", "KEIKO-19"];
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
      },
    );
  },
);

it("matches estimation identity/value to both native resources and preserves observed null", async () => {
  const f = fixture();
  let value = 1;
  let coreFields = { customfield_10016: value };
  await withNative(
    (url) =>
      response(
        url.pathname.endsWith("/estimation")
          ? { fieldId: "customfield_10016", value }
          : { id: issue.id, key: issue.key, fields: coreFields },
      ),
    async (context) => {
      const data = {
        boardId: "13",
        issueId: issue.id,
        issueKey: issue.key,
        fieldId: "customfield_10016",
        value: 1,
      };
      await expect(
        entry("jira.issue-estimation").readback(context, data, f),
      ).resolves.toMatchObject({ matched: true });
      await expect(
        entry("jira.issue-estimation").readback(context, { ...data, value: 2 }, f),
      ).rejects.toThrow();
      value = null;
      coreFields = { customfield_10016: null };
      const withoutValue = { ...data };
      delete withoutValue.value;
      await expect(
        entry("jira.issue-estimation").readback(context, withoutValue, f),
      ).resolves.toMatchObject({ matched: true });
      coreFields = {};
      await expect(
        entry("jira.issue-estimation").readback(context, withoutValue, f),
      ).rejects.toThrow();
    },
  );
});

it.each([
  ["board-number", "customfield_10016", 2, "2"],
  ["minutes", "timeoriginalestimate", 120, "2"],
])(
  "uses exact native %s estimation units and refuses contradictory readback",
  async (unit, fieldId, target, argument) => {
    const f = fixture();
    Object.assign(f, {
      planningEstimateUnit: unit,
      planningEstimateTarget: target,
      planningEstimate: { fieldId, value: 1 },
    });
    let value = target;
    await withNative(
      (url) =>
        response(
          url.pathname.endsWith("/estimation")
            ? { fieldId, value }
            : { id: issue.id, key: issue.key, fields: { [fieldId]: value } },
        ),
      async (context) => {
        expect(entry("jira.set-issue-estimation").arguments(f).value).toBe(argument);
        await expect(
          entry("jira.set-issue-estimation").readback(context, {}, f),
        ).resolves.toMatchObject({ matched: true });
        value = 0;
        await expect(entry("jira.set-issue-estimation").readback(context, {}, f)).rejects.toThrow();
      },
    );
  },
);

it("creates an authentic Epic fixture through the governed hook using native type and field identities", async () => {
  const f = fixture();
  delete f.planningEpic;
  let created;
  let nativeEpic;
  await withNative(
    (url) => {
      if (url.pathname.endsWith("/myself")) return response(actor);
      if (url.pathname.endsWith("/configuration")) return response(f.planningBoard);
      if (url.pathname.endsWith("/project/KEIKO"))
        return response({ id: "10", issueTypes: [{ id: "7", name: "Epic", subtask: false }] });
      if (url.pathname.endsWith("/field"))
        return response([
          {
            id: "customfield_10011",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-label" },
          },
        ]);
      return response(url.pathname.includes("/epic/") ? nativeEpic : created);
    },
    async (context) => {
      const writes = [];
      context.qualificationFixture = async (request) => {
        writes.push(request);
        expect(request.tool).toBe("jira.create");
        expect(request.arguments.issueTypeId).toBe("7");
        expect(request.arguments.fields.customfield_10011).toContain("AC7 planning epic");
        created = {
          id: "41",
          key: "KEIKO-41",
          fields: { ...request.arguments.fields, project: { id: "10" }, issuetype: { id: "7" } },
        };
        nativeEpic = {
          id: 41,
          key: created.key,
          name: request.arguments.fields.customfield_10011,
          summary: created.fields.summary,
          done: false,
        };
        await request.readback(context, { issueKey: created.key });
      };
      await entry("jira.epic").prepare(context, f);
      expect(writes).toHaveLength(1);
      expect(f.planningEpic).toEqual(nativeEpic);
      expect(entry("jira.epic").arguments(f)).toEqual({ epicIdOrKey: "41" });
    },
  );
});

it.each([
  ["customfield_10016", "board-number", 1, "3"],
  ["timeoriginalestimate", "minutes", 60, "2"],
])(
  "seeds an observed nonempty %s estimate through governed issue creation before planning a different target",
  async (fieldId, unit, value, typeId) => {
    const f = fixture();
    f.planningBoard.estimation.field.fieldId = fieldId;
    let created;
    let omitValue = false;
    await withNative(
      (url) => {
        if (url.pathname.endsWith("/myself")) return response(actor);
        if (url.pathname.endsWith("/configuration")) return response(f.planningBoard);
        if (url.pathname.endsWith("/field"))
          return response([
            { id: fieldId, schema: unit === "minutes" ? { system: fieldId } : { type: "number" } },
          ]);
        if (url.pathname.endsWith("/project/KEIKO"))
          return response({
            id: "10",
            issueTypes: [
              { id: "2", name: "Task", subtask: false },
              { id: "3", name: "Story", subtask: false },
            ],
          });
        if (url.pathname.endsWith("/estimation"))
          return response({ fieldId, ...(omitValue ? {} : { value }) });
        return response(created);
      },
      async (context) => {
        context.qualificationFixture = async (request) => {
          expect(request.tool).toBe("jira.create");
          expect(request.arguments.issueTypeId).toBe(typeId);
          expect(request.arguments.fields).toMatchObject(
            unit === "minutes" ? { timetracking: { originalEstimate: "1m" } } : { [fieldId]: 1 },
          );
          created = {
            id: issue.id,
            key: issue.key,
            fields: {
              ...request.arguments.fields,
              [fieldId]: value,
              project: { id: "10" },
              issuetype: { id: typeId },
            },
          };
          await request.readback(context, { issueKey: issue.key });
        };
        await entry("jira.set-issue-estimation").prepare(context, f);
        expect(entry("jira.set-issue-estimation").arguments(f)).toMatchObject({
          expectedValue: value,
          unit,
          value: "2",
        });
        expect(f.planningEstimateTarget).not.toBe(value);
        omitValue = true;
        await expect(entry("jira.set-issue-estimation").prepare(context, f)).rejects.toThrow(
          /explicitly observed/u,
        );
      },
    );
  },
);

it("selects the opposite observed rank order using two genuinely created issue identities", async () => {
  const f = fixture();
  const created = [];
  await withNative(
    (url) => {
      if (url.pathname.endsWith("/myself")) return response(actor);
      if (url.pathname.endsWith("/configuration")) return response(f.planningBoard);
      if (url.pathname.endsWith("/field"))
        return response([
          {
            id: "customfield_10019",
            schema: { custom: "com.pyxis.greenhopper.jira:gh-lexo-rank" },
          },
        ]);
      if (url.pathname === "/rest/agile/1.0/board/13/issue")
        return response({ startAt: 0, total: 2, issues: [...created].reverse() });
      return response(created.find((item) => item.key === url.pathname.split("/").at(-1)));
    },
    async (context) => {
      context.qualificationFixture = async (request) => {
        expect(request.tool).toBe("jira.create");
        const id = String(41 + created.length);
        const actual = {
          id,
          key: `KEIKO-${id}`,
          fields: {
            ...request.arguments.fields,
            customfield_10019: `opaque-${id}`,
            project: { id: "10" },
            issuetype: { id: "2" },
          },
        };
        created.push(actual);
        await request.readback(context, { issueKey: actual.key });
      };
      await entry("jira.rank-issues").prepare(context, f);
      expect(created).toHaveLength(2);
      expect(entry("jira.rank-issues").arguments(f)).toMatchObject({
        direction: "before",
        issues: [{ issueIdOrKey: "KEIKO-41", expectedRank: "opaque-41" }],
        anchorIssueIdOrKey: "KEIKO-42",
        expectedAnchorRank: "opaque-42",
      });
    },
  );
});

it.each(["jira.unmap-sprints", "jira.unmap-all-sprints"])(
  "admits %s only with explicitly named, genuinely synced native fixtures",
  async (tool) => {
    const f = fixture();
    let current = sprint("21", { synced: true });
    await withNative(
      (url) => {
        if (url.pathname.endsWith("/myself")) return response(actor);
        if (url.pathname.includes("/board/")) return response({ id: 13, type: "scrum" });
        return response(current);
      },
      async (context) => {
        const spec = entry(tool);
        await expect(spec.prepare(context, f)).rejects.toThrow(/private fixture/u);
        const key =
          tool === "jira.unmap-sprints" ? "planningSyncedSprintIds" : "planningAllSyncedSprintIds";
        f[key] = ["21"];
        await spec.prepare(context, f);
        expect(spec.arguments(f).expectedSprints).toEqual([current]);
        delete current.synced;
        await expect(spec.prepare(context, f)).rejects.toThrow();
        current = sprint("21", { synced: false });
        await expect(spec.prepare(context, f)).rejects.toThrow();
        f[key] = ["21", "21"];
        await expect(spec.prepare(context, f)).rejects.toThrow();
        f[key] = [21];
        await expect(spec.prepare(context, f)).rejects.toThrow();
      },
    );
  },
);

it.each(["jira.unmap-sprints", "jira.unmap-all-sprints"])(
  "checks the actual sync transition and all unchanged native metadata for %s",
  async (tool) => {
    const f = fixture();
    let current = { ...f.planningSyncedSprints[0], synced: false };
    await withNative(
      () => response(current),
      async (context) => {
        await expect(entry(tool).readback(context, {}, f)).resolves.toMatchObject({
          matched: true,
        });
        current = { ...current, goal: "Unexpected metadata change" };
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
        current = f.planningSyncedSprints[0];
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
      },
    );
  },
);

it("prepares sprint deletion through the governed fixture hook and refuses a missing native sync flag", async () => {
  const f = fixture();
  let current;
  let omitFlag = false;
  await withNative(
    (url) => {
      if (url.pathname.endsWith("/myself")) return response(actor);
      if (url.pathname.endsWith("/configuration")) return response(f.planningBoard);
      return response(
        omitFlag
          ? { id: current.id, name: current.name, state: "future", originBoardId: "13" }
          : current,
      );
    },
    async (context) => {
      const writes = [];
      context.qualificationFixture = async (request) => {
        writes.push(request);
        expect(request.tool).toBe("jira.sprint-create");
        current = sprint("15", { name: request.arguments.name });
        await request.readback(context, { sprintId: "15" });
      };
      await entry("jira.delete-sprint").prepare(context, f);
      expect(writes).toHaveLength(1);
      expect(f.planningSprint.name.length).toBeLessThanOrEqual(30);
      expect(entry("jira.delete-sprint").arguments(f).expectedSprint.synced).toBe(false);
      omitFlag = true;
      await expect(entry("jira.delete-sprint").prepare(context, f)).rejects.toThrow();
    },
  );
});

it("keeps a 404 deletion observation scoped and refuses a retained board-list identity", async () => {
  const f = fixture();
  let retained = false;
  await withNative(
    (url) => {
      if (url.pathname === "/rest/agile/1.0/sprint/15") return response({}, 404);
      if (url.pathname.endsWith("/sprint")) return response(page(retained ? [sprint()] : []));
      return response({ id: 13, type: "scrum" });
    },
    async (context) => {
      await expect(entry("jira.delete-sprint").readback(context, {}, f)).resolves.toMatchObject({
        matched: true,
        observedStatus: 404,
        deletionConfirmed: false,
      });
      retained = true;
      await expect(entry("jira.delete-sprint").readback(context, {}, f)).rejects.toThrow();
    },
  );
});

it("requires all explicit replacement fields, distinguishing an omitted value from null", async () => {
  const f = fixture();
  let current = { ...f.planningSprint, ...f.planningReplacement };
  await withNative(
    () => response(current),
    async (context) => {
      await expect(entry("jira.replace-sprint").readback(context, {}, f)).resolves.toMatchObject({
        matched: true,
      });
      delete current.startDate;
      await expect(entry("jira.replace-sprint").readback(context, {}, f)).rejects.toThrow();
      current = { ...f.planningSprint, ...f.planningReplacement, synced: true };
      await expect(entry("jira.replace-sprint").readback(context, {}, f)).rejects.toThrow();
    },
  );
});

it("requires a complete observed sprint swap and preserves native snapshot metadata", async () => {
  const f = fixture();
  let order = [f.planningSwapSprint, f.planningSprint];
  let current = f.planningSprint;
  await withNative(
    (url) => {
      if (url.pathname.endsWith("/sprint")) return response(page(order));
      return response(url.pathname.endsWith("/15") ? current : f.planningSwapSprint);
    },
    async (context) => {
      await expect(entry("jira.swap-sprints").readback(context, {}, f)).resolves.toMatchObject({
        matched: true,
        globalPositionConfirmed: false,
      });
      order = [f.planningSprint, f.planningSwapSprint];
      await expect(entry("jira.swap-sprints").readback(context, {}, f)).rejects.toThrow();
      order = [f.planningSwapSprint, f.planningSprint];
      current = { ...f.planningSprint, goal: "Unexpected goal" };
      await expect(entry("jira.swap-sprints").readback(context, {}, f)).rejects.toThrow();
    },
  );
});

it.each(["jira.set-application-roles", "jira.set-application-role"])(
  "prepares %s with a governed, independently empty native group",
  async (tool) => {
    const f = fixture();
    await withNative(
      (url) => {
        if (url.pathname.endsWith("/myself")) return response(actor);
        if (url.pathname.endsWith("/applicationrole")) return response([role]);
        expect(url.pathname).toBe("/rest/api/2/group/member");
        expect(url.searchParams.get("groupname")).toContain("keiko-ac7-role-");
        return response(page([]));
      },
      async (context) => {
        const writes = [];
        context.qualificationFixture = async (request) => {
          writes.push(request);
          await request.readback(context, {});
        };
        await entry(tool).prepare(context, f);
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
          tool: "jira.create-group",
          arguments: { expectedActorKey: actor.key },
        });
        expect(f.applicationRoleChange.expected).toEqual(role);
        expect(f.applicationRoleChange.value.groups).toContain(writes[0].arguments.groupName);
        expect(f.applicationRoleChange.value.defaultGroups).toEqual(role.defaultGroups);
        expect(f.applicationRoleChange.value.groups).toEqual(expect.arrayContaining(role.groups));
        await expect(
          entry(tool).prepare({ ...context, qualificationFixture: undefined }, fixture()),
        ).rejects.toThrow();
      },
    );
  },
);

it.each(["jira.set-application-roles", "jira.set-application-role"])(
  "checks %s role configuration without claiming effective access",
  async (tool) => {
    const f = fixture();
    const other = { key: "jira-servicedesk", groups: ["service-users"], defaultGroups: [] };
    f.applicationRoleBefore.push(other);
    let changed = f.applicationRoleChange.value;
    let unselected = other;
    await withNative(
      (url) =>
        response(url.pathname.endsWith("/applicationrole") ? [changed, unselected] : changed),
      async (context) => {
        await expect(entry(tool).readback(context, {}, f)).resolves.toMatchObject({
          matched: true,
          effectiveAccessConfirmed: false,
        });
        changed = role;
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
        changed = f.applicationRoleChange.value;
        unselected = { ...other, groups: [] };
        await expect(entry(tool).readback(context, {}, f)).rejects.toThrow();
      },
    );
  },
);
