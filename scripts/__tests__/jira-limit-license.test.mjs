import { describe, expect, it, vi } from "vitest";
import {
  LIMIT_LICENSE_FLOOR_SECONDS,
  LIMIT_STEP_LICENSE_SECONDS,
  createLimitLicenseGuard,
  limitStepLicenseSeconds,
} from "../testing/jira-chat-lab/limit-run-license.mjs";
import {
  createLimitRunContext,
  runLimitStep,
} from "../testing/jira-chat-lab/browser-limit-run.mjs";
import { memoryLimitIntent } from "./helpers/limit-run-intent.mjs";

const session = { directory: "/private/hermetic-limit-session", project: "keiko-jira-4081-aa" };
const LONG = ["ac2-epics", "ac4-hierarchy", "ac6-sprint", "progress-simulation", "ac3-report"];
const kept = (remaining) =>
  vi.fn(async () => ({ restarted: false, remainingBefore: remaining, remainingAfter: remaining }));
const renewed = (before, after) =>
  vi.fn(async () => ({ restarted: true, remainingBefore: before, remainingAfter: after }));

describe("the step-specific license window", () => {
  it("keeps the thirty-minute floor and gives long steps a larger window a renewed license satisfies", () => {
    expect(LIMIT_LICENSE_FLOOR_SECONDS).toBe(1800);
    expect(limitStepLicenseSeconds("ac5-project")).toBe(1800);
    expect(limitStepLicenseSeconds("ac1-templates")).toBe(1800);
    for (const step of LONG) {
      expect(limitStepLicenseSeconds(step)).toBeGreaterThan(1800);
      expect(limitStepLicenseSeconds(step)).toBeLessThanOrEqual(7200);
    }
    expect(Object.keys(LIMIT_STEP_LICENSE_SECONDS).sort()).toEqual([...LONG].sort());
    expect(limitStepLicenseSeconds("ac2-epics")).toBe(
      Math.max(...Object.values(LIMIT_STEP_LICENSE_SECONDS)),
    );
  });

  it.each([...LONG, "ac5-project"])("asks the shared renewal for the %s minimum", async (step) => {
    const renew = kept(9000);
    await createLimitLicenseGuard({ session, intent: memoryLimitIntent(), renew })(step);
    expect(renew).toHaveBeenCalledExactlyOnceWith(
      session,
      session.directory,
      limitStepLicenseSeconds(step),
    );
  });
});

describe("renewal at a step boundary", () => {
  it("renews exactly once before a step that lacks its window and records it body-free", async () => {
    const events = [];
    const intent = Object.assign(memoryLimitIntent(), {
      begin: (step) => events.push(`begin:${step}`),
      settled: vi.fn(),
    });
    const renew = renewed(900, 10700);
    const ctx = {
      signal: new globalThis.AbortController().signal,
      intent,
      checkLicense: async (step) => {
        events.push("license");
        await createLimitLicenseGuard({ session, intent, renew })(step);
      },
    };
    const run = vi.fn(async () => {
      events.push("run");
      return { step: "ac2-epics", status: "green", detail: "ok", counts: { done: 1 } };
    });
    await runLimitStep(ctx, [], "ac2-epics", run);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["license", "begin:ac2-epics", "run"]);
    const record = intent.records.find((entry) => entry.name === "licenseRenewal").value;
    expect(record).toMatchObject({
      phase: "renewed",
      count: 1,
      step: "ac2-epics",
      remainingBefore: 900,
      remainingAfter: 10700,
    });
    expect(Number.isInteger(record.downtimeMs)).toBe(true);
    expect(Object.keys(record).sort()).toEqual(
      ["count", "downtimeMs", "phase", "remainingAfter", "remainingBefore", "step"].sort(),
    );
  });

  it("counts renewals across the run and records none when the window suffices", async () => {
    const intent = memoryLimitIntent();
    await createLimitLicenseGuard({ session, intent, renew: kept(9000) })("ac2-epics");
    expect(intent.records).toEqual([]);
    const renew = renewed(100, 10000);
    const guard = createLimitLicenseGuard({ session, intent, renew });
    await guard("ac2-epics");
    await guard("ac4-hierarchy");
    expect(intent.records.map((entry) => entry.value.count)).toEqual([1, 2]);
    expect(intent.state.licenseRenewal.count).toBe(2);
  });

  it("fails closed when the renewal fails, without starting the step", async () => {
    const intent = memoryLimitIntent();
    const renew = vi.fn(async () => {
      throw new TypeError("Laboratory session start failed");
    });
    const run = vi.fn();
    const begin = vi.fn();
    const ctx = {
      signal: new globalThis.AbortController().signal,
      intent: Object.assign(intent, { begin }),
      checkLicense: createLimitLicenseGuard({ session, intent, renew }),
    };
    await expect(runLimitStep(ctx, [], "ac2-epics", run)).rejects.toThrow("start failed");
    expect(run).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(intent.state.licenseRenewal).toMatchObject({ phase: "failed", step: "ac2-epics" });
  });

  it("fails closed when the window is still too short after the renewal", async () => {
    const intent = memoryLimitIntent();
    await expect(
      createLimitLicenseGuard({ session, intent, renew: renewed(100, 3000) })("ac2-epics"),
    ).rejects.toThrow("shorter");
    expect(intent.state.licenseRenewal.phase).toBe("failed");
  });
});

describe("the limit-run context", () => {
  it("passes the step name to the injected renewal and keeps the guard on the context", async () => {
    const intent = memoryLimitIntent();
    const renew = kept(9000);
    const chat = (id) => ({ chat: { id } });
    const ctx = await createLimitRunContext(
      { session, cookie: "c", secret: "s", origin: "o", root: "r", projectPath: "p" },
      { document: chat("d"), report: chat("r"), denied: chat("x") },
      { projectKey: "LIM7" },
      intent,
      new globalThis.AbortController().signal,
      { assertWorkflowChatConfiguration: vi.fn(), renewLicenseWindow: renew },
    );
    await ctx.checkLicense("ac6-sprint");
    expect(renew).toHaveBeenCalledExactlyOnceWith(session, session.directory, 5400);
  });
});
