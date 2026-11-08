import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import {
  projectAgileRead,
  projectInventory,
  projectAgileWitness,
  nativePages,
} from "./project-agile-oracles.mjs";

export function projectAgileArguments(values) {
  const [directory, modelId, permittedToken, deniedToken, ...extra] = values;
  assert.ok(
    directory && isAbsolute(directory),
    "Use the existing absolute private session directory",
  );
  if (modelId === "--reconcile") {
    assert.ok(permittedToken && isAbsolute(permittedToken));
    assert.equal(deniedToken, undefined);
    assert.equal(extra.length, 0);
    return { directory, permittedToken, reconcile: true };
  }
  assert.ok(modelId && modelId.length <= 255 && !/\p{Cc}/u.test(modelId));
  assert.ok(permittedToken && isAbsolute(permittedToken));
  assert.ok(deniedToken && isAbsolute(deniedToken));
  assert.notEqual(resolve(permittedToken), resolve(deniedToken));
  assert.equal(extra.length, 0);
  return { directory, modelId, permittedToken, deniedToken, reconcile: false };
}

async function actorFor(session, tokenFile, administer, requirePrivateSharing = administer) {
  const authorization = `Bearer ${readPrivateFile(tokenFile)}`;
  const actor = await projectAgileRead(session, "/rest/api/2/myself", authorization);
  assert.equal(actor.active, true);
  assert.ok(typeof actor.key === "string" && typeof actor.name === "string");
  const permission = await projectAgileRead(
    session,
    "/rest/api/2/mypermissions?permissions=ADMINISTER",
    authorization,
  );
  assert.equal(
    permission.permissions?.ADMINISTER?.havePermission,
    administer,
    "Actors must already have their independently observed native permission; the lab grants none",
  );
  if (requirePrivateSharing) {
    const sharing = await projectAgileRead(
      session,
      "/rest/api/2/filter/defaultShareScope",
      authorization,
    );
    assert.equal(
      sharing.scope,
      "PRIVATE",
      "Use an existing private default; the journey never changes it",
    );
  }
  return { key: actor.key, name: actor.name };
}

function reconciliationProjection(group, projects, issues, boards, sprints) {
  return {
    groupId: group.id,
    phase: group.current?.phase,
    projects,
    issues: issues.map(({ id, key, fields }) => ({ id, key, summary: fields.summary })),
    boards: boards.map(({ id, name }) => ({ id, name })),
    sprints: sprints.map(({ id, name, state, originBoardId }) => ({
      id,
      name,
      state,
      originBoardId,
    })),
  };
}
async function reconcile(session, pendingPath, actor) {
  const group = JSON.parse(readPrivateFile(pendingPath));
  assert.equal(group.kind, "project-agile-browser-v1");
  assert.equal(group.actorKey, actor.key);
  assert.match(group.key, /^ZQ[A-F0-9]{8}$/u);
  assert.match(group.deniedKey, /^ZD[A-F0-9]{8}$/u);
  const projects = (await projectInventory(session)).filter(
    (project) => project.key === group.key || project.key === group.deniedKey,
  );
  const issues = projects.some((project) => project.key === group.key)
    ? await nativePages(
        (path) => projectAgileRead(session, path),
        `/rest/api/2/search?jql=${encodeURIComponent(`project = ${group.key} ORDER BY key`)}&fields=summary,issuetype,project`,
        "issues",
      )
    : [];
  const boards = await nativePages(
    (path) => projectAgileRead(session, path),
    `/rest/agile/1.0/board?name=${encodeURIComponent(`${group.name} board`)}`,
    "values",
  );
  const sprints = [];
  for (const board of boards.filter((entry) => entry.name === `${group.name} board`)) {
    assert.match(String(board.id), /^[1-9][0-9]*$/u);
    sprints.push(
      ...(await nativePages(
        (path) => projectAgileRead(session, path),
        `/rest/agile/1.0/board/${board.id}/sprint`,
        "values",
      )),
    );
  }
  privateJson(
    join(session.directory, `project-agile-reconciliation-${randomUUID()}.json`),
    reconciliationProjection(group, projects, issues, boards, sprints),
    true,
  );
  // The unresolved marker is deliberately retained. Reconciliation never resumes or cleans up writes.
  console.log(
    JSON.stringify({ qualification: "jira-project-agile-browser", phase: "reconciled-read-only" }),
  );
}

function qualificationGroup(selected, permittedActor) {
  const id = randomUUID();
  const suffix = id.replaceAll("-", "").slice(0, 8).toUpperCase();
  const group = {
    kind: "project-agile-browser-v1",
    id,
    key: `ZQ${suffix}`,
    deniedKey: `ZD${suffix}`,
    name: `Synthetic acceptance ${suffix}`,
    actorKey: permittedActor.key,
    modelId: selected.modelId,
    results: [],
  };
  return { id, group };
}
function finishQualification(session, pendingPath, id, group) {
  assert.equal(group.results.length, 12);
  assert.equal(group.reloadObserved, true);
  privateJson(join(session.directory, `project-agile-browser-${id}.json`), group, true);
  rmSync(pendingPath);
  console.log(
    JSON.stringify({
      qualification: "jira-project-agile-browser",
      phase: "completed",
      cases: group.results.length,
    }),
  );
}
function assertQualificationLicense(remaining) {
  assert.ok(
    remaining >= 1800,
    "Thirty minutes of the current license are required; no automatic restart",
  );
}
async function main() {
  const selected = projectAgileArguments(process.argv.slice(2));
  const session = loadSession(selected.directory);
  const pendingPath = join(session.directory, "project-agile-browser.pending.json");
  const permittedActor = await actorFor(
    session,
    selected.permittedToken,
    true,
    !selected.reconcile,
  );
  const oracleSession = {
    ...session,
    oracleAuthorization: `Bearer ${readPrivateFile(selected.permittedToken)}`,
  };
  if (selected.reconcile) return reconcile(oracleSession, pendingPath, permittedActor);
  // This read never restarts Jira. Root owns the shared Jira/Gateway window, including Claude2.
  assertQualificationLicense(await requireLicense(session));
  const inputs = {
    ...selected,
    permittedActor,
    deniedActor: await actorFor(session, selected.deniedToken, false),
  };
  assert.notEqual(inputs.permittedActor.key, inputs.deniedActor.key);
  const { id, group } = qualificationGroup(selected, permittedActor);
  privateJson(pendingPath, group, true);
  const persist = () => privateJson(pendingPath, group);
  const witness = projectAgileWitness(session);
  const { withLiveChat } = await import("./chat-read.mjs");
  const { runProjectAgileJourney } = await import("./browser-project-agile-journey.mjs");
  await withLiveChat({
    session,
    modelId: selected.modelId,
    browser: true,
    retainState: true,
    modelRetries: 0,
    decorateAtlassianHttp: witness.decorate,
    stateReady: (directory) => {
      group.stateDirectory = directory;
      persist();
    },
    run: (context) =>
      runProjectAgileJourney(
        { ...context, session: oracleSession },
        group,
        inputs,
        witness,
        persist,
      ),
  });
  finishQualification(session, pendingPath, id, group);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.log(
      JSON.stringify({
        qualification: "jira-project-agile-browser",
        phase: "incomplete",
        errorType: error instanceof Error ? error.name : "unknown",
      }),
    );
    process.exitCode = 1;
  });
}
