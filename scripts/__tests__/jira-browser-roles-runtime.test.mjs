import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runBrowserRolesJourney,
  rolesExecutionPlan,
} from "../testing/jira-chat-lab/browser-roles-journey.mjs";
import {
  ROLE_LABELS,
  initializeRoleScorecards,
  recordRoleStep,
  roleVerdict,
  writeRoleScorecards,
} from "../testing/jira-chat-lab/browser-roles-scorecard.mjs";
import { ROLE_STEP_CATALOG } from "../testing/jira-chat-lab/browser-roles-catalog.mjs";
import { rolesProjectIdentity } from "../testing/jira-chat-lab/browser-roles-setup.mjs";
import {
  browserRolesArguments,
  createRolesGroup,
  reconcileBrowserRoles,
  runBrowserRolesCommand,
} from "../testing/jira-chat-lab/browser-roles.mjs";
import { privateJson } from "../testing/jira-chat-lab/private-json.mjs";
import { compareStrings } from "../lib/compare-strings.mjs";

const GROUP_ID = "01234567-89ab-4cde-8fab-0123456789ab";
const ROLES = ["projectLead", "developer", "techLead"];
const PRIVATE_CONTENT = "synthetic-private-content-must-never-enter-scorecards";
const roots = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function privateSession() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-roles-runtime-"));
  roots.push(directory);
  chmodSync(directory, 0o700);
  return { directory };
}

function emptyWire() {
  return { attempted: 0, forwarded: 0, blocked: 0, statuses: [] };
}

function dispatchWitness() {
  let wire = emptyWire();
  let effects = 0;
  return {
    arm: vi.fn(() => {
      wire = emptyWire();
    }),
    snapshot: () => structuredClone(wire),
    effect() {
      effects += 1;
      wire.attempted += 1;
      wire.forwarded += 1;
      wire.statuses.push(200);
    },
    totalEffects: () => effects,
  };
}

function roleFixture() {
  return {
    actors: Object.fromEntries(
      ROLES.map((role) => [
        role,
        {
          key: `synthetic-${role}-key`,
          name: `synthetic-${role}`,
          tokenFile: `/private/synthetic/${role}-token`,
        },
      ]),
    ),
  };
}

function stepWrites(state) {
  return ROLE_STEP_CATALOG[state.group.activeRole].find(({ id }) => id === state.group.activeStep)
    .expectedWrites;
}

function browserFor(state, role) {
  return {
    chat: { id: `synthetic-chat-${role}` },
    region: {},
    page: {
      reload: vi.fn(async () => {
        state.events.push(`reload:${role}`);
        if (state.options.reloadWriteRole === role) state.witness.effect();
      }),
    },
    browser: {
      close: vi.fn(() => {
        state.events.push(`close:${role}`);
        if (state.options.syncCloseFailureRole === role) throw new TypeError(PRIVATE_CONTENT);
        if (state.options.closeFailureRole === role)
          return Promise.reject(new TypeError(PRIVATE_CONTENT));
        return Promise.resolve();
      }),
    },
  };
}

function browserPorts(state) {
  return {
    openBrowser: vi.fn(async (_context, options) => {
      const role = ROLES.find((candidate) => ROLE_LABELS[candidate] === options.label);
      state.events.push(`open:${role}`);
      if (state.options.openFailureRole === role) throw new TypeError(PRIVATE_CONTENT);
      return state.browsers[role];
    }),
    history: vi.fn(async (_context, chatId) => {
      const role = ROLES.find((candidate) => state.browsers[candidate].chat.id === chatId);
      if (state.options.historyFailureRole === role) throw new TypeError(PRIVATE_CONTENT);
      const reads = (state.historyReads[role] ?? 0) + 1;
      state.historyReads[role] = reads;
      const changed = state.options.reloadHistoryRole === role && reads > 1;
      return { messages: [{ id: changed ? "unexpected-message" : "retained-message" }] };
    }),
    ready: vi.fn(async (environment) => {
      state.events.push(`ready:${environment.role}`);
    }),
    findings: vi.fn(async (environment) =>
      state.options.findingsRole === environment.role ? 3 : 0,
    ),
    capture: vi.fn(async (environment, path) => {
      state.events.push(`capture:${environment.role}`);
      if (state.options.captureFailureRole === environment.role)
        throw new TypeError(PRIVATE_CONTENT);
      writeFileSync(path, "synthetic screenshot fixture", { mode: 0o644 });
      if (state.options.captureWriteRole === environment.role) state.witness.effect();
    }),
    writeReports: vi.fn((session, group) => writeRoleScorecards(session, group)),
  };
}

