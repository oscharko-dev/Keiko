// Exercise the actual lab supervision/abort owner without running a model, Jira or a live server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  now: 1_800_000_000_000,
  live: undefined,
  mode: "lab-limit",
  observations: 0,
  sends: 0,
  aborts: 0,
  readinessError: undefined,
  indexes: 0,
  failIndexAfter: undefined,
  refuseLateIndex(name) {
    if (name !== "pod-index") return;
    this.indexes += 1;
    if (this.failIndexAfter !== undefined && this.indexes > this.failIndexAfter)
      throw new Error("index refused at https://litellm.internal.example/v1");
  },
}));

vi.mock("node:timers/promises", () => ({
  setTimeout: async () => {
    fixture.now += 1_800_000;
  },
}));
vi.mock("../testing/jira-chat-lab/requirements/work-project-lock.mjs", () => ({
  withWorkProjectLock: async (_directory, _id, run) => run(),
}));
// The journeys now read the lab's own Jira before and after a run (#4369); these tests have none.
vi.mock("../testing/jira-chat-lab/requirements/lab-health.mjs", async (original) => ({
  ...(await original()),
  labJiraState: async () => ({ state: "licensed", remaining: 9999 }),
}));
vi.mock("../testing/jira-chat-lab/requirements/license-window.mjs", () => ({
  ensureLicenseWindow: async () => undefined,
  eachJourneyInLicenseWindow: (ids, _window, run) =>
    ids.reduce((previous, id) => previous.then(() => run(id)), Promise.resolve()),
}));
vi.mock("../testing/jira-chat-lab/requirements/journey-checks.mjs", () => ({
  JOURNEY_IDS: ["S17", "S14"],
  JOURNEYS: {
    S17: async (ctx, chat) => ({
      status: "unverified",
      covers: [],
      ...(await ctx.turn(chat, "Synthetischer Lab-Turn")),
    }),
    S14: async (ctx, chat) => ({
      status: "unverified",
      covers: [],
      ...(await ctx.turn(chat, "Synthetischer Lab-Turn")),
    }),
  },
}));
vi.mock("../testing/jira-chat-lab/chat-read.mjs", () => {
  const responses = {
    "pod-create": { capsule: { id: "capsule" } },
    "pod-connect": {},
    "pod-index": { jobId: "index" },
    "pod-observe": { indexingJobs: [{ id: "index", status: "succeeded" }] },
    bind: { chat: { id: "chat", groundingScopeIdentity: "scope" } },
    "skill-import": { skill: { id: "skill", revision: 1, digest: "synthetic" } },
    "skill-read": { selection: { revision: 1 } },
    "skill-select": {},
    readiness: {},
  };
  return {
    chatReadLogDirectory: () => "/unused-synthetic-log-directory",
    prepareChat: async () => ({ id: "chat", groundingScopeIdentity: "scope" }),
    withLiveChat: async ({ run }) => run(fixture.live),
    jsonRequest: async (_origin, _cookie, name, _path, _body, _method, signal) => {
      if (name === "readiness" && fixture.readinessError) throw fixture.readinessError;
      fixture.refuseLateIndex(name);
      if (Object.hasOwn(responses, name)) return responses[name];
      switch (name) {
        case "observe": {
          fixture.observations += 1;
          return {
            messages:
              fixture.observations === 1
                ? []
                : [{ id: "new-user", role: "user", toolTranscript: { exchanges: [] } }],
          };
        }
        case "send": {
          fixture.sends += 1;
          if (fixture.mode === "completed") return {};
          if (fixture.mode === "product-failure") throw new Error("Synthetic product failure");
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                fixture.aborts += 1;
                reject(new Error("The operation was aborted"));
              },
              { once: true },
            );
          });
        }
        default:
          throw new TypeError(`Unexpected lab API fixture: ${name}`);
      }
    },
  };
});

import { modelUnavailable, runJourneys } from "../testing/jira-chat-lab/requirements/journeys.mjs";

let directory;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "keiko-lab-turn-limit-"));
  Object.assign(fixture, {
    now: 1_800_000_000_000,
    mode: "lab-limit",
    observations: 0,
    sends: 0,
    aborts: 0,
    readinessError: undefined,
    indexes: 0,
    failIndexAfter: undefined,
    live: {
      projectPath: directory,
      origin: "http://127.0.0.1:19999",
      cookie: "synthetic",
      modelId: "synthetic-model",
    },
  });
  vi.spyOn(Date, "now").mockImplementation(() => fixture.now);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function observedTurn(extra = {}) {
  const result = await runJourneys({
    ...extra,
    session: { directory },
    directory,
    modelId: "synthetic-model",
    embeddingModelId: "synthetic-embedding",
    truth: {},
    ids: ["S17"],
  });
  return result.S17;
}

