// Amendment 2: prepared Chat DTOs, the orchestrator turn port and a snapshot intent handle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

const ports = vi.hoisted(() => ({ native: vi.fn(), turn: vi.fn() }));
vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  labRequest: ports.native,
  basicAuth: () => {
    throw new Error("Only the verified oracle PAT may read");
  },
}));
import { runProjectSetup } from "../testing/jira-chat-lab/browser-project-setup.mjs";

const roots = [];
const CHAT = "11111111-1111-4111-8111-111111111111";
const DENIED_CHAT = "44444444-4444-4444-8444-444444444444";
const DENIED_POD = "22222222-2222-4222-8222-222222222222";
const PERMITTED_POD = "33333333-3333-4333-8333-333333333333";
let state;

function nativeUser(admin) {
  return {
    key: admin ? "actor-admin" : "actor-denied",
    name: admin ? "synthetic-actor-admin" : "synthetic-actor-denied",
    active: true,
  };
}
function fixtureState() {
  return {
    projects: [{ id: "1", key: "BASE", name: "Synthetic baseline" }],
    boards: [],
    filters: [],
    credentials: [],
    auth: new Map(),
    chats: [],
    globalIssues: 120001,
    targetIssues: 0,
    automaticBoard: true,
    fault: undefined,
  };
}
function intentHandle() {
  let stored = { unrelated: { retained: true } };
  return {
    get state() {
      return structuredClone(stored);
    },
    record: vi.fn(async (name, value) => {
      expect(name).toBe("ac5-project");
      stored = { ...stored, [name]: structuredClone(value) };
    }),
    update: vi.fn(async (patch) => {
      stored = { ...stored, ...structuredClone(patch) };
    }),
  };
}
function fixtureToken(root, admin) {
  const value = randomBytes(24).toString("hex");
  const path = join(root, "secrets", admin ? "admin-token" : "restricted-token");
  writeFileSync(path, value, { mode: 0o600 });
  state.auth.set("Bearer " + value, admin);
  return path;
}
function preparedChat(id, podId) {
  return {
    id,
    projectPath: "/synthetic/workspace",
    selectedModel: "fixture-model",
    status: "open",
    effectiveToolMode: "autonomous-delivery",
    jiraAdministrationEnabled: true,
    localKnowledgeScopes: [],
    jiraPodBinding: {
      podId,
      authenticationGeneration: 1,
      bindingGeneration: 1,
    },
  };
}
function credential(podId, restricted) {
  return {
    provider: "jira",
    deployment: "data-center",
    authScheme: "bearer-pat",
    authRef: restricted ? "opaque-denied" : "opaque-permitted",
    displayName: restricted ? "Limit Run Restricted" : "Limit Run Admin",
    livePod: {
      podId,
      authenticationGeneration: 1,
      verificationRevision: 1,
      verificationStatus: "ok",
      verificationInProgress: false,
    },
  };
}
function fixtureContext() {
  const root = mkdtempSync(join(tmpdir(), "keiko-ac5-"));
  roots.push(root);
  mkdirSync(join(root, "secrets"), { mode: 0o700 });
  state.chats = [preparedChat(CHAT, PERMITTED_POD), preparedChat(DENIED_CHAT, DENIED_POD)];
  state.credentials = [credential(PERMITTED_POD, false), credential(DENIED_POD, true)];
  return {
    sessionDir: root,
    session: { directory: root },
    projectKey: "LIM7",
    locale: "en",
    modelId: "fixture-model",
    signal: new globalThis.AbortController().signal,
    page: { request: { get: vi.fn(browserRead) } },
    chat: structuredClone(state.chats[0]),
    deniedChat: structuredClone(state.chats[1]),
    permittedToken: fixtureToken(root, true),
    deniedToken: fixtureToken(root, false),
    intent: intentHandle(),
    turn: ports.turn,
  };
}
function browserRead(path) {
  const url = new URL(path, "http://127.0.0.1:32209");
  const value =
    url.pathname === "/api/atlassian-connectors/credentials"
      ? { credentials: state.credentials }
      : {
          chats: state.chats.filter(
            (chat) =>
              chat.id === url.searchParams.get("id") &&
              chat.projectPath === url.searchParams.get("projectPath"),
          ),
        };
  return { status: () => 200, json: async () => structuredClone(value) };
}
function nativeCount(url) {
  expect(url.searchParams.get("maxResults")).toBe("0");
  const jql = url.searchParams.get("jql");
  expect(["ORDER BY id ASC", "project = LIM7 ORDER BY id ASC"]).toContain(jql);
  if (state.fault === "jql-400") return { status: 400, value: {} };
  const total = jql.startsWith("project =") ? state.targetIssues : state.globalIssues;
  return {
    status: 200,
    value: { startAt: 0, issues: [], ...(state.fault === "missing-total" ? {} : { total }) },
  };
}
function nativeRead(_session, method, path, auth) {
  expect(method).toBe("GET");
  const url = new URL(path, "https://jira.synthetic.invalid");
  if (url.pathname === "/rest/api/2/search") return nativeCount(url);
  let value;
  if (url.pathname === "/rest/api/2/myself")
    value = nativeUser(state.fault === "same-actor" || state.auth.get(auth));
  else if (url.pathname === "/rest/api/2/mypermissions")
    value = {
      permissions: {
        ADMINISTER: {
          havePermission: state.fault === "denied-admin" || state.auth.get(auth),
        },
      },
    };
  else value = nativeTopology(url);
  return { status: 200, value: structuredClone(value) };
}
function nativeTopology(url) {
  if (url.pathname === "/rest/api/2/project") return state.projects;
  if (url.pathname.startsWith("/rest/api/2/project/"))
    return state.projects.find((item) => item.id === url.pathname.split("/").at(-1));
  if (url.pathname === "/rest/agile/1.0/board")
    return { startAt: 0, total: state.boards.length, values: state.boards };
  if (url.pathname.endsWith("/configuration")) {
    const board = state.boards.find((item) => item.id === url.pathname.split("/").at(-2));
    return { id: board.id, type: board.type, filter: { id: board.filterId } };
  }
  if (url.pathname === "/rest/api/2/filter/defaultShareScope")
    return { scope: state.fault === "shared-filter" ? "GLOBAL" : "PRIVATE" };
  if (url.pathname.startsWith("/rest/api/2/filter/"))
    return state.filters.find((item) => item.id === url.pathname.split("/").at(-1));
  throw new Error("Unexpected hermetic native read");
}
function receipt(operation, data, decisions = 0) {
  return {
    decisions,
    answer: "Synthetic native result",
    exchanges: [
      {
        call: { name: operation.replaceAll(/[.-]/gu, "_") },
        result: { status: "completed", data: { outcome: "succeeded", ...data } },
      },
    ],
  };
}
async function deniedProjectResult(options) {
  if (state.fault === "denied-approval") await options.beforeDecision();
  if (state.fault === "denied-project")
    state.projects.push({ id: "9", key: "ZXEXTRA", name: "Unexpected project" });
  if (state.fault === "denied-issue") state.globalIssues += 1;
  return receipt("jira.create-project", {
    outcome: "rejected",
    reason: state.fault === "wrong-refusal" ? "invalid-input" : "permission-denied",
  });
}
async function createProject(chat, prompt, options) {
  if (chat.id === DENIED_CHAT) return deniedProjectResult(options);
  if (state.fault === "permitted-approval") await options.beforeDecision();
  const key = /key ([A-Z0-9_]+)/u.exec(prompt)[1];
  const name = /name "([^"]+)"/u.exec(prompt)[1];
  state.projects.push({
    id: "100",
    key,
    name,
    projectTypeKey: "software",
    lead: { name: nativeUser(true).name },
  });
  if (state.automaticBoard)
    state.boards.push({
      id: "200",
      type: state.fault === "kanban" ? "kanban" : "scrum",
      filterId: "300",
    });
  if (state.fault === "uncertain-create") throw new Error("NATIVE_BODY_AND_AUTH_MUST_NOT_LEAVE");
  return receipt(
    "jira.create-project",
    { projectKey: key },
    state.fault === "approval-receipt" ? 1 : 0,
  );
}
async function sendTurn(chat, prompt, options) {
  const operation = options.operations[0];
  if (operation === "jira.create-project") return createProject(chat, prompt, options);
  expect(chat.id).toBe(CHAT);
  if (operation === "jira.create-filter") {
    state.filters.push({
      id: "301",
      name: "Limit LIM7 filter",
      jql: "project = LIM7 ORDER BY Rank ASC",
      sharePermissions: [],
    });
    return receipt(operation, { filterId: "301" });
  }
  expect(operation).toBe("jira.board-create");
  state.boards.push({ id: "201", type: "scrum", filterId: "301" });
  return receipt(operation, { boardId: "201" });
}
function configureFault(ctx, fault) {
  state.fault = fault;
  if (fault === "same-pat")
    writeFileSync(ctx.deniedToken, readFileSync(ctx.permittedToken), { mode: 0o600 });
  if (fault === "same-pod") state.chats[1].jiraPodBinding.podId = PERMITTED_POD;
  if (fault === "denied-mode") state.chats[1].effectiveToolMode = "governed-assist";
  if (fault === "denied-administration") state.chats[1].jiraAdministrationEnabled = false;
  if (fault === "denied-knowledge")
    state.chats[1].localKnowledgeScopes = [{ kind: "capsule", capsuleId: "fixture" }];
  if (fault === "unsafe-file") chmodSync(ctx.deniedToken, 0o644);
  if (fault === "shared-filter") state.automaticBoard = false;
}
function stepState(ctx) {
  return ctx.intent.state["ac5-project"];
}

