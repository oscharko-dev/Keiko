import { URL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as faultModule from "../testing/jira-chat-lab/browser-bulk-fault.mjs";

function issue(index, summary = `Requirement ${index}`) {
  return {
    id: String(index),
    key: `LIM7-${index}`,
    fields: {
      summary,
      project: { key: "LIM7" },
      status: { id: "1" },
      updated: "synthetic-original",
    },
  };
}
function intentStub(initial = {}) {
  let state = structuredClone(initial);
  return {
    writes: [],
    get state() {
      return structuredClone(state);
    },
    record: vi.fn(async function (name, value) {
      this.writes.push({ name, value: structuredClone(value) });
      state[name] = structuredClone(value);
    }),
  };
}
function pageStub(events) {
  const handlers = [];
  return {
    handlers,
    url: () => "http://127.0.0.1:1983/chat",
    reload: vi.fn(() => {
      throw new TypeError("F must not reload or resend");
    }),
    route: vi.fn(async (matches, handler) => {
      events.push("route-install");
      handlers.push({ matches, handler });
    }),
    unroute: vi.fn(async (matches, handler) => {
      events.push("route-remove");
      const i = handlers.findIndex((item) => item.matches === matches && item.handler === handler);
      if (i >= 0) handlers.splice(i, 1);
    }),
    async emit({
      method = "POST",
      url = "http://127.0.0.1:1983/api/desktop/chat",
      onFetch = () => undefined,
    } = {}) {
      const selected = handlers.find((item) => item.matches(new URL(url)));
      const response = { dispose: vi.fn(async () => events.push("dispose")) };
      const route = {
        request: () => ({ method: () => method }),
        fetch: vi.fn(async (options) => {
          events.push("forward");
          await onFetch(options);
          return response;
        }),
        fulfill: vi.fn(async () => events.push("fulfill")),
        abort: vi.fn(async (reason) => events.push(reason)),
        fallback: vi.fn(async () => events.push("fallback")),
      };
      if (selected) await selected.handler(route);
      return { route, response };
    },
  };
}
function context(initial = {}) {
  const events = [];
  const controller = new globalThis.AbortController();
  const intent = intentStub({
    bulkEpics: { completedBatches: 1, privateMappings: [{ id: "1", key: "LIM7-1" }] },
    ...initial,
  });
  const ctx = {
    projectKey: "LIM7",
    intent,
    signal: controller.signal,
    controller,
    events,
    native: [issue(1)],
    members: ["LIM7-1"],
    page: pageStub(events),
    turn: vi.fn(() => {
      throw new TypeError("F must never submit a prompt");
    }),
  };
  ctx.read = vi.fn(async (path) => {
    if (path === "/rest/api/2/project/LIM7") return { id: "10000", key: "LIM7" };
    const parsed = new URL(path, "http://jira.invalid");
    if (parsed.pathname === "/rest/agile/1.0/sprint/9/issue") {
      const startAt = Number(parsed.searchParams.get("startAt"));
      const values = ctx.members.map((key) => ctx.native.find((row) => row.key === key));
      return {
        startAt,
        maxResults: 50,
        total: values.length,
        issues: structuredClone(values.slice(startAt, startAt + 50)),
      };
    }
    throw new TypeError("Unexpected native read");
  });
  ctx.search = vi.fn(async () => structuredClone(ctx.native));
  ctx.recovery = {
    restartServer: vi.fn(async ({ signal }) => {
      expect(signal).toBe(ctx.signal);
      events.push("restart");
      return { restarted: true, downtimeMs: 12 };
    }),
  };
  return ctx;
}
const plan = (scope = "bulk-epics", kinds = ["response-drop"], at = [0.4]) =>
  faultModule.createFaultPlan({ scope, at, kinds });
async function advance(ctx) {
  ctx.native.push(issue(ctx.native.length + 1));
  const before = ctx.intent.state.bulkEpics;
  await ctx.intent.record("bulkEpics", {
    ...before,
    completedBatches: before.completedBatches + 1,
    privateMappings: ctx.native.map(({ id, key }) => ({ id, key })),
  });
}
async function dropped(ctx, p = plan()) {
  const armed = await p.maybeInject(ctx, 0.4);
  expect(armed.status).toBe("unverified");
  const delivered = await ctx.page.emit({ onFetch: () => advance(ctx) });
  return { p, delivered };
}

describe("Amendment 3 factory contract", () => {
  it("exports exactly the assigned factory", () => {
    expect(Object.keys(faultModule)).toEqual(["createFaultPlan"]);
  });
  it.each([
    {},
    { scope: "foreign", at: [0.4], kinds: ["response-drop"] },
    { scope: "bulk-epics", at: [0.4], kinds: ["server-kill", "response-drop"] },
    { scope: "hierarchy", at: [NaN], kinds: ["server-kill"] },
    { scope: "progress", at: [1], kinds: ["server-kill"] },
    { scope: "progress", at: [0.4, 0.8], kinds: ["response-drop", "response-drop"] },
  ])("refuses invalid plans before installing anything: %j", (options) => {
    expect(() => faultModule.createFaultPlan(options)).toThrow(TypeError);
  });
  it("pairs thresholds with kinds even when the pairs are supplied out of order", async () => {
    const ctx = context();
    const p = plan("bulk-epics", ["server-kill", "response-drop"], [0.8, 0.4]);
    await p.maybeInject(ctx, 0.4);
    expect(ctx.intent.state.faults["bulk-epics:response-drop"]).toMatchObject({
      phase: "injecting",
      progress01: 0.4,
    });
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
  });
  it.each([-0.1, 1.1, NaN, Infinity])(
    "refuses invalid progress %s without a write or effect",
    async (progress) => {
      const ctx = context();
      await expect(plan().maybeInject(ctx, progress)).rejects.toThrow(TypeError);
      expect(ctx.intent.writes).toHaveLength(0);
      expect(ctx.page.route).not.toHaveBeenCalled();
    },
  );
  it("remains unverified below the threshold without a Jira read or fault reservation", async () => {
    const ctx = context();
    const result = await plan().maybeInject(ctx, 0.39);
    expect(result).toMatchObject({
      status: "unverified",
      counts: { injected: 0, recovered: 0, duplicates: 0, lost: 0 },
    });
    expect(ctx.search).not.toHaveBeenCalled();
    expect(ctx.intent.state.faults).toBeUndefined();
  });
});

describe("one forwarded Chat response drop", () => {
  it("writes ahead, forwards once, aborts, removes only its route, and never submits a prompt", async () => {
    const ctx = context();
    ctx.page.route.mockImplementationOnce(async (matches, handler) => {
      expect(ctx.intent.state.faults["bulk-epics:response-drop"]).toMatchObject({
        phase: "injecting",
        progress01: 0.4,
      });
      ctx.page.handlers.push({ matches, handler });
    });
    const { p, delivered } = await dropped(ctx);
    expect(delivered.route.fetch).toHaveBeenCalledExactlyOnceWith({
      timeout: 0,
      maxRedirects: 0,
      maxRetries: 0,
    });
    expect(delivered.route.abort).toHaveBeenCalledExactlyOnceWith("connectionreset");
    expect(delivered.response.dispose).toHaveBeenCalledOnce();
    expect(ctx.page.unroute).toHaveBeenCalledOnce();
    expect(ctx.page.handlers).toHaveLength(0);
    expect(ctx.events.indexOf("forward")).toBeLessThan(ctx.events.indexOf("connectionreset"));
    const result = await p.maybeInject(ctx, 0.5);
    expect(result).toMatchObject({
      status: "green",
      counts: { injected: 1, recovered: 1, duplicates: 0, lost: 0 },
    });
    expect(ctx.intent.state.faults["bulk-epics:response-drop"]).toMatchObject({
      phase: "recovered",
      recoveryMs: expect.any(Number),
    });
    expect(ctx.turn).not.toHaveBeenCalled();
    expect(ctx.page.reload).not.toHaveBeenCalled();
  });
  it("does not consume its one drop on a GET or a foreign origin", async () => {
    const ctx = context();
    const p = plan();
    await p.maybeInject(ctx, 0.4);
    const foreign = await ctx.page.emit({ url: "http://foreign.invalid/api/desktop/chat" });
    const get = await ctx.page.emit({ method: "GET" });
    expect(foreign.route.fetch).not.toHaveBeenCalled();
    expect(get.route.fallback).toHaveBeenCalledOnce();
    const actual = await ctx.page.emit({
      url: "http://127.0.0.1:1983/api/desktop/chat/stream",
      onFetch: () => advance(ctx),
    });
    expect(actual.route.abort).toHaveBeenCalledOnce();
    expect((await p.maybeInject(ctx, 0.5)).status).toBe("green");
  });
  it("claims exactly one concurrent POST and keeps other scopes' durable records", async () => {
    const ctx = context({
      faults: { "hierarchy:server-kill": { phase: "skipped", reason: "recovery-unavailable" } },
    });
    const p = plan();
    await Promise.all([p.maybeInject(ctx, 0.4), plan().maybeInject(ctx, 0.4)]);
    expect(ctx.page.route).toHaveBeenCalledOnce();
    const [first, second] = await Promise.all([
      ctx.page.emit({ onFetch: () => advance(ctx) }),
      ctx.page.emit(),
    ]);
    expect(first.route.abort).toHaveBeenCalledOnce();
    expect(second.route.fallback).toHaveBeenCalledOnce();
    expect(ctx.intent.state.faults["hierarchy:server-kill"]).toEqual({
      phase: "skipped",
      reason: "recovery-unavailable",
    });
    await p.maybeInject(ctx, 0.5);
    expect(ctx.page.route).toHaveBeenCalledOnce();
  });
  it("does not call a response drop recovered before native continuation is observed", async () => {
    const ctx = context();
    const p = plan();
    await p.maybeInject(ctx, 0.4);
    await ctx.page.emit();
    expect((await p.maybeInject(ctx, 0.6)).status).toBe("unverified");
    expect(ctx.intent.state.faults["bulk-epics:response-drop"].phase).toBe("injecting");
    await advance(ctx);
    expect((await p.maybeInject(ctx, 0.7)).status).toBe("green");
  });
  it("preserves an injecting marker after a failed forward without retrying a request", async () => {
    const ctx = context();
    const p = plan();
    await p.maybeInject(ctx, 0.4);
    const event = await ctx.page.emit({
      onFetch: () => {
        throw new TypeError("synthetic private response");
      },
    });
    await advance(ctx);
    const result = await plan().maybeInject(ctx, 0.7);
    expect(result.status).toBe("unverified");
    expect(event.route.fetch).toHaveBeenCalledOnce();
    expect(event.route.abort).toHaveBeenCalledExactlyOnceWith("failed");
    expect(ctx.page.route).toHaveBeenCalledOnce();
    expect(JSON.stringify(ctx.intent.state.faults)).not.toContain("synthetic private response");
  });
});

describe("owned server recovery and durable resume", () => {
  it("records skipped without the recovery handle, even if it is supplied later", async () => {
    const ctx = context();
    delete ctx.recovery;
    const p = plan("hierarchy", ["server-kill"]);
    const first = await p.maybeInject(ctx, 0.4);
    expect(first).toMatchObject({
      status: "unverified",
      counts: { injected: 0, recovered: 0, duplicates: 0, lost: 0 },
    });
    expect(ctx.intent.state.faults["hierarchy:server-kill"]).toEqual({
      phase: "skipped",
      progress01: 0.4,
      reason: "recovery-unavailable",
    });
    ctx.recovery = { restartServer: vi.fn() };
    await p.maybeInject(ctx, 0.9);
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
  });
  it("uses only the bound recovery handle and proves continuation after the restart", async () => {
    const ctx = context({ hierarchyBulk: { next: 1, digest: "synthetic-plan" } });
    const p = plan("hierarchy", ["server-kill"]);
    ctx.recovery.restartServer.mockImplementationOnce(async ({ signal }) => {
      expect(signal).toBe(ctx.signal);
      expect(ctx.intent.state.faults["hierarchy:server-kill"].phase).toBe("injecting");
      return { restarted: true, downtimeMs: 14 };
    });
    expect((await p.maybeInject(ctx, 0.4)).status).toBe("unverified");
    ctx.native.push(issue(2));
    await ctx.intent.record("hierarchyBulk", { next: 2, digest: "synthetic-plan" });
    const result = await plan("hierarchy", ["server-kill"]).maybeInject(ctx, 0.5);
    expect(result).toMatchObject({
      status: "green",
      counts: { injected: 1, recovered: 1, duplicates: 0, lost: 0 },
    });
    expect(ctx.recovery.restartServer).toHaveBeenCalledOnce();
    expect(ctx.page.reload).not.toHaveBeenCalled();
  });
  it("never repeats recovery after a rejected or ambiguous restart acknowledgement", async () => {
    const ctx = context();
    ctx.recovery.restartServer.mockResolvedValueOnce({ restarted: false, downtimeMs: 0 });
    await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.4);
    await advance(ctx);
    expect((await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.8)).status).toBe(
      "unverified",
    );
    expect(ctx.recovery.restartServer).toHaveBeenCalledOnce();
  });
  it.each(["injecting", "recovered", "skipped"])(
    "never reinjects a pre-existing %s key or grades an unproven marker green",
    async (phase) => {
      const ctx = context({
        faults: { "bulk-epics:server-kill": { phase, progress01: 0.4, injected: true } },
      });
      const result = await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.6);
      expect(result.status).toBe("unverified");
      expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
    },
  );
  it("does not install another pending fault while the first response has not been recovered", async () => {
    const ctx = context();
    const p = plan("bulk-epics", ["response-drop", "server-kill"], [0.4, 0.8]);
    await p.maybeInject(ctx, 0.4);
    await p.maybeInject(ctx, 0.8);
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
  });
});