function turnPorts(state) {
  return {
    catalog: ROLE_STEP_CATALOG,
    ids: Object.fromEntries(
      ROLES.map((role) => [role, ROLE_STEP_CATALOG[role].map(({ id }) => id)]),
    ),
    bindings: vi.fn(async (_shared, opened, previous) => {
      expect(Object.keys(opened).sort(compareStrings)).toEqual([...ROLES].sort(compareStrings));
      const phase = previous === undefined ? "opening" : "recheck";
      state.events.push(`bindings:${phase}`);
      if (state.options.bindingFailure === phase) throw new TypeError(PRIVATE_CONTENT);
      if (previous !== undefined) expect(previous).toBe(state.bindingSnapshot);
      return state.bindingSnapshot;
    }),
    buildStep: vi.fn(async (_environment, role, id) => {
      state.events.push(`build:${id}`);
      if (state.options.buildFailure === id) throw new TypeError(PRIVATE_CONTENT);
      return { id, name: id, role, prompt: `Synthetic ${id}`, wire: [] };
    }),
    sendTurn: vi.fn(async (_page, _region, _context, _chatId, _prompt) => {
      const id = state.group.activeStep;
      state.events.push(`send:${id}`);
      if (state.options.uncertainStep === id) throw new TypeError(PRIVATE_CONTENT);
      return {
        user: { id: `user-${id}`, turnState: "completed" },
        decisions: stepWrites(state),
        clientTurnId: `turn-${id}`,
        exchanges: [],
        answer: PRIVATE_CONTENT,
      };
    }),
    step: vi.fn(async (environment, definition) => {
      const id = definition.id;
      state.events.push(`step:${id}`);
      if (state.options.presentationStep === id) {
        if (state.options.currentFindings !== undefined)
          state.group.results.push({ presentationFindings: state.options.currentFindings });
        throw Object.assign(new TypeError(PRIVATE_CONTENT), { stage: "presentation" });
      }
      if (state.options.failedStep === id)
        throw Object.assign(new TypeError(PRIVATE_CONTENT), { stage: "readback" });
      const turn = await environment.sendTurn(
        environment.page,
        environment.region,
        environment.context,
        environment.chat.id,
        definition.prompt,
      );
      for (let index = 0; index < stepWrites(state); index += 1) state.witness.effect();
      state.group.results.push({ name: id, presentationFindings: 0 });
      return { status: "verified", count: 1, clientTurnId: turn.clientTurnId };
    }),
  };
}

function runtimeFixture(options = {}) {
  const session = privateSession();
  const group = createRolesGroup("synthetic-model", GROUP_ID);
  group.phase = "fixture-ready";
  const state = {
    options,
    session,
    group,
    events: [],
    historyReads: {},
    witness: dispatchWitness(),
    bindingSnapshot: Object.freeze({ schemaVersion: 1, roles: 3 }),
  };
  state.browsers = Object.fromEntries(ROLES.map((role) => [role, browserFor(state, role)]));
  const ports = { ...browserPorts(state), ...turnPorts(state) };
  const pending = join(session.directory, "roles-browser.pending.json");
  const persist = vi.fn(() => privateJson(pending, group));
  const fixture = roleFixture();
  const context = { session, modelId: "synthetic-model" };
  const run = () => runBrowserRolesJourney(context, group, fixture, state.witness, persist, ports);
  return { ...state, ports, fixture, pending, persist, run };
}

