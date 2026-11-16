import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { basicAuth, loadSession, readPrivateFile, requireLicense } from "./lab-client.mjs";
import { privateJson } from "./private-json.mjs";
import {
  nativePages,
  projectAgileRead,
  projectAgileWitness,
  projectInventory,
} from "./project-agile-oracles.mjs";
import { rolesProjectIdentity, seedBrowserRoles } from "./browser-roles-setup.mjs";
import { ROLE_STEP_CATALOG } from "./browser-roles-steps.mjs";
import { runBrowserRolesJourney } from "./browser-roles-journey.mjs";
import {
  ROLE_LABELS,
  initializeRoleScorecards,
  roleVerdict,
  writeRoleScorecards,
} from "./browser-roles-scorecard.mjs";

export function browserRolesArguments(values) {
  if (values.length === 1 && values[0] === "--plan") return { plan: true };
  const [directory, modelId, ...extra] = values;
  assert.ok(directory && isAbsolute(directory), "Use an absolute private laboratory session");
  assert.equal(extra.length, 0, "No implicit reset, resume, or replacement is accepted");
  if (modelId === "--reconcile") return { directory, reconcile: true };
  assert.ok(typeof modelId === "string" && modelId.length > 0 && modelId.length <= 255);
  assert.ok(!/\p{Cc}/u.test(modelId) && !modelId.startsWith("--"));
  return { directory, modelId, reconcile: false };
}

export function rolesWirePlanMarkdown(catalog = ROLE_STEP_CATALOG) {
  const lines = ["# Rollen-Journeys: erwartete Wire-Signaturen", ""];
  for (const role of Object.keys(ROLE_LABELS)) {
    lines.push(
      `## ${ROLE_LABELS[role]}`,
      "",
      "| Schritt | Writes | Signatur |",
      "| --- | --- | --- |",
    );
    for (const [index, item] of catalog[role].entries()) {
      const signatures = item.wireSignatures.map(({ method, path }) => `${method} ${path}`);
      lines.push(
        `| ${index + 1}. ${item.title} | ${item.expectedWrites} | ${signatures.join("; ") || "keine"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function createRolesGroup(modelId, id = randomUUID()) {
  const group = {
    schemaVersion: 1,
    kind: "roles-browser-v1",
    id,
    ...rolesProjectIdentity({ id }),
    modelId,
    phase: "prepared",
    results: [],
    state: {},
  };
  initializeRoleScorecards(group, ROLE_STEP_CATALOG);
  return group;
}

function pendingGroup(session) {
  const group = JSON.parse(readPrivateFile(join(session.directory, "roles-browser.pending.json")));
  assert.equal(group.kind, "roles-browser-v1");
  assert.equal(group.schemaVersion, 1);
  assert.match(group.id, /^[0-9a-f-]{36}$/u);
  assert.match(group.key, /^ZR[A-F0-9]{8}$/u);
  assert.deepEqual({ key: group.key, name: group.name }, rolesProjectIdentity(group));
  if (group.rolesSetup !== undefined) {
    assert.equal(group.rolesSetup.project.key, group.key);
    assert.equal(group.rolesSetup.project.name, group.name);
  }
  return group;
}

async function reconciliationObservation(session, group, ports) {
  const inventory = ports.inventory ?? projectInventory;
  const read = ports.read ?? projectAgileRead;
  const oracle = { ...session, oracleAuthorization: basicAuth(session, "admin") };
  const projects = (await inventory(oracle)).filter((project) => project.key === group.key);
  assert.ok(projects.length <= 1);
  let issues = [];
  let boards = [];
  if (projects.length === 1) {
    issues = await nativePages(
      (path) => read(oracle, path),
      `/rest/api/2/search?jql=${encodeURIComponent(`project = ${group.key} ORDER BY key`)}&fields=status,issuetype`,
      "issues",
    );
    boards = await nativePages(
      (path) => read(oracle, path),
      `/rest/agile/1.0/board?projectKeyOrId=${group.key}`,
      "values",
    );
  }
  return {
    projectPresent: projects.length === 1,
    issueCount: issues.length,
    boardCount: boards.length,
    identityDigest: createHash("sha256")
      .update(
        JSON.stringify({
          projects,
          issues: issues.map(({ id, key }) => ({ id, key })),
          boards: boards.map(({ id }) => ({ id })),
        }),
      )
      .digest("hex"),
  };
}

export async function reconcileBrowserRoles(session, ports = {}) {
  const group = pendingGroup(session);
  const observed = await reconciliationObservation(session, group, ports);
  privateJson(
    join(session.directory, `roles-reconciliation-${randomUUID()}.json`),
    {
      schemaVersion: 1,
      groupId: group.id,
      phase: "reconciled-read-only",
      ...observed,
    },
    true,
  );
  // The pending marker survives. Reading observations never resumes an uncertain mutation.
  return observed;
}

async function liveRoles(session, group, selected, persist) {
  const fixture = await seedBrowserRoles(session, group, persist);
  group.fixture = fixture;
  group.phase = "fixture-ready";
  persist();
  const witness = projectAgileWitness(session);
  const { withLiveChat } = await import("./chat-read.mjs");
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
      runBrowserRolesJourney({ ...context, session }, group, fixture, witness, persist),
  });
}

function allRolesVerified(group) {
  return (
    group.browserCleanup?.failed === 0 &&
    group.browserCleanup.closed === Object.keys(ROLE_LABELS).length &&
    Object.values(group.scorecards).every((report) => roleVerdict(report) === "green")
  );
}

export async function runBrowserRolesCommand(values) {
  const selected = browserRolesArguments(values);
  if (selected.plan) {
    console.log(rolesWirePlanMarkdown());
    return;
  }
  const session = loadSession(selected.directory);
  if (selected.reconcile) {
    await reconcileBrowserRoles(session);
    console.log(
      JSON.stringify({ qualification: "jira-browser-roles", phase: "reconciled-read-only" }),
    );
    return;
  }
  assert.ok(
    (await requireLicense(session)) >= 1800,
    "The current license needs thirty minutes; no automatic restart",
  );
  const group = createRolesGroup(selected.modelId);
  const pending = join(session.directory, "roles-browser.pending.json");
  privateJson(pending, group, true);
  const persist = () => privateJson(pending, group);
  try {
    await liveRoles(session, group, selected, persist);
    assert.ok(
      allRolesVerified(group),
      "Every role, step and reload must be independently verified",
    );
    group.phase = "completed";
    privateJson(join(session.directory, `roles-browser-${group.id}.json`), group, true);
    rmSync(pending);
  } finally {
    writeRoleScorecards(session, group);
    if (group.phase !== "completed") persist();
  }
  console.log(
    JSON.stringify({
      qualification: "jira-browser-roles",
      phase: "completed",
      roles: 3,
      steps: 30,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBrowserRolesCommand(process.argv.slice(2)).catch(() => {
    console.log(JSON.stringify({ qualification: "jira-browser-roles", phase: "incomplete" }));
    process.exitCode = 1;
  });
}
