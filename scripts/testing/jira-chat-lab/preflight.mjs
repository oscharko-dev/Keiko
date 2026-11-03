import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verifyJiraDataCenterConnection } from "@oscharko-dev/keiko-connectors";
import { loadSession, requireLicense } from "./lab-client.mjs";
import { withProductPort, productRequest } from "./product-port.mjs";

async function qualifyEdit(connection, path, marker) {
  await productRequest(
    connection,
    "issue-update",
    "PUT",
    path,
    { fields: { description: marker } },
    204,
  );
  const observed = await productRequest(
    connection,
    "update-readback",
    "GET",
    `${path}?fields=description&expand=changelog`,
  );
  assert.equal(observed.fields.description, marker);
  assert.equal(
    observed.changelog.histories
      .flatMap((history) => history.items)
      .filter((item) => item.field === "description" && item.toString === marker).length,
    1,
  );
}

async function qualifyWrites(connection, key, marker) {
  const path = `/rest/api/2/issue/${key}`;
  const beforeAssignment = await productRequest(connection, "issue-read", "GET", path);
  if (beforeAssignment.fields.assignee?.name !== "keiko-assignee")
    await productRequest(
      connection,
      "issue-assignment",
      "PUT",
      `${path}/assignee`,
      { name: "keiko-assignee" },
      204,
    );
  const assigned = await productRequest(
    connection,
    "assignment-readback",
    "GET",
    `${path}?fields=assignee`,
  );
  assert.equal(assigned.fields.assignee.name, "keiko-assignee");
  await qualifyEdit(connection, path, marker);
  const before = await productRequest(
    connection,
    "comment-count-before",
    "GET",
    `${path}/comment?maxResults=1`,
  );
  const created = await productRequest(
    connection,
    "comment-create",
    "POST",
    `${path}/comment`,
    { body: marker },
    201,
  );
  assert.match(created.id, /^\d+$/);
  const observed = await productRequest(
    connection,
    "comment-readback",
    "GET",
    `${path}/comment/${created.id}`,
  );
  assert.equal(observed.body, marker);
  const after = await productRequest(
    connection,
    "comment-count-after",
    "GET",
    `${path}/comment?maxResults=1`,
  );
  assert.equal(after.total, before.total + 1);
}

async function main() {
  if (!process.argv[2]) throw new TypeError("Usage: preflight.mjs <private-state-directory>");
  const session = loadSession(process.argv[2]);
  await requireLicense(session);
  const fixture = JSON.parse(readFileSync(join(session.directory, "fixture.json"), "utf8"));
  const key = fixture.issueKeys[1];
  if (!/^KEIKO-\d+$/.test(key)) throw new TypeError("Unexpected synthetic issue identity");
  const marker = `Synthetic preflight ${randomUUID()}`;
  const pending = join(session.directory, "preflight.pending.json");
  // An interrupted preflight requires read-only reconciliation before another write group.
  writeFileSync(pending, JSON.stringify({ schemaVersion: 1, key, marker }), {
    mode: 0o600,
    flag: "wx",
  });
  await withProductPort(
    join(session.directory, "secrets", "api-token"),
    join(session.directory, "secrets", "tls"),
    async (connection) => {
      assert.equal(await verifyJiraDataCenterConnection(connection.port, connection.baseUrl), "ok");
      await qualifyWrites(connection, key, marker);
    },
  );
  await requireLicense(session);
  rmSync(pending);
  console.log(JSON.stringify({ operation: "jira-lab-preflight", passed: true }));
}

await main().catch(() => {
  console.error("jira-lab-preflight: failed; possible remote effects are not retried");
  process.exitCode = 1;
});
