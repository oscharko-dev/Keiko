import { chmodSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { step, readableResultFindings } from "./browser-journey-step.mjs";
import { ROLE_STEP_CATALOG, ROLE_STEP_IDS, buildRoleStep } from "./browser-roles-steps.mjs";
import { verifyBrowserRoleBindings } from "./browser-roles-setup.mjs";
import {
  ROLE_LABELS,
  initializeRoleScorecards,
  recordRoleStep,
  writeRoleScorecards,
} from "./browser-roles-scorecard.mjs";

const TERMINAL_TURN_STATES = new Set(["completed", "failed", "cancelled"]);

/** Dev works while sprint 1 is active; PL then closes it and moves its remaining membership. */
export function rolesExecutionPlan(ids = ROLE_STEP_IDS) {
  const selected = (role, values) => values.map((id) => ({ role, id }));
  return [
    ...selected("projectLead", ids.projectLead.slice(0, 7)),
    ...selected("developer", ids.developer),
    ...selected("projectLead", ids.projectLead.slice(7)),
    ...selected("techLead", ids.techLead),
  ];
}

async function workflowOwner() {
  return import("./browser-workflow-turn.mjs");
}

async function observeRoleBindings(shared, opened, previous) {
  const { currentChat, credential } = await import("./consent-lifecycle.mjs");
  const observations = await Promise.all(
    Object.keys(ROLE_LABELS).map(async (role) => {
      const expectedChatId = opened[role].chat.id;
      const chat = await currentChat(shared.context, expectedChatId);
      return [
        role,
        {
          expectedChatId,
          expectedLabel: ROLE_LABELS[role],
          chat,
          credential: await credential(shared.context, chat.jiraPodBinding.podId),
        },
      ];
    }),
  );
  return verifyBrowserRoleBindings(shared.fixture, Object.fromEntries(observations), previous);
}

function runtimePorts(overrides) {
  return {
    catalog: ROLE_STEP_CATALOG,
    ids: ROLE_STEP_IDS,
    buildStep: buildRoleStep,
    step,
    findings: readableResultFindings,
    openBrowser: async (...args) => (await workflowOwner()).openWorkflowBrowser(...args),
    history: async (...args) => (await workflowOwner()).workflowHistory(...args),
    sendTurn: async (...args) => (await workflowOwner()).sendBrowserTurn(...args),
    bindings: observeRoleBindings,
    ready: (environment) =>
      environment.region.getByRole("textbox", { name: "Chat message", exact: true }).waitFor(),
    capture: (environment, path) => environment.region.screenshot({ path }),
    writeReports: writeRoleScorecards,
    ...overrides,
  };
}

function roleEnvironment(opened, shared, role, ports) {
  const environment = { ...opened, ...shared, role, completedTurns: 0, submissionPending: false };
  environment.sendTurn = async (...args) => {
    environment.submissionPending = true;
    const turn = await ports.sendTurn(...args);
    environment.lastTurn = turn;
    environment.submissionPending = !TERMINAL_TURN_STATES.has(turn.user?.turnState);
    if (!environment.submissionPending) environment.completedTurns += 1;
    return turn;
  };
  return environment;
}

async function buildCurrentStep(environment, id, ports) {
  environment.witness.arm([]);
  environment.lastTurn = undefined;
  try {
    return await ports.buildStep(environment, environment.role, id);
  } catch {
    return undefined;
  }
}

async function runCurrentStep(environment, id, ports, beforeTurn) {
  const { group, role, witness, persist } = environment;
  group.activeRole = role;
  group.activeStep = id;
  persist();
  const resultIndex = group.results.length;
  let definition;
  let proof;
  let error;
  try {
    await beforeTurn();
    definition = await buildCurrentStep(environment, id, ports);
  } catch {
    witness.arm([]);
    environment.lastTurn = undefined;
    error = { stage: "binding" };
  }
  if (error === undefined && definition === undefined) error = { code: "prerequisite" };
  if (error === undefined) {
    try {
      proof = await ports.step(environment, { ...definition, requireReadableSummary: true });
    } catch (failure) {
      error = failure;
    }
  }
  const result = group.results[resultIndex];
  recordRoleStep(group, role, id, {
    proof,
    error,
    turn: environment.lastTurn,
    wire: witness.snapshot(),
    findings: result?.presentationFindings ?? 0,
  });
  persist();
  return error === undefined;
}

async function observeRoleReload(environment, ports, wire) {
  const { context, witness } = environment;
  const before = await ports.history(context, environment.chat.id);
  await environment.page.reload();
  await ports.ready(environment);
  if (!isDeepStrictEqual(await ports.history(context, environment.chat.id), before))
    return { status: "red", code: "reload-history" };
  if (!isDeepStrictEqual(witness.snapshot(), wire)) return { status: "red", code: "reload-write" };
  const findings = environment.completedTurns === 0 ? 0 : await ports.findings(environment);
  if (findings !== 0)
    return { status: "red", code: "presentation", presentationFindings: findings };
  return { status: "green", code: "no-replay", presentationFindings: 0 };
}

async function finishRole(environment, ports) {
  const report = environment.group.scorecards[environment.role];
  const wire = environment.witness.snapshot();
  try {
    report.reload = environment.submissionPending
      ? { status: "unverified", code: "unsettled-turn" }
      : await observeRoleReload(environment, ports, wire);
  } catch {
    report.reload = { status: "unverified", code: "reload-unavailable" };
  }
  try {
    const file = ["roles", environment.role, environment.group.id].join("-") + ".png";
    const path = join(environment.context.session.directory, file);
    await ports.capture(environment, path);
    chmodSync(path, 0o600);
    report.reload.screenshot = file;
    if (!isDeepStrictEqual(environment.witness.snapshot(), wire))
      report.reload = { ...report.reload, status: "red", code: "reload-write" };
  } catch {
    if (report.reload.status !== "red")
      report.reload = { ...report.reload, status: "unverified", code: "screenshot-unavailable" };
    report.reload.capture = { status: "unverified", code: "screenshot-unavailable" };
  }
  if (!isDeepStrictEqual(environment.witness.snapshot(), wire))
    report.reload = { ...report.reload, status: "red", code: "reload-write" };
  environment.persist();
}

async function closeRoles(opened, group) {
  const results = await Promise.allSettled(
    Object.values(opened).map(({ browser }) => Promise.resolve().then(() => browser.close())),
  );
  group.browserCleanup = {
    closed: results.filter(({ status }) => status === "fulfilled").length,
    failed: results.filter(({ status }) => status === "rejected").length,
  };
}

async function openRoles(shared, ports, opened) {
  const results = await Promise.allSettled(
    Object.keys(ROLE_LABELS).map(async (role) => {
      const browser = await ports.openBrowser(shared.context, {
        label: ROLE_LABELS[role],
        tokenFile: shared.fixture.actors[role].tokenFile,
        // Native Jira permissions remain those of the separate PAT; this is the local human opt-in.
        administration: true,
      });
      opened[role] = roleEnvironment(browser, shared, role, ports);
      shared.group.chats ??= {};
      shared.group.chats[role] = browser.chat.id;
      shared.persist();
    }),
  );
  if (results.some(({ status }) => status === "rejected"))
    throw new TypeError("Role browser initialization is unavailable");
}

function executePlan(shared, opened, ports) {
  return rolesExecutionPlan(ports.ids).reduce(async (previous, selected) => {
    if (!(await previous)) return false;
    const beforeTurn = async () => {
      if (selected.role === "projectLead" && selected.id === "PL8") {
        await ports.bindings(shared, opened, shared.group.roleBindings);
        shared.group.bindingRecheck = { status: "verified", roles: 3 };
        shared.persist();
      }
    };
    return runCurrentStep(opened[selected.role], selected.id, ports, beforeTurn);
  }, Promise.resolve(true));
}

function finishRoles(opened, ports) {
  return Object.values(opened).reduce(
    (previous, environment) => previous.then(() => finishRole(environment, ports)),
    Promise.resolve(),
  );
}

/** No retry or replay: contradictory or unavailable step evidence leaves the pending intent. */
export async function runBrowserRolesJourney(
  context,
  group,
  fixture,
  witness,
  persist,
  overrides = {},
) {
  const ports = runtimePorts(overrides);
  initializeRoleScorecards(group, ports.catalog);
  const opened = {};
  const shared = { context, group, fixture, witness, persist };
  try {
    await openRoles(shared, ports, opened);
    group.roleBindings = await ports.bindings(shared, opened);
    persist();
    await executePlan(shared, opened, ports);
  } finally {
    try {
      witness.arm([]);
      await finishRoles(opened, ports);
    } finally {
      await closeRoles(opened, group);
      ports.writeReports(context.session, group);
      persist();
    }
  }
  return group.scorecards;
}