beforeEach(() => {
  vi.clearAllMocks();
  state = fixtureState();
  ports.native.mockImplementation(nativeRead);
  ports.turn.mockImplementation(sendTurn);
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AC5 Amendment 2 prepared Chat contract", () => {
  it.each([true, false])(
    "uses only ctx.turn on the provided Chats and expects zero Full-access approvals (automatic board %s)",
    async (automaticBoard) => {
      const ctx = fixtureContext();
      state.automaticBoard = automaticBoard;
      expect(await runProjectSetup(ctx, { deniedActor: true })).toMatchObject({
        step: "ac5-project",
        status: "green",
        counts: {
          deniedAttempts: 1,
          deniedProjects: 0,
          deniedIssues: 0,
          createdProjects: 1,
          issues: 0,
          approvals: 0,
        },
      });
      expect(ctx.turn.mock.calls[0][0]).toBe(ctx.deniedChat);
      for (const call of ctx.turn.mock.calls.slice(1)) expect(call[0]).toBe(ctx.chat);
      expect(ctx.turn).toHaveBeenCalledTimes(automaticBoard ? 2 : 4);
      expect(state.boards).toHaveLength(1);
      expect(state.boards[0].type).toBe("scrum");
      expect(ctx.intent.record).toHaveBeenCalled();
      expect(ctx.intent).not.toHaveProperty("steps");
      expect(ctx.intent.state.unrelated).toEqual({ retained: true });
      const evidence = JSON.stringify(ctx.intent.state);
      for (const path of [ctx.deniedToken, ctx.permittedToken])
        expect(evidence).not.toContain(readFileSync(path, "utf8"));
      expect(evidence).not.toContain("synthetic-actor");
      expect(evidence).not.toContain("Create exactly");
      expect(stepState(ctx).resources).toMatchObject({
        chatId: CHAT,
        deniedChatId: DENIED_CHAT,
        deniedActorClass: "restricted",
        deniedPodId: DENIED_POD,
        permittedPodId: PERMITTED_POD,
      });
      expect(stepState(ctx).resources).not.toHaveProperty("deniedActorDigest");
    },
  );

  it("reports missing deniedChat unverified without a fallback Chat or native read", async () => {
    const ctx = fixtureContext();
    const denied = ctx.deniedChat;
    delete ctx.deniedChat;
    expect(await runProjectSetup(ctx, { deniedActor: true })).toMatchObject({
      status: "unverified",
      detail: "denied-chat-unavailable",
    });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ports.native).not.toHaveBeenCalled();
    expect(ctx.page.request.get).not.toHaveBeenCalled();
    ctx.deniedChat = denied;
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("green");
  });

  it("uses the canonical existing private lab token files when explicit paths are absent", async () => {
    const ctx = fixtureContext();
    delete ctx.deniedToken;
    delete ctx.permittedToken;
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("green");
  });

  it.each([
    "same-pat",
    "same-actor",
    "denied-admin",
    "same-pod",
    "denied-project",
    "denied-issue",
    "denied-approval",
    "permitted-approval",
    "approval-receipt",
    "wrong-refusal",
    "jql-400",
    "missing-total",
    "kanban",
    "shared-filter",
    "denied-mode",
    "denied-administration",
    "denied-knowledge",
    "unsafe-file",
  ])("never grades unavailable or contradictory proof green: %s", async (fault) => {
    const ctx = fixtureContext();
    configureFault(ctx, fault);
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).not.toBe("green");
    const priorTurns = ctx.turn.mock.calls.length;
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("unverified");
    expect(ctx.turn).toHaveBeenCalledTimes(priorTurns);
  });

  it("retains an uncertain committed create without replay or native error bodies", async () => {
    const ctx = fixtureContext();
    state.fault = "uncertain-create";
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("unverified");
    expect(state.projects.some((project) => project.key === ctx.projectKey)).toBe(true);
    expect(stepState(ctx).phase).toBe("pending");
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("unverified");
    expect(ctx.turn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(ctx.intent.state)).not.toContain("NATIVE_BODY_AND_AUTH_MUST_NOT_LEAVE");
  });

  it("reopens through snapshot state and record without resending and allows later project issues", async () => {
    const ctx = fixtureContext();
    expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("green");
    const detached = ctx.intent.state;
    detached["ac5-project"].phase = "pending";
    expect(stepState(ctx).phase).toBe("completed");
    state.targetIssues = 37;
    expect(await runProjectSetup(ctx, { deniedActor: true })).toMatchObject({
      status: "green",
      detail: "project-reverified",
      counts: { issues: 37, deniedIssues: 0 },
    });
    expect(ctx.turn).toHaveBeenCalledTimes(2);
  });

  it.each(["document-chat", "denied-chat", "pod", "permitted-generation", "denied-generation"])(
    "completed evidence cannot transfer to another %s",
    async (fault) => {
      const ctx = fixtureContext();
      expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("green");
      if (fault === "document-chat") ctx.chat.id = DENIED_POD;
      if (fault === "denied-chat") ctx.deniedChat.id = PERMITTED_POD;
      if (fault === "pod") state.chats[0].jiraPodBinding.podId = DENIED_POD;
      if (fault.endsWith("generation")) {
        const index = fault === "permitted-generation" ? 0 : 1;
        state.chats[index].jiraPodBinding.authenticationGeneration += 1;
        state.credentials[index].livePod.authenticationGeneration += 1;
      }
      expect((await runProjectSetup(ctx, { deniedActor: true })).status).toBe("unverified");
      expect(ctx.turn).toHaveBeenCalledTimes(2);
    },
  );

  it("does not send or read when already cancelled", async () => {
    const ctx = fixtureContext();
    const controller = new globalThis.AbortController();
    controller.abort();
    ctx.signal = controller.signal;
    expect(await runProjectSetup(ctx, { deniedActor: true })).toMatchObject({
      status: "unverified",
      detail: "project-aborted",
    });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ports.native).not.toHaveBeenCalled();
  });

  it("cancellation refuses an unexpected pending approval without a project effect", async () => {
    const ctx = fixtureContext();
    const controller = new globalThis.AbortController();
    ctx.signal = controller.signal;
    ctx.turn.mockImplementation(async (chat, prompt, extra) => {
      if (chat === ctx.deniedChat) return sendTurn(chat, prompt, extra);
      controller.abort();
      await extra.beforeDecision();
      throw new Error("Cancelled approval must not be reached");
    });
    expect(await runProjectSetup(ctx, { deniedActor: true })).toMatchObject({
      status: "unverified",
      detail: "project-aborted",
    });
    expect(state.projects).toHaveLength(1);
    expect(ctx.turn).toHaveBeenCalledTimes(2);
  });
});
