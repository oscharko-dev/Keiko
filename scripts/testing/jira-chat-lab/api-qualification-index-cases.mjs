// Native index artifacts and bounded issue suggestions; asynchronous acknowledgements stay unconfirmed.
import assert from "node:assert/strict";
import { URLSearchParams } from "node:url";
import { read, proof } from "./api-qualification-read.mjs";
import { assertQualificationJson } from "./api-qualification-json.mjs";
import { adminMutationCase, observeAdminActor } from "./api-qualification-admin-cases.mjs";
import { labSessionConnection } from "./lab-client.mjs";

const snapshotPath = "/rest/api/2/index-snapshot";
function indexSnapshotReview(rows) {
  assert.ok(Array.isArray(rows));
  return rows.map((row) => {
    assert.equal(typeof row.absolutePath, "string");
    assert.ok(row.absolutePath.length > 0);
    assert.ok(Number.isSafeInteger(row.timestamp) && row.timestamp >= 0);
    return { absolutePath: row.absolutePath, timestamp: row.timestamp };
  });
}
async function snapshotReadback(c, _data, f) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = indexSnapshotReview(await read(c, snapshotPath));
    const added = rows.filter(
      (row) =>
        !f.indexSnapshotsBefore.some(
          (before) =>
            before.absolutePath === row.absolutePath && before.timestamp === row.timestamp,
        ),
    );
    if (added.length > 0) {
      const status = await read(c, `${snapshotPath}/isRunning`);
      assert.equal(typeof status.running, "boolean");
      return proof(3);
    }
    if (attempt < 59) await new Promise((resolve) => globalThis.setTimeout(resolve, 1000));
  }
  assert.fail(
    "Native index-snapshot acknowledgement did not produce an independently observable new snapshot artifact within the bounded wait; never replay the request automatically",
  );
}
const indexFields = [
  "indexReadable",
  "countInArchive",
  "countInDatabase",
  "countInIndex",
  "lastUpdatedInDatabase",
  "lastUpdatedInIndex",
];
export function indexSummaryReview(value) {
  const index = value.issueIndex;
  assert.ok(index && typeof index === "object");
  assert.equal(typeof index.indexReadable, "boolean");
  for (const key of ["countInDatabase", "countInIndex"])
    assert.ok(Number.isSafeInteger(index[key]) && index[key] >= 0);
  return Object.fromEntries(
    indexFields
      .filter((key) => index[key] !== undefined && index[key] !== null)
      .map((key) => [key, index[key]]),
  );
}
const pickerArguments = (f) => ({
  query: f.issueKeys[0],
  currentJQL: "project = KEIKO",
  currentProjectId: f.projectId,
});
export function issuePickerReview(value, origin) {
  assert.ok(Array.isArray(value.sections));
  return value.sections.map((section) => {
    const result = {};
    for (const field of ["id", "label"]) {
      if (section[field] === undefined || section[field] === null) continue;
      assert.equal(typeof section[field], "string");
      result[field] = section[field];
    }
    if (section.issues === undefined || section.issues === null) return result;
    assert.ok(Array.isArray(section.issues));
    return {
      ...result,
      issues: section.issues.map((issue) => {
        assert.match(issue.key, /^[A-Z][A-Z0-9_]*-[1-9]\d*$/u);
        const row = { key: issue.key, browseUrl: `${origin}/browse/${issue.key}` };
        if (issue.summaryText !== undefined && issue.summaryText !== null) {
          assert.equal(typeof issue.summaryText, "string");
          row.summary = issue.summaryText;
        }
        return row;
      }),
    };
  });
}
export const API_QUALIFICATION_INDEX_CASES = [
  adminMutationCase(
    "jira.create-index-snapshot",
    (f) => ({
      expectedActorKey: f.adminActorKey,
      expectedRunning: false,
      confirmUnverifiedEffect: true,
    }),
    snapshotReadback,
    async (c, f) => {
      await observeAdminActor(c, f);
      assert.equal((await read(c, `${snapshotPath}/isRunning`)).running, false);
      f.indexSnapshotsBefore = indexSnapshotReview(await read(c, snapshotPath));
    },
  ),
  {
    tool: "jira.index-summary",
    actor: "admin",
    administration: true,
    arguments: () => ({}),
    readback: async (c, data) => {
      const value = await read(c, "/rest/api/2/index/summary");
      const expected = indexSummaryReview(value);
      assertQualificationJson(data.issueIndex, expected);
      if (value.nodeId !== undefined && value.nodeId !== null)
        assert.equal(data.nodeId, value.nodeId);
      return proof(1 + Object.keys(expected).length);
    },
  },
  {
    tool: "jira.issue-picker",
    arguments: pickerArguments,
    readback: async (c, data, f) => {
      const query = new URLSearchParams(pickerArguments(f));
      const value = await read(c, `/rest/api/2/issue/picker?${query}`);
      const expected = issuePickerReview(value, labSessionConnection(c.session).httpsOrigin);
      assert.ok(
        expected.some((section) => section.issues?.some((issue) => issue.key === f.issueKeys[0])),
        "The issue-picker fixture must produce the selected owned issue suggestion",
      );
      assert.equal(data.suggestionsScope, "native-suggestions");
      assertQualificationJson(data.sections, expected);
      return proof(3);
    },
  },
];
