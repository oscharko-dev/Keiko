// Each layout write is checked against the complete independently observed native parent layout.
import assert from "node:assert/strict";
import { read, proof } from "./api-qualification-read.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { fixtureWrite, createQualificationField } from "./api-qualification-fixtures.mjs";

const root = (f) => `/rest/api/2/screens/${f.qualificationScreenId}`;
const fieldsPath = (f) => `${root(f)}/tabs/${f.qualificationTabId}/fields`;
const tabName = (f) => `AC7 ${f.runId}`;
const normalizeTabs = (rows) => rows.map((row) => ({ id: String(row.id), name: row.name }));
export const screenFieldReview = (rows) =>
  rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type ?? null,
    showWhenEmpty: row.showWhenEmpty ?? null,
  }));
async function screen(c, f) {
  await observeAdminActor(c, f);
  const page = await read(c, "/rest/api/2/screens?startAt=0&maxResults=100");
  assert.equal(page.total, page.screens.length);
  f.qualificationScreenId ??= String(page.screens[0]?.id);
  const selected = page.screens.find((row) => String(row.id) === f.qualificationScreenId);
  assert.ok(selected?.name);
  f.qualificationScreenName = selected.name;
  f.qualificationTabs = normalizeTabs(await read(c, `${root(f)}/tabs`));
}
async function layout(c, f) {
  await screen(c, f);
  const tab = f.qualificationTabs.find((row) => row.id === f.qualificationTabId);
  assert.ok(tab);
  f.qualificationTabName = tab.name;
  f.qualificationFields = screenFieldReview(await read(c, fieldsPath(f)));
}
const screenArgs = (f) => ({
  screenId: f.qualificationScreenId,
  expectedScreenName: f.qualificationScreenName,
});
const layoutArgs = (f) => ({
  ...screenArgs(f),
  tabId: f.qualificationTabId,
  expectedTabs: f.qualificationTabs,
});
const fieldArgs = (f) => ({
  ...layoutArgs(f),
  expectedFields: f.qualificationFields,
  fieldId: f.qualificationField.id,
});
async function assertParent(c, f) {
  const tabs = normalizeTabs(await read(c, `${root(f)}/tabs`));
  assert.deepEqual(tabs, f.qualificationTabs);
  return screenFieldReview(await read(c, fieldsPath(f)));
}
async function allLayouts(c) {
  const screens = await read(c, "/rest/api/2/screens?startAt=0&maxResults=100");
  assert.equal(screens.total, screens.screens.length);
  const result = [];
  await screens.screens.reduce(async (previous, screen) => {
    await previous;
    const tabs = await read(c, `/rest/api/2/screens/${screen.id}/tabs`);
    await tabs.reduce(async (prior, tab) => {
      await prior;
      const fields = await read(c, `/rest/api/2/screens/${screen.id}/tabs/${tab.id}/fields`);
      result.push({
        screenId: String(screen.id),
        tabId: String(tab.id),
        fields: screenFieldReview(fields),
      });
    }, Promise.resolve());
  }, Promise.resolve());
  assert.ok(result.length > 0);
  return result;
}
export const API_QUALIFICATION_SCREEN_CASES = [
  adminMutationCase(
    "jira.create-screen-tab",
    (f) => ({ ...screenArgs(f), name: tabName(f) }),
    async (c, data, f) => {
      assert.match(data.tabId, /^[1-9][0-9]*$/u);
      f.qualificationTabId = data.tabId;
      const tabs = normalizeTabs(await read(c, `${root(f)}/tabs`));
      assert.deepEqual(
        tabs.filter((row) => row.id !== data.tabId),
        f.qualificationTabs,
      );
      assert.deepEqual(
        tabs.find((row) => row.id === data.tabId),
        { id: data.tabId, name: tabName(f) },
      );
      return proof(3);
    },
    screen,
  ),
  adminMutationCase(
    "jira.rename-screen-tab",
    (f) => ({
      ...screenArgs(f),
      tabId: f.qualificationTabId,
      expectedName: f.qualificationTabName,
      name: `${tabName(f)} revised`,
    }),
    async (c, _data, f) => {
      assert.deepEqual(
        normalizeTabs(await read(c, `${root(f)}/tabs`)),
        f.qualificationTabs.map((row) =>
          row.id === f.qualificationTabId ? { ...row, name: `${tabName(f)} revised` } : row,
        ),
      );
      return proof(2);
    },
    layout,
  ),
  adminMutationCase(
    "jira.move-screen-tab",
    (f) => ({ ...layoutArgs(f), position: 0 }),
    async (c, _data, f) => {
      const selected = f.qualificationTabs.find((row) => row.id === f.qualificationTabId);
      assert.deepEqual(normalizeTabs(await read(c, `${root(f)}/tabs`)), [
        selected,
        ...f.qualificationTabs.filter((row) => row.id !== selected.id),
      ]);
      return proof(2);
    },
    layout,
  ),
  adminMutationCase(
    "jira.add-screen-tab-field",
    (f) => ({ ...fieldArgs(f), expectedFieldName: f.qualificationField.name }),
    async (c, _data, f) => {
      const after = await assertParent(c, f);
      assert.deepEqual(
        after.filter((row) => row.id !== f.qualificationField.id),
        f.qualificationFields,
      );
      assert.equal(
        after.filter(
          (row) => row.id === f.qualificationField.id && row.name === f.qualificationField.name,
        ).length,
        1,
      );
      return proof(3);
    },
    async (c, f) => {
      await layout(c, f);
      f.qualificationField = await createQualificationField(c, f, "screen");
      const available = await read(c, `${root(f)}/availableFields`);
      assert.ok(
        available.some(
          (row) => row.id === f.qualificationField.id && row.name === f.qualificationField.name,
        ),
      );
    },
  ),
  adminMutationCase(
    "jira.move-screen-tab-field",
    (f) => ({ ...fieldArgs(f), position: "First" }),
    async (c, _data, f) => {
      const selected = f.qualificationFields.find((row) => row.id === f.qualificationField.id);
      assert.deepEqual(await assertParent(c, f), [
        selected,
        ...f.qualificationFields.filter((row) => row.id !== selected.id),
      ]);
      return proof(2);
    },
    async (c, f) => {
      await layout(c, f);
      const available = await read(c, `${root(f)}/availableFields`);
      const other = available.find((row) => row.id !== f.qualificationField.id);
      assert.ok(other);
      await fixtureWrite(
        c,
        "jira.add-screen-tab-field",
        {
          ...layoutArgs(f),
          fieldId: other.id,
          expectedFieldName: other.name,
          expectedFields: f.qualificationFields,
        },
        async (context) => {
          const after = screenFieldReview(await read(context, fieldsPath(f)));
          assert.equal(after.filter((row) => row.id === other.id).length, 1);
          return proof(2);
        },
      );
      await layout(c, f);
      const current = f.qualificationFields.findIndex((row) => row.id === f.qualificationField.id);
      if (current === 0) {
        await fixtureWrite(
          c,
          "jira.move-screen-tab-field",
          { ...fieldArgs(f), position: "Last" },
          async (context) => {
            const after = await read(context, fieldsPath(f));
            assert.equal(after.at(-1).id, f.qualificationField.id);
            return proof(1);
          },
        );
        await layout(c, f);
      }
    },
  ),
  adminMutationCase(
    "jira.set-screen-field-show-when-empty",
    (f) => ({
      ...fieldArgs(f),
      showWhenEmpty:
        f.qualificationFields.find((row) => row.id === f.qualificationField.id).showWhenEmpty !==
        true,
    }),
    async (c, _data, f) => {
      const prior = f.qualificationFields.find((row) => row.id === f.qualificationField.id);
      assert.deepEqual(
        await assertParent(c, f),
        f.qualificationFields.map((row) =>
          row.id === prior.id ? { ...row, showWhenEmpty: prior.showWhenEmpty !== true } : row,
        ),
      );
      return proof(2);
    },
    layout,
  ),
  adminMutationCase(
    "jira.remove-screen-tab-field",
    fieldArgs,
    async (c, _data, f) => {
      assert.ok(f.qualificationFields.some((row) => row.id === f.qualificationField.id));
      assert.deepEqual(
        await assertParent(c, f),
        f.qualificationFields.filter((row) => row.id !== f.qualificationField.id),
      );
      return proof(3);
    },
    layout,
  ),
  adminMutationCase(
    "jira.delete-screen-tab",
    (f) => ({
      ...screenArgs(f),
      tabId: f.qualificationTabId,
      expectedName: f.qualificationTabName,
      expectedFieldIds: f.qualificationFields.map((row) => row.id),
    }),
    async (c, _data, f) => {
      assert.ok(f.qualificationTabs.length > 1);
      assert.deepEqual(
        normalizeTabs(await read(c, `${root(f)}/tabs`)),
        f.qualificationTabs.filter((row) => row.id !== f.qualificationTabId),
      );
      return proof(3);
    },
    layout,
  ),
  adminMutationCase(
    "jira.add-default-screen-field",
    (f) => ({
      fieldId: f.defaultScreenField.id,
      expectedFieldName: f.defaultScreenField.name,
      acceptUnverifiedDefault: true,
    }),
    async (c, _data, f) => {
      const after = await allLayouts(c);
      assert.deepEqual(
        after.map(({ fields: _fields, ...parent }) => parent),
        f.layoutsBefore.map(({ fields: _fields, ...parent }) => parent),
      );
      let additions = 0;
      for (const [index, row] of after.entries()) {
        const added = row.fields.filter((field) => field.id === f.defaultScreenField.id);
        additions += added.length;
        assert.deepEqual(
          row.fields.filter((field) => field.id !== f.defaultScreenField.id),
          f.layoutsBefore[index].fields,
        );
      }
      assert.equal(additions, 1);
      return proof(3 + after.length);
    },
    async (c, f) => {
      await observeAdminActor(c, f);
      f.defaultScreenField = await createQualificationField(c, f, "default screen");
      f.layoutsBefore = await allLayouts(c);
      assert.ok(
        f.layoutsBefore.every((row) =>
          row.fields.every((field) => field.id !== f.defaultScreenField.id),
        ),
      );
    },
  ),
];
