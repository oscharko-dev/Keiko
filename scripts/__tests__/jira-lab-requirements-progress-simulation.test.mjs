// W7: the existing native population is changed once, with durable intent before each effect.
// Only fetch is substituted. The production lab client and the shared paged JQL reader stay real.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as simulationModule from "../testing/jira-chat-lab/requirements/progress-simulation.mjs";

const STEP = "progress-simulation";
const PROJECT = "LIM7";
const EPIC_LINK = "customfield_10100";
const POINTS = "customfield_10106";
const roots = [];
const TYPES = [
  { id: "1", name: "Epic", subtask: false },
  { id: "2", name: "Task", subtask: false },
  { id: "3", name: "Bug", subtask: false },
  { id: "4", name: "Story", subtask: false },
  { id: "5", name: "Sub-task", subtask: true },
];
const STATUSES = [
  { id: "11", name: "To Do", statusCategory: { key: "new" } },
  { id: "21", name: "In Progress", statusCategory: { key: "indeterminate" } },
  { id: "31", name: "Done", statusCategory: { key: "done" } },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function simulation() {
  expect(simulationModule.simulateProgress).toBeTypeOf("function");
  return Promise.resolve(simulationModule.simulateProgress);
}

function nativeType(index) {
  if (index < 5) return TYPES[0];
  if (index < 115) return TYPES[1];
  if (index < 135) return TYPES[2];
  return index < 195 ? TYPES[3] : TYPES[4];
}

function nativeIssues() {
  return Array.from({ length: 205 }, (_, index) => {
    const type = nativeType(index);
    const number = index + 1;
    return {
      id: String(20000 + number),
      key: `${PROJECT}-${number}`,
      fields: {
        project: { id: "10000", key: PROJECT },
        issuetype: structuredClone(type),
        status: structuredClone(STATUSES[0]),
        summary: `Existing issue ${number}`,
        labels: ["anforderung", "keiko-requirement", `keiko-trace-${number}`],
        ...(type.name === "Epic" || type.subtask
          ? {}
          : { [EPIC_LINK]: `${PROJECT}-${(index % 5) + 1}` }),
        ...(type.subtask ? { parent: { id: "20006", key: `${PROJECT}-6` } } : {}),
        [POINTS]: index === 0 ? 0 : index === 1 ? null : 3,
      },
    };
  });
}

function intentFixture(directory) {
  const data = {};
  const records = [];
  return {
    path: join(directory, "browser-limit-run.pending.json"),
    get state() {
      return structuredClone(data);
    },
    record(name, value) {
      expect(name).toBe(STEP);
      data[name] = structuredClone(value);
      records.push(structuredClone(value));
    },
    records,
  };
}

function nativeFields() {
  return [
    {
      id: EPIC_LINK,
      name: "Epic Link",
      schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
    },
    {
      id: POINTS,
      name: "Story Points",
      schema: { type: "number", custom: "com.pyxis.greenhopper.jira:jsw-story-points" },
    },
    { id: "labels", name: "Labels", schema: { type: "array", items: "string", system: "labels" } },
    {
      id: "timeoriginalestimate",
      name: "Original Estimate",
      schema: { type: "number", system: "timeoriginalestimate" },
    },
  ];
}

function response(value, status = 200) {
  return new globalThis.Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function searchResponse(native, url) {
  expect(url.searchParams.get("jql")).toContain(PROJECT);
  expect(url.searchParams.get("jql")).not.toMatch(/\b(?:RPT|LRG)\b/u);
  expect(url.searchParams.get("maxResults")).toBe("100");
  const startAt = Number(url.searchParams.get("startAt"));
  native.pages.push(startAt);
  return response({
    startAt,
    maxResults: 100,
    total: native.issues.length,
    issues: structuredClone(native.issues.slice(startAt, startAt + 100)),
  });
}

function metadataResponse(native, path) {
  if (path === "/rest/api/2/field") return response(nativeFields());
  if (path === `/rest/api/2/project/${PROJECT}`)
    return response({ id: "10000", key: PROJECT, issueTypes: TYPES });
  if (path === `/rest/api/2/issue/createmeta/${PROJECT}/issuetypes`)
    return response({
      values: TYPES,
      startAt: 0,
      maxResults: 100,
      total: TYPES.length,
      isLast: true,
    });
  if (/^\/rest\/api\/2\/issue\/createmeta\/LIM7\/issuetypes\/[1-5]$/u.test(path))
    return response({
      values: nativeFields()
        .filter(
          (field) =>
            native.projectEstimates || (field.id !== POINTS && field.id !== "timeoriginalestimate"),
        )
        .map((field) => ({ ...field, fieldId: field.id })),
    });
  if (path === "/rest/agile/1.0/board")
    return response({ values: [{ id: 7, type: "scrum" }], isLast: true });
  if (path === "/rest/agile/1.0/board/7/configuration")
    return response({
      id: 7,
      estimation: native.boardEstimates
        ? { type: "field", field: { fieldId: POINTS } }
        : { type: "none" },
    });
  return undefined;
}

function issueResponse(native, path) {
  const match = /^\/rest\/api\/2\/issue\/(LIM7-[1-9][0-9]*)(?:\/(transitions|editmeta))?$/u.exec(
    path,
  );
  if (match === null) return undefined;
  const issue = native.issues.find((item) => item.key === match[1]);
  if (issue === undefined) return response({}, 404);
  if (match[2] === "transitions")
    return response({ transitions: STATUSES.map((status) => ({ id: status.id, to: status })) });
  if (match[2] === "editmeta")
    return response({
      fields: Object.fromEntries(
        nativeFields().map((field) => [
          field.id,
          {
            ...field,
            required: false,
            operations: ["set", "remove"],
          },
        ]),
      ),
    });
  return response(structuredClone(issue));
}

function applyNativeWrite(native, intent, method, path, body) {
  const match = /^\/rest\/api\/2\/issue\/(LIM7-[1-9][0-9]*)(\/transitions)?$/u.exec(path);
  expect(match, "no project, bulk creation or unrelated mutation is allowed").not.toBeNull();
  const key = match[1];
  const pending = intent.state[STEP]?.pending;
  expect(pending, "intent must be durable before the native effect").toMatchObject({ key });
  expect(["fields", "transition"]).toContain(pending.kind);
  const issue = native.issues.find((item) => item.key === key);
  expect(issue).toBeDefined();
  native.writes.push({ method, path, body: structuredClone(body), pending });
  if (match[2] === "/transitions") {
    expect(method).toBe("POST");
    const status = STATUSES.find((item) => item.id === body.transition.id);
    expect(status).toBeDefined();
    issue.fields.status = structuredClone(status);
  } else {
    expect(method).toBe("PUT");
    expect(
      Object.keys(body.fields).every((field) => field === "labels" || field === EPIC_LINK),
    ).toBe(true);
    Object.assign(issue.fields, structuredClone(body.fields));
  }
  if (native.dropNextWrite) {
    native.dropNextWrite = false;
    native.readsUnavailable = true;
    throw new TypeError("Synthetic lost response");
  }
  return response(undefined, 204);
}

function fetchFixture(native, intent) {
  return vi.fn((url, options) => {
    const target = new URL(url);
    expect(target.origin).toBe("http://127.0.0.1:18081");
    const method = options.method ?? "GET";
    const path = target.pathname;
    native.requests.push({ method, path });
    if (method !== "GET") {
      try {
        return Promise.resolve(
          applyNativeWrite(native, intent, method, path, JSON.parse(options.body)),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (native.readsUnavailable) return Promise.resolve(response({}, 503));
    const result =
      path === "/rest/api/2/search"
        ? searchResponse(native, target)
        : (metadataResponse(native, path) ?? issueResponse(native, path));
    if (result === undefined) throw new TypeError(`Unexpected synthetic read: ${path}`);
    return Promise.resolve(result);
  });
}

function installedTemplates() {
  return ["Epic", "Task", "Bug"].map((issueType, index) => ({
    id: `11111111-2222-4333-8444-${String(index + 1).padStart(12, "0")}`,
    revision: 1,
    valid: true,
    project: PROJECT,
    issueType,
    activations: ["create"],
    body: [
      "---",
      "keiko: jira-issue-template",
      "version: 1",
      `project: ${PROJECT}`,
      `issueType: ${issueType}`,
      "activateOn: [create]",
      ...(issueType === "Task" ? [`parentField: ${EPIC_LINK}`] : ["requiredLabels: [anforderung]"]),
      "---",
      "",
    ].join("\n"),
  }));
}

function templateBrowser(templates) {
  const get = vi.fn((input) => {
    const url = new URL(input);
    expect(url.origin).toBe("http://127.0.0.1:1983");
    if (url.pathname === "/api/skills/jira-templates") {
      const listed = templates
        .filter((item) => item.formal !== false)
        .map((item) => ({
          id: item.id,
          revision: item.revision,
          valid: item.valid,
          project: item.project,
          issueType: item.issueType,
          activations: item.activations,
        }));
      return Promise.resolve({
        ok: () => true,
        status: () => 200,
        json: () => Promise.resolve({ templates: listed }),
      });
    }
    const skill = templates.find((item) => url.pathname === `/api/skills/${item.id}`);
    expect(skill, "only listed revision-bound skill bodies may be read").toBeDefined();
    expect(url.searchParams.get("revision")).toBe(String(skill.revision));
    return Promise.resolve({
      ok: () => true,
      status: () => 200,
      json: () => Promise.resolve({ skill: structuredClone(skill) }),
    });
  });
  return { url: () => "http://127.0.0.1:1983/", request: { get } };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "keiko-progress-simulation-"));
  roots.push(directory);
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets", "admin-password"), "synthetic-only", { mode: 0o600 });
  const intent = intentFixture(directory);
  const native = {
    issues: nativeIssues(),
    writes: [],
    requests: [],
    pages: [],
    dropNextWrite: false,
    readsUnavailable: false,
    projectEstimates: true,
    boardEstimates: true,
  };
  const fetch = fetchFixture(native, intent);
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const controller = new globalThis.AbortController();
  const templates = installedTemplates();
  const ctx = {
    sessionDir: directory,
    session: { directory, httpPort: 18081, syntheticOnly: true },
    projectKey: PROJECT,
    locale: "de",
    modelId: "synthetic-model",
    page: templateBrowser(templates),
    reportChat: { id: "report-only", knowledgeSources: [] },
    turn: vi.fn(() => Promise.reject(new TypeError("native simulation needs no model turn"))),
    intent,
    signal: controller.signal,
  };
  return { ctx, native, intent, controller, fetch, templates };
}

function assertObservedTruth(truth, native) {
  expect(truth).toMatchObject({
    source: STEP,
    project: PROJECT,
    seedVersion: 2,
    issueCount: 205,
    templateScope: {
      issueTypes: ["Epic", "Task", "Bug"],
      labelsForTypes: ["Epic", "Bug"],
      parentForTypes: { Task: EPIC_LINK },
    },
    fieldIds: { epicLink: EPIC_LINK },
  });
  expect(truth.native.issues).toHaveLength(native.issues.length);
  truth.native.issues.forEach((row, index) => {
    const observed = native.issues[index];
    expect(row.id).toBe(observed.id);
    expect(row.key).toBe(observed.key);
    expect(row.fields).toEqual({
      project: observed.fields.project,
      issuetype: observed.fields.issuetype,
      status: observed.fields.status,
      labels: observed.fields.labels,
      [POINTS]: observed.fields[POINTS],
      ...(Object.hasOwn(observed.fields, EPIC_LINK)
        ? { [EPIC_LINK]: observed.fields[EPIC_LINK] }
        : {}),
      ...(Object.hasOwn(observed.fields, "parent") ? { parent: observed.fields.parent } : {}),
    });
    expect(Object.keys(row.fieldDigests).sort()).toEqual(["description", "issuelinks", "summary"]);
    expect(Object.values(row.fieldDigests).every((value) => /^[a-f0-9]{64}$/u.test(value))).toBe(
      true,
    );
  });
  expect(truth.native.pages).toEqual([
    { startAt: 0, maxResults: 100, total: 205, count: 100 },
    { startAt: 100, maxResults: 100, total: 205, count: 100 },
    { startAt: 200, maxResults: 100, total: 205, count: 5 },
  ]);
  expect(truth.issues).toHaveLength(205);
  for (const item of truth.issues) {
    const observed = native.issues.find((issue) => issue.key === item.key);
    expect(item).toMatchObject({
      type: observed.fields.issuetype.name,
      typeId: observed.fields.issuetype.id,
      subtask: observed.fields.issuetype.subtask,
      status: observed.fields.status.name,
      category: observed.fields.status.statusCategory.key,
      labels: observed.fields.labels,
    });
  }
}

describe("W7 simulateProgress public building block", () => {
  it("exports the exact resumable simulation entrypoint without CLI side effects", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("import must not access Jira")));
    vi.stubGlobal("fetch", fetch);
    await simulation();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("changes only existing runtime-project issues and records independently paged truth", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    const result = await simulateProgress(f.ctx, { seedDeviations: true });
    expect(result).toMatchObject({ step: STEP, status: "green", evidenceFile: f.intent.path });
    expect(f.ctx.turn).not.toHaveBeenCalled();
    expect(f.native.writes.length).toBeGreaterThan(0);
    expect(new Set(f.native.issues.map((issue) => issue.fields.status.name)).size).toBe(3);
    const state = f.intent.state[STEP];
    expect(state.pending).toBeUndefined();
    expect(state.completed).toHaveLength(f.native.writes.length);
    assertObservedTruth(state.truth, f.native);
    expect(state.truth.estimate).toMatchObject({
      fieldId: POINTS,
      writeFieldId: POINTS,
      unit: "points",
    });
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-1").estimate).toBe(0);
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-2").estimate).toBeNull();
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-119").labels).toEqual([
      "keiko-requirement",
      "keiko-trace-119",
    ]);
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-7").labels).toEqual([
      "anforderung",
      "keiko-requirement",
      "keiko-trace-7",
    ]);
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-16").deviations).toContain(
      "parent",
    );
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-140")).toMatchObject({
      type: "Story",
      typeId: "4",
      deviations: [],
      labels: ["anforderung", "keiko-requirement", "keiko-trace-140"],
    });
    expect(state.truth.issues.find((issue) => issue.key === "LIM7-196")).toMatchObject({
      subtask: true,
      parent: "LIM7-6",
      deviations: [],
      labels: ["anforderung", "keiko-requirement", "keiko-trace-196"],
    });
  });

  it("keeps completed units read-only on restart instead of replaying native writes", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    expect((await simulateProgress(f.ctx)).status).toBe("green");
    const writeCount = f.native.writes.length;
    const readCount = f.native.requests.length;
    expect((await simulateProgress(f.ctx)).status).toBe("green");
    expect(f.native.writes).toHaveLength(writeCount);
    expect(f.native.requests.slice(readCount).every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(f.native.requests.length).toBeGreaterThan(readCount);
  });

  it("reconciles an acknowledged-but-unrecorded pending unit with GETs and no write replay", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    f.native.dropNextWrite = true;
    expect((await simulateProgress(f.ctx)).status).toBe("unverified");
    expect(f.native.writes).toHaveLength(1);
    expect(f.intent.state[STEP].pending).toBeDefined();
    f.native.readsUnavailable = false;
    const readCount = f.native.requests.length;
    await simulateProgress(f.ctx);
    expect(f.native.writes).toHaveLength(1);
    expect(f.native.requests.slice(readCount).every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(f.intent.state[STEP].pending).toBeUndefined();
    expect(f.intent.state[STEP].completed).toHaveLength(1);
  });

  it("retains an uncertain pending unit after native drift and never retries its effect", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    f.native.dropNextWrite = true;
    expect((await simulateProgress(f.ctx)).status).toBe("unverified");
    const pending = f.intent.state[STEP].pending;
    const issue = f.native.issues.find((item) => item.key === pending.key);
    issue.fields.labels = ["independent-change"];
    issue.fields.status = { id: "99", name: "Review", statusCategory: { key: "indeterminate" } };
    f.native.readsUnavailable = false;
    expect((await simulateProgress(f.ctx)).status).toBe("unverified");
    expect(f.native.writes).toHaveLength(1);
    expect(f.intent.state[STEP].pending).toEqual(pending);
  });

  it("keeps every label and reports no invented deviations when no formal templates exist", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    f.templates.splice(0);
    const labels = f.native.issues.map((issue) => structuredClone(issue.fields.labels));
    const result = await simulateProgress(f.ctx);
    expect(result.evidenceFile).toBe(f.intent.path);
    expect(f.native.issues.map((issue) => issue.fields.labels)).toEqual(labels);
    expect(f.native.writes.every((write) => write.method === "POST")).toBe(true);
    expect(f.intent.state[STEP].truth.templateScope.issueTypes).toEqual([]);
    expect(f.intent.state[STEP].truth.issues.every((issue) => issue.deviations.length === 0)).toBe(
      true,
    );
  });

  it("reads formal template bodies at their listed revisions and never persists the bodies", async () => {
    await simulation();
    const { readInstalledTemplateScope } = simulationModule;
    expect(readInstalledTemplateScope).toBeTypeOf("function");
    const f = fixture();
    f.templates.push({
      id: "prose-only",
      revision: 1,
      formal: false,
      body: "Every Story must have anforderung",
      project: PROJECT,
      issueType: "Story",
    });
    const scope = await readInstalledTemplateScope(f.ctx);
    expect(scope).toMatchObject({
      project: PROJECT,
      issueTypes: ["Epic", "Task", "Bug"],
      labelsForTypes: ["Epic", "Bug"],
      parentForTypes: { Task: EPIC_LINK },
    });
    expect(scope.templates).toHaveLength(3);
    expect(scope.templates.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256))).toBe(true);
    expect(JSON.stringify(scope)).not.toContain("keiko: jira-issue-template");
    expect(f.ctx.page.request.get).toHaveBeenCalledTimes(4);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.intent.records).toHaveLength(0);
  });

  it("listed invalid formal template refuses before any native write", async () => {
    const simulateProgress = await simulation();
    const { readInstalledTemplateScope } = simulationModule;
    const f = fixture();
    f.templates.push({
      id: "invalid-formal",
      revision: 1,
      valid: false,
      body: "---\nkeiko: jira-issue-template\nversion: invalid\n---\n",
    });
    await expect(readInstalledTemplateScope(f.ctx)).rejects.toThrow(TypeError);
    expect((await simulateProgress(f.ctx)).status).toBe("unverified");
    expect(f.native.writes).toHaveLength(0);
    expect(f.intent.state[STEP]?.truth).toBeUndefined();
  });

  it("refuses a subtask whose requested native parent is unavailable before any write", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    delete f.native.issues[195].fields.parent;
    expect((await simulateProgress(f.ctx)).status).toBe("unverified");
    expect(f.native.writes).toHaveLength(0);
    expect(f.intent.state[STEP]?.truth).toBeUndefined();
  });

  it("keeps estimates unavailable when global fields lack project and board availability", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    f.native.projectEstimates = false;
    f.native.boardEstimates = false;
    for (const issue of f.native.issues) issue.fields.timeoriginalestimate = 0;
    expect((await simulateProgress(f.ctx)).status).toBe("green");
    const truth = f.intent.state[STEP].truth;
    expect(truth.estimate).toBeUndefined();
    expect(truth.fieldIds.storyPoints).toBeUndefined();
    expect(truth.issues.every((issue) => !Object.hasOwn(issue, "estimate"))).toBe(true);
    expect(
      truth.native.issues.every(
        (issue) =>
          !Object.hasOwn(issue.fields, POINTS) &&
          !Object.hasOwn(issue.fields, "timeoriginalestimate"),
      ),
    ).toBe(true);
  });

  it("retains edit structure rules but excludes transition-only templates", async () => {
    await simulation();
    const { readInstalledTemplateScope } = simulationModule;
    const f = fixture();
    f.templates[0].activations = ["edit"];
    f.templates[0].body = f.templates[0].body.replace("activateOn: [create]", "activateOn: [edit]");
    f.templates[2].activations = ["transition:Done"];
    f.templates[2].body = f.templates[2].body.replace(
      "activateOn: [create]",
      "activateOn: [transition:Done]",
    );
    const scope = await readInstalledTemplateScope(f.ctx);
    expect(scope.issueTypes).toEqual(["Epic", "Task"]);
    expect(scope.labelsForTypes).toEqual(["Epic"]);
    expect(scope.templates[0].rules.activations).toEqual([{ kind: "edit" }]);
    expect(f.ctx.page.request.get).toHaveBeenCalledTimes(3);
  });

  it("keeps private native bodies and unsolicited fields out of every persisted checkpoint", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    for (const issue of f.native.issues) {
      issue.fields.summary = "PRIVATE-SUMMARY-INJECTION";
      issue.fields.description = "PRIVATE-DESCRIPTION-INJECTION";
      issue.fields.assignee = { displayName: "PRIVATE-ASSIGNEE-INJECTION" };
      issue.fields.unrequested = { content: "PRIVATE-EXTRA-INJECTION" };
    }
    expect((await simulateProgress(f.ctx)).status).toBe("green");
    const persisted = JSON.stringify(f.intent.records);
    for (const marker of [
      "PRIVATE-SUMMARY",
      "PRIVATE-DESCRIPTION",
      "PRIVATE-ASSIGNEE",
      "PRIVATE-EXTRA",
    ])
      expect(persisted).not.toContain(marker);
    assertObservedTruth(f.intent.state[STEP].truth, f.native);
    expect(
      f.intent.state[STEP].truth.native.issues.every(
        (issue) =>
          !Object.hasOwn(issue.fieldDigests, "unrequested") &&
          !Object.hasOwn(issue.fieldDigests, "assignee"),
      ),
    ).toBe(true);
  });

  it("refuses an aborted run before any native request or intent mutation", async () => {
    const simulateProgress = await simulation();
    const f = fixture();
    f.controller.abort();
    const result = await simulateProgress(f.ctx);
    expect(result.status).toBe("unverified");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.intent.records).toHaveLength(0);
  });
});