describe("requirements lab turn-limit provenance", () => {
  it("marks only its own supervision abort and keeps the unknown product limit separate", async () => {
    const turn = await observedTurn();
    expect(fixture.sends).toBe(1);
    expect(fixture.aborts).toBe(1);
    expect(turn.failure).toContain("aborted");
    expect(turn.termination).toBe("lab-limit");
    expect(turn.limits).toEqual({ labTurnMs: 1_800_000, productTurnMs: null });
  });

  it.each(["completed", "product-failure"])(
    "does not mark a settled %s turn as lab-aborted",
    async (mode) => {
      fixture.mode = mode;
      const turn = await observedTurn();
      expect(fixture.sends).toBe(1);
      expect(fixture.aborts).toBe(0);
      expect(turn.termination).toBeUndefined();
      expect(turn.limits).toEqual({ labTurnMs: 1_800_000, productTurnMs: null });
      if (mode === "completed") expect(turn.failure).toBeUndefined();
      else expect(turn.failure).toContain("Synthetic product failure");
    },
  );

  it("grades a journey invalid, not red, when the model fails its readiness check", async () => {
    const turn = await observedTurn({
      readiness: async () => ({ unavailable: true, detail: "connect ECONNREFUSED" }),
    });
    expect(turn.status).toBe("invalid");
    expect(turn.reason).toBe("model-unavailable");
    expect(turn.covers).toEqual([]);
    expect(fixture.sends).toBe(0);
  });

  it("keeps a journey red when the readiness turn failed on a Keiko route, not the model", async () => {
    const turn = await observedTurn({
      readiness: async () => ({ unavailable: false, detail: "Live Chat HTTP stage failed" }),
    });
    expect(turn.status).toBe("red");
    expect(turn.reason).toBe("product-route-failed");
    expect(fixture.sends).toBe(0);
  });

  it("grades a failed journey invalid when its gateway log evidence is missing", async () => {
    fixture.mode = "product-failure";
    const turn = await observedTurn();
    expect(turn).toMatchObject({ status: "invalid", reason: "lab-error", covers: [] });
  });

  it("grades a failed readiness turn invalid when its gateway evidence is missing", async () => {
    fixture.readinessError = new TypeError("Live Chat HTTP stage failed");
    const turn = await observedTurn({ readiness: undefined });
    expect(turn).toMatchObject({ status: "invalid", reason: "lab-error" });
    expect(fixture.sends).toBe(0);
  });

  describe("the lab's own Jira being down (#4369)", () => {
    const down = (state) => ({ state });
    const up = { state: "licensed", remaining: 9000 };

    it("a journey that starts while Jira is down is invalid lab-outage and sends nothing", async () => {
      for (const state of ["unreachable", "starting", "expired"]) {
        fixture.sends = 0;
        const turn = await observedTurn({ labState: async () => down(state) });
        expect(turn).toMatchObject({ status: "invalid", reason: "lab-outage" });
        expect(turn.detail).toContain(state);
        expect(fixture.sends).toBe(0);
      }
    });

    it("a failed journey during which Jira went down is invalid, not red", async () => {
      fixture.mode = "product-failure";
      const readings = [up, down("unreachable")];
      const turn = await observedTurn({ labState: async () => readings.shift() });
      expect(turn).toMatchObject({ status: "invalid", reason: "lab-outage" });
      expect(fixture.sends).toBe(1);
    });

    it("a failed journey with a healthy Jira keeps its own verdict", async () => {
      fixture.mode = "product-failure";
      const turn = await observedTurn({ labState: async () => up });
      expect(turn.reason).not.toBe("lab-outage");
    });
  });

  it("invalidates S14 and starts no further run when the specification restore fails", async () => {
    fixture.mode = "completed";
    fixture.failIndexAfter = 1;
    const result = await runJourneys({
      session: { directory },
      directory,
      modelId: "synthetic-model",
      embeddingModelId: "synthetic-embedding",
      truth: {},
      ids: ["S14"],
      repeat: 3,
    });
    expect(fixture.sends).toBe(1);
    expect(result.S14.runs.map((run) => run.status)).toEqual(["invalid", "invalid", "invalid"]);
    expect(result.S14.runs[0].detail).toContain("specification restore failed");
    expect(JSON.stringify(result.S14)).not.toContain("litellm.internal.example");
  });

  it("runs a journey --repeat times in fresh Chats and aggregates the runs", async () => {
    fixture.mode = "completed";
    const turn = await observedTurn({ repeat: 3 });
    expect(fixture.sends).toBe(3);
    expect(turn.runs).toHaveLength(3);
    expect(turn.validRuns).toBe(3);
    expect(turn.status).toBe("unverified");
  });

  describe("readiness turn", () => {
    const check = () =>
      modelUnavailable({ origin: "o", cookie: "c", projectPath: directory }, { directory }, "m");

    it("treats its own deadline abort as an unavailable model, by error name", async () => {
      fixture.readinessError = Object.assign(
        new Error("The operation was aborted due to timeout"),
        {
          name: "TimeoutError",
        },
      );
      expect(await check()).toMatchObject({ unavailable: true });
    });

    it("keeps a plain route failure the product's and an answered turn undefined", async () => {
      fixture.readinessError = new TypeError("Live Chat HTTP stage failed");
      expect(await check()).toMatchObject({ unavailable: false });
      fixture.readinessError = undefined;
      expect(await check()).toBeUndefined();
    });
  });
});