describe("independent native oracles", () => {
  it("rejects duplicate summaries after a drop even if their keys differ", async () => {
    const ctx = context();
    const { p } = await dropped(ctx);
    ctx.native.push(issue(3, ctx.native[1].fields.summary));
    const result = await p.maybeInject(ctx, 0.5);
    expect(result).toMatchObject({
      status: "red",
      counts: { duplicates: 1, lost: 0, recovered: 0 },
    });
  });
  it("rejects loss of a known intent issue after a drop", async () => {
    const ctx = context();
    const { p } = await dropped(ctx);
    ctx.native.shift();
    expect(await p.maybeInject(ctx, 0.5)).toMatchObject({
      status: "red",
      counts: { lost: 1, recovered: 0 },
    });
  });
  it("surfaces loss immediately after the restart instead of reporting zero lost records", async () => {
    const ctx = context();
    ctx.recovery.restartServer.mockImplementationOnce(async () => {
      ctx.native = [];
      return { restarted: true, downtimeMs: 5 };
    });
    expect(await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.4)).toMatchObject({
      status: "red",
      counts: { lost: 1, injected: 1 },
    });
  });
  it("does not inject into a project whose already recorded unit is missing", async () => {
    const ctx = context();
    ctx.native = [];
    expect(await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.4)).toMatchObject({
      status: "red",
      counts: { lost: 1, injected: 0 },
    });
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
  });
  it("requires the completed-unit cursor to advance and never accepts a rolled-back intent", async () => {
    const ctx = context();
    const { p } = await dropped(ctx);
    await ctx.intent.record("bulkEpics", { completedBatches: 0, privateMappings: [] });
    const result = await p.maybeInject(ctx, 0.6);
    expect(result.status).toBe("unverified");
    expect(result.counts.recovered).toBe(0);
  });
  it("keeps native read failures unverified and never records exception contents", async () => {
    const ctx = context();
    ctx.search.mockRejectedValueOnce(new Error("synthetic private native content"));
    const result = await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.4);
    expect(result.status).toBe("unverified");
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic private");
  });
  it("reads sprint membership across more than three pages and proves an idempotent prefix", async () => {
    const ctx = context({
      sprintBulk: {
        next: 1,
        sprintId: "9",
        issueKeys: Array.from({ length: 250 }, (_, i) => `LIM7-${i + 1}`),
      },
    });
    ctx.native = Array.from({ length: 250 }, (_, i) => issue(i + 1));
    ctx.members = ctx.native.slice(0, 200).map((row) => row.key);
    const p = plan("progress", ["server-kill"]);
    await p.maybeInject(ctx, 0.4);
    ctx.members = ctx.native.map((row) => row.key);
    await ctx.intent.record("sprintBulk", { ...ctx.intent.state.sprintBulk, next: 2 });
    expect(await p.maybeInject(ctx, 0.5)).toMatchObject({
      status: "green",
      counts: { lost: 0, duplicates: 0, recovered: 1 },
    });
    expect(
      ctx.read.mock.calls.filter(([path]) => path.includes("sprint/9/issue")).length,
    ).toBeGreaterThan(12);
    expect(ctx.recovery.restartServer).toHaveBeenCalledOnce();
  });
  it("refuses a removed sprint member even when all project issues still exist", async () => {
    const ctx = context({ sprintBulk: { next: 1, sprintId: "9", issueKeys: ["LIM7-1"] } });
    const p = plan("progress", ["server-kill"]);
    await p.maybeInject(ctx, 0.4);
    ctx.members = [];
    await ctx.intent.record("sprintBulk", { ...ctx.intent.state.sprintBulk, next: 2 });
    expect(await p.maybeInject(ctx, 0.5)).toMatchObject({
      status: "red",
      counts: { lost: 1, recovered: 0 },
    });
  });
});