function row(f, role, id) {
  return f.group.scorecards[role].steps.find((item) => item.id === id);
}

function reportPaths(f, role) {
  const stem = join(f.session.directory, `roles-scorecard-${f.group.id}-${role}`);
  return { json: `${stem}.json`, markdown: `${stem}.md` };
}

function expectAllClosed(f, except) {
  for (const role of ROLES.filter((candidate) => candidate !== except))
    expect(f.browsers[role].browser.close).toHaveBeenCalledTimes(1);
}

describe("offline role browser orchestration", () => {
  it("runs the actual 11/10/9 plan and checks retained PL bindings before PL8 can write", async () => {
    const f = runtimeFixture();
    await f.run();
    const expected = [
      ...Array.from({ length: 7 }, (_, index) => `PL${index + 1}`),
      ...Array.from({ length: 10 }, (_, index) => `Dev${index + 1}`),
      ...Array.from({ length: 4 }, (_, index) => `PL${index + 8}`),
      ...Array.from({ length: 9 }, (_, index) => `TL${index + 1}`),
    ];
    expect(rolesExecutionPlan().map(({ id }) => id)).toEqual(expected);
    expect(f.events.filter((event) => event.startsWith("send:"))).toEqual(
      expected.map((id) => `send:${id}`),
    );
    expect(f.ports.bindings).toHaveBeenCalledTimes(2);
    expect(f.ports.bindings.mock.calls[0][2]).toBeUndefined();
    expect(f.ports.bindings.mock.calls[1][2]).toBe(f.bindingSnapshot);
    expect(f.events.indexOf("bindings:opening")).toBeLessThan(f.events.indexOf("build:PL1"));
    expect(f.events.indexOf("send:Dev10")).toBeLessThan(f.events.indexOf("bindings:recheck"));
    expect(f.events.indexOf("bindings:recheck")).toBeLessThan(f.events.indexOf("build:PL8"));
    expect(f.group.bindingRecheck).toEqual({ status: "verified", roles: 3 });
    expect(ROLES.map((role) => roleVerdict(f.group.scorecards[role]))).toEqual([
      "green",
      "green",
      "green",
    ]);
    expectAllClosed(f);
  });

  it("captures all three reloads privately without another turn or native write", async () => {
    const f = runtimeFixture();
    await f.run();
    const plannedWrites = Object.values(ROLE_STEP_CATALOG)
      .flat()
      .reduce((sum, item) => sum + item.expectedWrites, 0);
    expect(f.witness.totalEffects()).toBe(plannedWrites);
    expect(f.ports.sendTurn).toHaveBeenCalledTimes(30);
    expect(f.ports.capture).toHaveBeenCalledTimes(3);
    expect(statSync(f.session.directory).mode & 0o777).toBe(0o700);
    for (const role of ROLES) {
      expect(f.browsers[role].page.reload).toHaveBeenCalledTimes(1);
      expect(f.events.indexOf(`reload:${role}`)).toBeLessThan(f.events.indexOf(`ready:${role}`));
      const screenshot = join(f.session.directory, f.group.scorecards[role].reload.screenshot);
      expect(statSync(screenshot).mode & 0o777).toBe(0o600);
      for (const path of Object.values(reportPaths(f, role)))
        expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(f.group.browserCleanup).toEqual({ closed: 3, failed: 0 });
    expect(existsSync(f.pending)).toBe(true);
  });

  it("closes and captures every successfully opened browser when one role cannot open", async () => {
    const f = runtimeFixture({ openFailureRole: "developer" });
    await expect(f.run()).rejects.toThrow("initialization");
    expectAllClosed(f, "developer");
    expect(f.ports.sendTurn).not.toHaveBeenCalled();
    expect(f.ports.capture).toHaveBeenCalledTimes(2);
    expect(f.group.browserCleanup).toEqual({ closed: 2, failed: 0 });
    expect(f.ports.writeReports).toHaveBeenCalledTimes(1);
  });

  it.each(["opening", "recheck"])(
    "stops before writes when the %s binding proof is unavailable",
    async (phase) => {
      const f = runtimeFixture({ bindingFailure: phase });
      if (phase === "opening") await expect(f.run()).rejects.toThrow();
      else await f.run();
      const expectedTurns = phase === "opening" ? 0 : 17;
      expect(f.ports.sendTurn).toHaveBeenCalledTimes(expectedTurns);
      expect(f.events).not.toContain("send:PL8");
      expectAllClosed(f);
      if (phase === "recheck") expect(row(f, "projectLead", "PL8").status).toBe("red");
    },
  );

  it("never reloads or retries an uncertain submitted turn but still captures all roles", async () => {
    const f = runtimeFixture({ uncertainStep: "PL1" });
    await f.run();
    expect(f.ports.sendTurn).toHaveBeenCalledTimes(1);
    expect(f.browsers.projectLead.page.reload).not.toHaveBeenCalled();
    expect(f.group.scorecards.projectLead.reload).toMatchObject({
      status: "unverified",
      code: "unsettled-turn",
    });
    expect(f.ports.capture).toHaveBeenCalledTimes(3);
    expect(f.ports.buildStep).toHaveBeenCalledTimes(1);
    expect(row(f, "projectLead", "PL2").status).toBe("unverified");
    expect(row(f, "developer", "Dev1").detail.code).toBe("not-run");
    expect(existsSync(f.pending)).toBe(true);
    expectAllClosed(f);
  });

  it("stops failed readback without automatically running remaining steps", async () => {
    const f = runtimeFixture({ failedStep: "PL3" });
    await f.run();
    expect(f.ports.step).toHaveBeenCalledTimes(3);
    expect(f.ports.sendTurn).toHaveBeenCalledTimes(2);
    expect(row(f, "projectLead", "PL3")).toMatchObject({
      status: "red",
      detail: { code: "readback" },
    });
    expect(row(f, "projectLead", "PL4").status).toBe("unverified");
    expect(f.group.scorecards.developer.steps.every((item) => item.detail.code === "not-run")).toBe(
      true,
    );
    expectAllClosed(f);
  });

  it.each([undefined, 3])(
    "uses only the current step's presentation count: %s",
    async (currentFindings) => {
      const f = runtimeFixture({ presentationStep: "PL1", currentFindings });
      f.group.results.push({ name: "old-result", presentationFindings: 17 });
      await f.run();
      expect(row(f, "projectLead", "PL1").presentationFindings).toBe(currentFindings ?? 0);
      expect(row(f, "projectLead", "PL1").status).toBe("red");
      expect(f.ports.step).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["reloadHistoryRole", "reload-history"],
    ["reloadWriteRole", "reload-write"],
    ["captureWriteRole", "reload-write"],
    ["findingsRole", "presentation"],
  ])("marks an observed %s contradiction red", async (option, code) => {
    const f = runtimeFixture({ [option]: "projectLead" });
    await f.run();
    expect(f.group.scorecards.projectLead.reload).toMatchObject({ status: "red", code });
    expect(roleVerdict(f.group.scorecards.projectLead)).toBe("red");
    expect(f.ports.capture).toHaveBeenCalledTimes(3);
    expectAllClosed(f);
  });

  it.each(["captureFailureRole", "historyFailureRole"])(
    "keeps %s unavailable and captures/closes remaining roles",
    async (option) => {
      const f = runtimeFixture({ [option]: "projectLead" });
      await f.run();
      expect(roleVerdict(f.group.scorecards.projectLead)).toBe("unverified");
      expect(f.ports.capture).toHaveBeenCalledTimes(3);
      expectAllClosed(f);
    },
  );

  it.each([
    ["reloadHistoryRole", "reload-history"],
    ["findingsRole", "presentation"],
  ])("preserves a red %s result when screenshot capture also fails", async (option, code) => {
    const f = runtimeFixture({ [option]: "projectLead", captureFailureRole: "projectLead" });
    await f.run();
    const report = f.group.scorecards.projectLead;
    expect(report.reload).toMatchObject({
      status: "red",
      code,
      capture: { status: "unverified", code: "screenshot-unavailable" },
    });
    if (option === "findingsRole") expect(report.reload.presentationFindings).toBe(3);
    expect(roleVerdict(report)).toBe("red");
    expectAllClosed(f);
  });

  it("retains rejected browser cleanup as unverified evidence and attempts all three closes", async () => {
    const f = runtimeFixture({ closeFailureRole: "projectLead" });
    await f.run();
    expectAllClosed(f);
    expect(f.group.browserCleanup).toEqual({ closed: 2, failed: 1 });
    for (const role of ROLES) {
      const report = JSON.parse(readFileSync(reportPaths(f, role).json, "utf8"));
      expect(report.status).not.toBe("green");
      expect(report.browserCleanup.failed).toBe(1);
    }
  });

  it("attempts every close even if an injected browser close throws synchronously", async () => {
    const f = runtimeFixture({ syncCloseFailureRole: "projectLead" });
    await f.run();
    expectAllClosed(f);
    expect(f.group.browserCleanup).toEqual({ closed: 2, failed: 1 });
    expect(f.ports.writeReports).toHaveBeenCalledTimes(1);
  });
});

function gradedGroup() {
  const group = createRolesGroup("synthetic-model", GROUP_ID);
  initializeRoleScorecards(group, ROLE_STEP_CATALOG);
  for (const role of ROLES) {
    for (const definition of ROLE_STEP_CATALOG[role])
      recordRoleStep(group, role, definition.id, {
        proof: { status: "verified", count: 1 },
        turn: { decisions: 1 },
        wire: emptyWire(),
      });
    group.scorecards[role].reload = { status: "green", code: "no-replay" };
  }
  group.browserCleanup = { closed: 3, failed: 0 };
  group.phase = "completed";
  return group;
}

describe("private body-free role scorecards", () => {
  it("writes real 0600 JSON/Markdown without PAT, native body, answer or error.message", () => {
    const session = privateSession();
    const group = gradedGroup();
    group.fixture = { apiToken: PRIVATE_CONTENT, native: { description: PRIVATE_CONTENT } };
    recordRoleStep(group, "developer", "Dev4", {
      proof: { status: "verified", native: PRIVATE_CONTENT },
      error: Object.assign(new TypeError(PRIVATE_CONTENT), { stage: "readback" }),
      turn: { decisions: 2, answer: PRIVATE_CONTENT, messages: [{ content: PRIVATE_CONTENT }] },
      wire: { attempted: 2, forwarded: 1, blocked: 1, statuses: [200, PRIVATE_CONTENT] },
    });
    writeRoleScorecards(session, group);
    expect(readdirSync(session.directory)).toHaveLength(6);
    for (const name of readdirSync(session.directory)) {
      const path = join(session.directory, name);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toContain(PRIVATE_CONTENT);
    }
    const report = JSON.parse(
      readFileSync(join(session.directory, `roles-scorecard-${group.id}-developer.json`), "utf8"),
    );
    expect(report.status).toBe("red");
    expect(report.steps[3]).toMatchObject({
      approvals: 2,
      detail: { code: "readback" },
      wire: { attempted: 2, forwarded: 1, blocked: 1, statuses: [200] },
    });
  });

  it.each([undefined, null, { status: "unknown" }, { status: "succeeded-unconfirmed" }])(
    "keeps unavailable or unrecognized proof unverified: %j",
    (proof) => {
      const group = gradedGroup();
      const result = recordRoleStep(group, "projectLead", "PL1", { proof, wire: emptyWire() });
      expect(result).toMatchObject({ status: "unverified", detail: { code: "proof-unavailable" } });
      expect(roleVerdict(group.scorecards.projectLead)).toBe("unverified");
    },
  );

  it("keeps independently read but product-unconfirmed effects unverified", () => {
    const group = gradedGroup();
    const result = recordRoleStep(group, "projectLead", "PL1", {
      proof: { status: "unverified", outcomes: ["succeeded-unconfirmed"], native: PRIVATE_CONTENT },
      wire: emptyWire(),
    });
    expect(result).toMatchObject({ status: "unverified", detail: { code: "product-unconfirmed" } });
    expect(result.proofDigest).toMatch(/^[a-f\d]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_CONTENT);
    expect(roleVerdict(group.scorecards.projectLead)).toBe("unverified");
  });

  it.each(["wire", "approval", "readback", "answer", "presentation", "binding"])(
    "makes a concrete %s contradiction red even when all reloads passed",
    (stage) => {
      const group = gradedGroup();
      recordRoleStep(group, "techLead", "TL1", {
        error: { stage, message: PRIVATE_CONTENT },
        wire: emptyWire(),
      });
      expect(roleVerdict(group.scorecards.techLead)).toBe("red");
      expect(group.scorecards.techLead.steps[0].detail).toEqual({ code: stage });
    },
  );

  it("does not publish green while the closing license check has not completed", () => {
    const session = privateSession();
    const group = gradedGroup();
    group.phase = "fixture-ready";
    writeRoleScorecards(session, group);
    const path = join(session.directory, `roles-scorecard-${group.id}-projectLead.json`);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("unverified");
  });

  it.each([{ closed: 2, failed: 1 }, { closed: 2, failed: 0 }, undefined])(
    "refuses green artifacts without complete successful cleanup: %j",
    (cleanup) => {
      const session = privateSession();
      const group = gradedGroup();
      group.browserCleanup = cleanup;
      writeRoleScorecards(session, group);
      for (const name of readdirSync(session.directory).filter((item) => item.endsWith(".json")))
        expect(JSON.parse(readFileSync(join(session.directory, name), "utf8")).status).not.toBe(
          "green",
        );
    },
  );
});

function reconciliationFixture() {
  const session = privateSession();
  mkdirSync(join(session.directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(session.directory, "secrets", "admin-password"), "synthetic-fixture-value", {
    mode: 0o600,
  });
  const group = createRolesGroup("synthetic-model", GROUP_ID);
  group.rolesSetup = {
    phase: "write-reserved",
    project: rolesProjectIdentity(group),
    currentIntent: {
      actor: "admin",
      name: "roles-create-project",
      method: "POST",
      path: "/rest/api/2/project",
    },
  };
  const pending = join(session.directory, "roles-browser.pending.json");
  privateJson(pending, group, true);
  const ports = {
    inventory: vi.fn(async () => [
      { id: "71001", key: group.key, name: group.name, native: PRIVATE_CONTENT },
    ]),
    read: vi.fn(async (_oracle, path) => {
      if (path.startsWith("/rest/api/2/search?"))
        return {
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            { id: "81001", key: `${group.key}-1`, fields: { description: PRIVATE_CONTENT } },
          ],
        };
      if (path.startsWith("/rest/agile/1.0/board?"))
        return { startAt: 0, maxResults: 100, total: 1, isLast: true, values: [{ id: "91001" }] };
      throw new TypeError("Unexpected reconciliation path");
    }),
  };
  return { session, group, pending, ports };
}

describe("offline roles CLI and read-only reconciliation", () => {
  it("parses only the explicit live, reconcile and plan forms", () => {
    expect(browserRolesArguments(["--plan"])).toEqual({ plan: true });
    expect(browserRolesArguments(["/private/session", "--reconcile"])).toEqual({
      directory: "/private/session",
      reconcile: true,
    });
    expect(browserRolesArguments(["/private/session", "synthetic-model"])).toMatchObject({
      modelId: "synthetic-model",
      reconcile: false,
    });
    for (const values of [
      [],
      ["relative", "model"],
      ["/private/session", "--resume"],
      ["/private/session", ""],
      ["/private/session", "bad\nmodel"],
      ["--plan", "extra"],
      ["/private/session", "model", "--reset"],
    ])
      expect(() => browserRolesArguments(values)).toThrow();
  });

  it("prints the 30-step plan without sessions, network or live model calls", async () => {
    const fetch = vi.fn(() => {
      throw new TypeError("Offline plan must not fetch");
    });
    vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runBrowserRolesCommand(["--plan"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const output = log.mock.calls[0][0];
    expect(output.match(/^\| \d+\./gmu)).toHaveLength(30);
    for (const label of Object.values(ROLE_LABELS)) expect(output).toContain(label);
  });

  it("uses the shared SHA-derived project identity in the pending group", () => {
    const group = createRolesGroup("synthetic-model", GROUP_ID);
    expect({ key: group.key, name: group.name }).toEqual(rolesProjectIdentity({ id: GROUP_ID }));
    expect(group.key).not.toBe("ZR01234567");
    expect(ROLES.map((role) => group.scorecards[role].steps.length)).toEqual([11, 10, 9]);
  });

  it("observes native state through GET ports and retains the exact uncertain pending marker", async () => {
    const f = reconciliationFixture();
    const before = readFileSync(f.pending, "utf8");
    const observed = await reconcileBrowserRoles(f.session, f.ports);
    expect(observed).toMatchObject({ projectPresent: true, issueCount: 1, boardCount: 1 });
    expect(observed.identityDigest).toMatch(/^[a-f\d]{64}$/u);
    expect(f.ports.inventory).toHaveBeenCalledTimes(1);
    expect(f.ports.read).toHaveBeenCalledTimes(2);
    expect(readFileSync(f.pending, "utf8")).toBe(before);
    const files = readdirSync(f.session.directory).filter((name) =>
      name.startsWith("roles-reconciliation-"),
    );
    expect(files).toHaveLength(1);
    const path = join(f.session.directory, files[0]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const content = readFileSync(path, "utf8");
    expect(content).not.toContain(PRIVATE_CONTENT);
    expect(content).not.toContain("synthetic-fixture-value");
    expect(JSON.parse(content).phase).toBe("reconciled-read-only");
  });

  it("records an absent project without attempting replacement setup or writes", async () => {
    const f = reconciliationFixture();
    f.ports.inventory.mockResolvedValue([]);
    const observed = await reconcileBrowserRoles(f.session, f.ports);
    expect(observed).toMatchObject({ projectPresent: false, issueCount: 0, boardCount: 0 });
    expect(f.ports.read).not.toHaveBeenCalled();
    expect(existsSync(f.pending)).toBe(true);
  });

  it.each(["group-key", "setup-key"])(
    "rejects a tampered %s before native reads",
    async (target) => {
      const f = reconciliationFixture();
      if (target === "group-key") f.group.key = "ZR00000000";
      else f.group.rolesSetup.project.key = "ZR00000000";
      privateJson(f.pending, f.group);
      const before = readFileSync(f.pending, "utf8");
      await expect(reconcileBrowserRoles(f.session, f.ports)).rejects.toThrow();
      expect(f.ports.inventory).not.toHaveBeenCalled();
      expect(f.ports.read).not.toHaveBeenCalled();
      expect(readFileSync(f.pending, "utf8")).toBe(before);
      expect(
        readdirSync(f.session.directory).some((name) => name.startsWith("roles-reconciliation-")),
      ).toBe(false);
    },
  );
});
