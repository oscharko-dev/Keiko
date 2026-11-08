// Only disposable synthetic property keys are written; values are read through a separate client.
import assert from "node:assert/strict";
import { basicAuth, labRequest } from "./lab-client.mjs";

const propertyKey = (fixture) => `keiko-ac7-${fixture.runId}`;
const value = (fixture) => `Synthetic AC7 ${fixture.runId}`;
const nodes = (fixture) => [{ path: "", kind: "string", textValue: value(fixture) }];
const entities = [
  {
    name: "issue",
    arguments: (f) => ({ issueIdOrKey: f.issueKeys[0] }),
    parent: (f) => `/rest/api/2/issue/${f.issueKeys[0]}`,
    root: (f) => `/rest/api/2/issue/${f.issueKeys[0]}/properties`,
    query: "",
  },
  {
    name: "user",
    arguments: () => ({ username: "keiko-api" }),
    parent: () => "/rest/api/2/user?username=keiko-api",
    root: () => "/rest/api/2/user/properties",
    query: "?username=keiko-api",
  },
  {
    name: "project",
    arguments: () => ({ projectIdOrKey: "KEIKO" }),
    parent: () => "/rest/api/2/project/KEIKO",
    root: () => "/rest/api/2/project/KEIKO/properties",
    query: "",
    actor: "admin",
    administration: true,
  },
  {
    name: "issue-type",
    arguments: (f) => ({ issueTypeId: f.issueTypeId }),
    parent: (f) => `/rest/api/2/issuetype/${f.issueTypeId}`,
    root: (f) => `/rest/api/2/issuetype/${f.issueTypeId}/properties`,
    query: "",
    actor: "admin",
    administration: true,
  },
];

async function observe(context, path) {
  return labRequest(context.session, "GET", path, basicAuth(context.session, context.actor));
}

function propertyReadback(entity, present, read) {
  return async (context, data, fixture) => {
    const parent = await observe(context, entity.parent(fixture));
    assert.equal(parent.status, 200);
    const selected = propertyKey(fixture);
    const root = entity.root(fixture);
    const keys = await observe(context, root + entity.query);
    assert.equal(keys.status, 200);
    assert.ok(Array.isArray(keys.value.keys));
    assert.equal(keys.value.keys.filter((entry) => entry.key === selected).length, present ? 1 : 0);
    const actual = await observe(context, `${root}/${selected}${entity.query}`);
    assert.equal(actual.status, present ? 200 : 404);
    if (present) {
      assert.equal(actual.value.key, selected);
      assert.equal(actual.value.value, value(fixture));
    }
    if (read) {
      assert.equal(data.propertyKey, selected);
      assert.deepEqual(data.valueNodes, nodes(fixture));
    } else assert.equal(data.propertyPresent, present);
    return { matched: true, assertionCount: present ? (read ? 9 : 8) : 6 };
  };
}

function propertyCases(entity) {
  const scope = { actor: entity.actor ?? "api", administration: entity.administration === true };
  const selection = (f) => ({ ...entity.arguments(f), propertyKey: propertyKey(f) });
  return [
    {
      ...scope,
      tool: `jira.set-${entity.name}-property`,
      mutation: true,
      arguments: (f) => ({ ...selection(f), expectAbsent: true, valueNodes: nodes(f) }),
      readback: propertyReadback(entity, true, false),
    },
    {
      ...scope,
      tool: `jira.${entity.name}-property`,
      arguments: selection,
      readback: propertyReadback(entity, true, true),
    },
    {
      ...scope,
      tool: `jira.delete-${entity.name}-property`,
      mutation: true,
      arguments: (f) => ({ ...selection(f), expectedValueNodes: nodes(f) }),
      readback: propertyReadback(entity, false, false),
    },
  ];
}

export const API_QUALIFICATION_PROPERTY_CASES = entities.flatMap(propertyCases);