describe("whole-batch recovery and failure boundaries", () => {
  async function prefix(ctx, count, batches) {
    ctx.native = Array.from({ length: count }, (_, i) => issue(i + 1));
    await ctx.intent.record("bulkEpics", {
      completedBatches: batches,
      privateMappings: ctx.native.map(({ id, key }) => ({ id, key })),
    });
  }
  it("runs the paired faults at 40 and 80 percent and finishes with exactly 370 unique units", async () => {
    const ctx = context();
    await prefix(ctx, 148, 8);
    const p = plan("bulk-epics", ["response-drop", "server-kill"], [0.4, 0.8]);
    await p.maybeInject(ctx, 0.4);
    const event = await ctx.page.emit({ onFetch: () => prefix(ctx, 168, 9) });
    expect((await p.maybeInject(ctx, 168 / 370)).counts.recovered).toBe(1);
    await prefix(ctx, 296, 16);
    expect((await p.maybeInject(ctx, 0.8)).status).toBe("unverified");
    await prefix(ctx, 316, 17);
    expect((await p.maybeInject(ctx, 316 / 370)).status).toBe("green");
    await prefix(ctx, 370, 20);
    expect(await p.maybeInject(ctx, 1)).toMatchObject({
      status: "green",
      counts: { injected: 2, recovered: 2, duplicates: 0, lost: 0 },
    });
    expect(ctx.native).toHaveLength(370);
    expect(event.route.abort).toHaveBeenCalledOnce();
    expect(ctx.recovery.restartServer).toHaveBeenCalledOnce();
    expect(ctx.turn).not.toHaveBeenCalled();
    const restored = plan("bulk-epics", ["response-drop", "server-kill"], [0.4, 0.8]);
    expect((await restored.maybeInject(ctx, 1)).status).toBe("green");
    expect(ctx.recovery.restartServer).toHaveBeenCalledOnce();
    expect(ctx.page.route).toHaveBeenCalledOnce();
  });
  it("does not reserve or inject after cancellation", async () => {
    const ctx = context();
    ctx.controller.abort();
    await expect(plan().maybeInject(ctx, 0.4)).rejects.toThrow();
    expect(ctx.intent.writes).toHaveLength(0);
    expect(ctx.page.route).not.toHaveBeenCalled();
  });
  it("removes an armed handler after cancellation and does not drop a later request", async () => {
    const ctx = context();
    await plan().maybeInject(ctx, 0.4);
    ctx.controller.abort();
    const event = await ctx.page.emit();
    await vi.waitFor(() => expect(ctx.page.handlers).toHaveLength(0));
    expect(event.route.abort).not.toHaveBeenCalled();
  });
  it("withholds effects when the write-ahead record fails", async () => {
    const ctx = context();
    ctx.intent.record.mockRejectedValueOnce(new Error("synthetic private intent"));
    const result = await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.4);
    expect(result.status).toBe("unverified");
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("synthetic private intent");
  });
  it("never grades incomplete durable response evidence green after a persistence failure", async () => {
    const ctx = context();
    const p = plan();
    await p.maybeInject(ctx, 0.4);
    ctx.intent.record.mockRejectedValueOnce(new TypeError("synthetic private flush"));
    const event = await ctx.page.emit({
      onFetch: () => {
        ctx.native.push(issue(2));
      },
    });
    expect(event.route.abort).toHaveBeenCalledOnce();
    expect(event.response.dispose).toHaveBeenCalledOnce();
    const result = await p.maybeInject(ctx, 0.6);
    expect(result.status).toBe("unverified");
    expect(ctx.page.route).toHaveBeenCalledOnce();
  });
  it("does not expose summary bodies or arbitrary errors in intent fault records or StepResult", async () => {
    const ctx = context();
    ctx.native[0].fields.summary = "synthetic-private-content-never-logged";
    const { p } = await dropped(ctx);
    const result = await p.maybeInject(ctx, 0.5);
    const evidence = JSON.stringify({ faults: ctx.intent.state.faults, result });
    expect(evidence).not.toContain("synthetic-private-content-never-logged");
    expect(result.detail).not.toMatch(/[\r\n]/u);
  });
  it("does not arm a late fault after the final unit", async () => {
    const ctx = context();
    const result = await plan().maybeInject(ctx, 1);
    expect(result.status).toBe("unverified");
    expect(ctx.page.route).not.toHaveBeenCalled();
    expect(ctx.intent.state.faults["bulk-epics:response-drop"]).toMatchObject({
      phase: "skipped",
      reason: "threshold-missed",
    });
  });
  it("refuses contradictory native pagination instead of proving sprint membership from a prefix", async () => {
    const ctx = context({ sprintBulk: { next: 1, sprintId: "9" } });
    ctx.read.mockImplementation(async (path) =>
      path.includes("project/")
        ? { key: "LIM7" }
        : { startAt: 0, maxResults: 50, total: 2, issues: [issue(1)], isLast: true },
    );
    const result = await plan("progress", ["server-kill"]).maybeInject(ctx, 0.4);
    expect(result.status).toBe("unverified");
    expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
  });
});

