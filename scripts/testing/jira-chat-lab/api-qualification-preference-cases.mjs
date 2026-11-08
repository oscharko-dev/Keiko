// Reversible instance and user settings use exact native preconditions and explicit changed values.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";
import { read, proof } from "./api-qualification-read.mjs";
import { readCase } from "./api-qualification-cases.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { assertQualificationJson } from "./api-qualification-json.mjs";
import { fixtureWrite } from "./api-qualification-fixtures.mjs";

const actor = (f) => ({ expectedActorKey: f.adminActorKey });
const preferenceKey = () => "user.issues.per.page";
const preferencePath = (f) => `/rest/api/2/mypreferences?key=${preferenceKey(f)}`;
const columns = (rows) => {
  assert.ok(Array.isArray(rows) && rows.length > 0);
  return rows.map((row) => {
    assert.equal(typeof row.value, "string");
    return row.value;
  });
};
async function ownColumns(c, f) {
  await observeAdminActor(c, f);
  const user = await read(c, "/rest/api/2/myself");
  f.columnsUser = { key: user.key, name: user.name };
  f.userColumns = columns(await read(c, `/rest/api/2/user/columns?username=${user.name}`));
}
async function systemColumns(c, f) {
  await observeAdminActor(c, f);
  f.systemColumns = columns(await read(c, "/rest/api/2/settings/columns"));
}
const reversed = (values) => {
  const result = [...values].reverse();
  assert.notDeepEqual(result, values, "A settings qualification must dispatch a real change");
  return result;
};
export const API_QUALIFICATION_PREFERENCE_CASES = [
  adminMutationCase(
    "jira.set-application-property",
    (f) => ({
      ...actor(f),
      propertyKey: "jira.clone.prefix",
      expectedValue: f.clonePrefix,
      value: `AC7-${f.runId}`,
    }),
    async (c, _data, f) => {
      const raw = await read(c, "/rest/api/2/application-properties?key=jira.clone.prefix");
      const actual = Array.isArray(raw) ? raw[0] : raw;
      assert.equal(actual.id ?? actual.key, "jira.clone.prefix");
      assert.equal(actual.value, `AC7-${f.runId}`);
      return proof(2);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const raw = await read(c, "/rest/api/2/application-properties?key=jira.clone.prefix");
      const actual = Array.isArray(raw) ? raw[0] : raw;
      assert.equal(typeof actual.value, "string");
      f.clonePrefix = actual.value;
    },
  ),
  adminMutationCase(
    "jira.set-system-columns",
    (f) => ({ ...actor(f), expectedColumns: f.systemColumns, columns: reversed(f.systemColumns) }),
    async (c, _data, f) => {
      assert.deepEqual(
        columns(await read(c, "/rest/api/2/settings/columns")),
        reversed(f.systemColumns),
      );
      return proof(2);
    },
    systemColumns,
  ),
  adminMutationCase(
    "jira.set-user-columns",
    (f) => ({
      ...actor(f),
      user: f.columnsUser,
      expectedColumns: f.userColumns,
      columns: reversed(f.userColumns),
    }),
    async (c, _data, f) => {
      assert.deepEqual(
        columns(await read(c, `/rest/api/2/user/columns?username=${f.columnsUser.name}`)),
        reversed(f.userColumns),
      );
      return proof(2);
    },
    ownColumns,
  ),
  adminMutationCase(
    "jira.reset-user-columns",
    (f) => ({ ...actor(f), user: f.columnsUser, expectedColumns: f.userColumns }),
    async (c, _data, f) => {
      const system = columns(await read(c, "/rest/api/2/settings/columns"));
      assert.deepEqual(
        columns(await read(c, `/rest/api/2/user/columns?username=${f.columnsUser.name}`)),
        system,
      );
      assert.notDeepEqual(f.userColumns, system);
      return proof(3);
    },
    ownColumns,
  ),
  adminMutationCase(
    "jira.set-read-only-mode",
    (f) => ({
      ...actor(f),
      expectedEnabled: f.readOnlyEnabled,
      enabled: !f.readOnlyEnabled,
      confirmInstanceWide: true,
    }),
    async (c, _data, f) => {
      const actual = await read(c, "/rest/api/2/readonly-mode");
      assert.equal(actual.enabled, !f.readOnlyEnabled);
      return proof(1);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const value = await read(c, "/rest/api/2/readonly-mode");
      assert.equal(typeof value.enabled, "boolean");
      f.readOnlyEnabled = value.enabled;
    },
  ),
  adminMutationCase(
    "jira.set-instance-base-url",
    (f) => ({
      ...actor(f),
      expectedBaseUrl: f.baseUrl,
      configuredBaseUrl: `${f.sessionHttpsOrigin}/ac7-${f.runId}`,
      confirmInstanceWide: true,
    }),
    async (c, _data, f) => {
      const actual = await read(c, "/rest/api/2/serverInfo");
      assert.equal(actual.baseUrl, `${f.sessionHttpsOrigin}/ac7-${f.runId}`);
      return proof(1);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const value = await read(c, "/rest/api/2/serverInfo");
      assert.equal(typeof value.baseUrl, "string");
      f.baseUrl = value.baseUrl;
      const { labSessionConnection } = await import("./lab-client.mjs");
      f.sessionHttpsOrigin = labSessionConnection(c.session).httpsOrigin;
    },
  ),
  adminMutationCase(
    "jira.set-filter-share-scope",
    (f) => ({
      ...actor(f),
      expectedScope: f.shareScope,
      scope: f.shareScope === "PRIVATE" ? "AUTHENTICATED" : "PRIVATE",
    }),
    async (c, _data, f) => {
      assert.equal(
        (await read(c, "/rest/api/2/filter/defaultShareScope")).scope,
        f.shareScope === "PRIVATE" ? "AUTHENTICATED" : "PRIVATE",
      );
      return proof(1);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.shareScope = (await read(c, "/rest/api/2/filter/defaultShareScope")).scope;
      assert.ok(new Set(["PRIVATE", "AUTHENTICATED", "GLOBAL"]).has(f.shareScope));
    },
  ),
  adminMutationCase(
    "jira.set-my-preference",
    (f) => ({
      ...actor(f),
      key: preferenceKey(),
      expectedValue: f.preferenceOriginal,
      value: f.preferenceTarget,
    }),
    async (c, _data, f) => {
      assert.equal(await read(c, preferencePath(f)), String(f.preferenceTarget));
      return proof(1);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const raw = await read(c, preferencePath(f));
      assert.equal(typeof raw, "string");
      assert.match(raw, /^-?(?:0|[1-9][0-9]*)$/u);
      f.preferenceOriginal = Number(raw);
      assert.ok(Number.isSafeInteger(f.preferenceOriginal));
      f.preferenceTarget = f.preferenceOriginal === 50 ? 100 : 50;
    },
  ),
  {
    ...readCase("jira.my-preference", preferencePath, ["key", "integerValue"], {
      args: () => ({ key: preferenceKey() }),
      nativeRoot: (value) => {
        assert.equal(typeof value, "string");
        return [{ key: preferenceKey(), integerValue: Number(value) }];
      },
      productRoot: "single",
    }),
    actor: "admin",
    administration: true,
  },
  adminMutationCase(
    "jira.delete-my-preference",
    (f) => ({ ...actor(f), key: preferenceKey(f), expectedValue: f.preferenceBefore }),
    async (c, _data, f) => {
      assert.equal(f.preferenceBefore, f.preferenceTarget);
      const response = await labRequest(
        c.session,
        "GET",
        preferencePath(f),
        basicAuth(c.session, c.actor),
      );
      assert.ok(response.status === 200 || response.status === 404);
      if (response.status === 200) assert.equal(response.value, String(f.preferenceOriginal));
      return proof(2);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.preferenceBefore = Number(await read(c, preferencePath(f)));
      assert.equal(f.preferenceBefore, f.preferenceTarget);
    },
  ),
  adminMutationCase(
    "jira.set-terminology",
    (f) => ({
      ...actor(f),
      expectedEntries: f.terminologyBefore,
      entries: [{ originalName: "epic", newName: "ac7 epic", newNamePlural: "ac7 epics" }],
    }),
    async (c, _data, f) => {
      const actual = await read(c, "/rest/api/2/terminology/entries");
      const rows = Array.isArray(actual) ? actual : actual.entries;
      const epic = rows.find((row) => row.originalName === "epic");
      assert.equal(epic.newName, "ac7 epic");
      assert.equal(epic.newNamePlural, "ac7 epics");
      assertQualificationJson(
        rows.filter((row) => row.originalName !== "epic"),
        f.terminologyBefore.filter((row) => row.originalName !== "epic"),
      );
      return proof(3);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      const value = await read(c, "/rest/api/2/terminology/entries");
      f.terminologyBefore = Array.isArray(value) ? value : value.entries;
      assert.equal(f.terminologyBefore.length, 2);
      for (const row of f.terminologyBefore)
        for (const key of [
          "originalName",
          "originalNamePlural",
          "newName",
          "newNamePlural",
          "isDefault",
        ])
          assert.ok(Object.hasOwn(row, key));
    },
  ),
].map((entry) => {
  const cleanups = {
    "jira.set-read-only-mode": async (c, f) => {
      const current = await read(c, "/rest/api/2/readonly-mode");
      await fixtureWrite(
        c,
        "jira.set-read-only-mode",
        {
          ...actor(f),
          expectedEnabled: current.enabled,
          enabled: f.readOnlyEnabled,
          confirmInstanceWide: true,
        },
        async (context) => {
          assert.equal(
            (await read(context, "/rest/api/2/readonly-mode")).enabled,
            f.readOnlyEnabled,
          );
          return proof(1);
        },
      );
    },
    "jira.set-system-columns": async (c, f) => {
      const current = columns(await read(c, "/rest/api/2/settings/columns"));
      await fixtureWrite(
        c,
        "jira.set-system-columns",
        { ...actor(f), expectedColumns: current, columns: f.systemColumns },
        async (context) => {
          assert.deepEqual(
            columns(await read(context, "/rest/api/2/settings/columns")),
            f.systemColumns,
          );
          return proof(1);
        },
      );
    },
  };
  return { ...entry, ...(cleanups[entry.tool] ? { cleanup: cleanups[entry.tool] } : {}) };
});