it("does not abort a response after cancellation during forwarding or forward it twice", async () => {
  const ctx = context();
  await plan().maybeInject(ctx, 0.4);
  const event = await ctx.page.emit({ onFetch: () => ctx.controller.abort() });
  expect(event.route.fetch).toHaveBeenCalledOnce();
  expect(event.route.fulfill).toHaveBeenCalledExactlyOnceWith({ response: event.response });
  expect(event.route.abort).not.toHaveBeenCalled();
  expect(event.response.dispose).toHaveBeenCalledOnce();
});
it("retains the sprint cursor when a later progress component adds its own checkpoint", async () => {
  const ctx = context({ sprintBulk: { next: 1, sprintId: "9" } });
  ctx.native.push(issue(2));
  const p = plan("progress", ["server-kill"]);
  await p.maybeInject(ctx, 0.4);
  ctx.members.push("LIM7-2");
  await ctx.intent.record("sprintBulk", { next: 2, sprintId: "9" });
  await ctx.intent.record("progressSimulation", { next: 0 });
  expect((await p.maybeInject(ctx, 0.5)).status).toBe("green");
});
it("does not count an arbitrary recovered marker as a proved recovery", async () => {
  const ctx = context({
    faults: { "bulk-epics:server-kill": { phase: "recovered", progress01: 0.4, injected: true } },
  });
  const result = await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.5);
  expect(result.status).toBe("unverified");
  expect(result.counts.recovered).toBe(0);
});

it("uses native progress evidence while retaining a previous completed sprint cursor", async () => {
  const ctx = context({ sprintBulk: { next: 4 }, progressSimulation: { phase: "running" } });
  const p = plan("progress", ["server-kill"]);
  await p.maybeInject(ctx, 0.4);
  ctx.native[0].fields.status = { id: "2" };
  ctx.native[0].fields.updated = "synthetic-updated";
  expect((await p.maybeInject(ctx, 0.5)).status).toBe("green");
});

it("settles the intercepted browser request when forwarding fails instead of leaving it paused", async () => {
  const ctx = context();
  const p = plan();
  await p.maybeInject(ctx, 0.4);
  const event = await ctx.page.emit({
    onFetch: () => {
      throw new TypeError("synthetic network failure");
    },
  });
  expect(event.route.abort).toHaveBeenCalledExactlyOnceWith("failed");
  expect(ctx.intent.state.faults["bulk-epics:response-drop"].injected).not.toBe(true);
  expect((await p.maybeInject(ctx, 0.5)).status).toBe("unverified");
});

it("binds numeric native issue IDs recorded in intent as strictly as string IDs", async () => {
  const ctx = context({
    bulkEpics: { completedBatches: 1, privateMappings: [{ id: 999, key: "LIM7-1" }] },
  });
  const result = await plan("bulk-epics", ["server-kill"]).maybeInject(ctx, 0.4);
  expect(result.status).toBe("red");
  expect(result.counts.lost).toBe(1);
  expect(ctx.recovery.restartServer).not.toHaveBeenCalled();
});
