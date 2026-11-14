// The lab's own Jira as a closed state (#4369): an outage is never "0 seconds of license left".
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LAB_STATES,
  LabOutageError,
  captureOutageEvidence,
  labJiraState,
  waitForFront,
  waitForJiraHealth,
} from "../testing/jira-chat-lab/requirements/lab-health.mjs";
import { renewLicenseWindow } from "../testing/jira-chat-lab/requirements/license-window.mjs";
import { classifyJourney, invalidCheck } from "../testing/jira-chat-lab/requirements/validity.mjs";

vi.mock("../testing/jira-chat-lab/lab-client.mjs", async (original) => ({
  ...(await original()),
  basicAuth: () => "Basic fixture",
}));

const session = { directory: "/s", project: "keiko-jira-4081-test" };
const NOW = Date.parse("2026-11-13T12:00:00Z");
const license = (secondsLeft, extra = {}) => ({
  status: 200,
  value: { valid: true, expired: false, expiryDate: NOW + secondsLeft * 1000, ...extra },
});
const read = (request) => labJiraState(session, { request: async () => request(), now: () => NOW });

describe("labJiraState", () => {
  it("is licensed with the seconds left on a real, valid reading", async () => {
    expect(await read(() => license(5400))).toEqual({ state: "licensed", remaining: 5400 });
  });

  it.each([
    ["an invalid license", { status: 200, value: { valid: false, expired: false } }],
    ["an expired license", license(100, { expired: true })],
    ["a license whose time ran out", license(-5)],
  ])("is expired only for %s", async (_name, answer) => {
    expect(await read(() => answer)).toEqual({ state: "expired" });
  });

  it("is unreachable when nothing answers, never an expired license", async () => {
    expect(
      await read(() => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ state: "unreachable" });
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    expect(
      await read(() => {
        throw timeout;
      }),
    ).toEqual({ state: "unreachable" });
  });

  it("is starting when Jira answers with its startup page or a 503", async () => {
    expect(await read(() => ({ status: 503 }))).toEqual({ state: "starting" });
    expect(
      await read(() => {
        throw new TypeError("Laboratory response is not JSON");
      }),
    ).toEqual({ state: "starting" });
  });

  it("does not hide a refused credential as an outage", async () => {
    await expect(read(() => ({ status: 401 }))).rejects.toThrow("refused");
  });

  it("holds the four closed states", () => {
    expect(LAB_STATES).toEqual(["licensed", "expired", "unreachable", "starting"]);
  });
});

describe("waitForJiraHealth", () => {
  const instant = { sleep: async () => undefined, pollMs: 1 };

  it("returns the first real reading and calls onDown once for the outage before it", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ state: "unreachable" })
      .mockResolvedValueOnce({ state: "starting" })
      .mockResolvedValue({ state: "licensed", remaining: 9000 });
    const onDown = vi.fn();
    const reading = await waitForJiraHealth(session, { ...instant, probe, onDown, boundMs: 1e9 });
    expect(reading).toEqual({ state: "licensed", remaining: 9000 });
    expect(onDown).toHaveBeenCalledOnce();
    expect(onDown).toHaveBeenCalledWith({ state: "unreachable" });
  });

  it("an expired license is a real reading and ends the wait", async () => {
    const probe = vi.fn().mockResolvedValue({ state: "expired" });
    expect((await waitForJiraHealth(session, { ...instant, probe })).state).toBe("expired");
  });

  it("ends as a lab outage with the last state once the bound passes", async () => {
    let clock = 0;
    const probe = vi.fn().mockResolvedValue({ state: "unreachable" });
    const wait = waitForJiraHealth(session, {
      probe,
      boundMs: 100,
      pollMs: 40,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await expect(wait).rejects.toMatchObject({ name: "LabOutageError", reason: "unreachable" });
    expect(probe.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("waitForFront", () => {
  it("waits until Keiko's route to Jira answers, within the bound", async () => {
    const answers = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    await waitForFront(session, { answers, sleep: async () => undefined, pollMs: 1 });
    expect(answers).toHaveBeenCalledTimes(3);
  });

  it("is a lab outage when the front never answers", async () => {
    let clock = 0;
    await expect(
      waitForFront(session, {
        answers: async () => false,
        boundMs: 50,
        pollMs: 20,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toMatchObject({ reason: "front-unreachable" });
  });
});

describe("captureOutageEvidence", () => {
  const roots = [];
  afterEach(() =>
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  );
  const directory = () => {
    const root = mkdtempSync(join(homedir(), ".keiko-lab-health-test-"));
    roots.push(root);
    return root;
  };

  it("keeps each container's exit/OOM state and its last log lines in the session directory", async () => {
    const root = directory();
    const docker = vi.fn(async (args) => {
      if (args[0] === "ps") return "aaaaaaaaaaaa\nbbbbbbbbbbbb";
      if (args[0] === "inspect")
        return JSON.stringify([
          {
            Config: {
              Labels: {
                "com.docker.compose.service": args[1] === "aaaaaaaaaaaa" ? "jira" : "other",
              },
            },
            State: { Status: "exited", Running: false, OOMKilled: true, ExitCode: 137 },
            RestartCount: 0,
          },
        ]);
      return "line 1\nline 2";
    });
    const path = await captureOutageEvidence(session, root, {
      docker,
      now: () => "2026-11-13T12:29:31.000Z",
      reason: "before-wait-unreachable",
    });
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.reason).toBe("before-wait-unreachable");
    expect(record.containers).toHaveLength(1);
    expect(record.containers[0]).toMatchObject({
      service: "jira",
      state: { oomKilled: true, exitCode: 137, status: "exited" },
      logTail: ["line 1", "line 2"],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "lab-outage"))).toHaveLength(1);
    // Only this session's own Compose project is asked for.
    expect(docker.mock.calls[0][0]).toContain(
      `label=com.docker.compose.project=${session.project}`,
    );
  });

  it("records a failed capture as such and never throws the outage away", async () => {
    const root = directory();
    const path = await captureOutageEvidence(session, root, {
      docker: async () => {
        throw new Error("docker unavailable");
      },
      now: () => "2026-11-13T12:30:00.000Z",
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      captureFailed: true,
      errorName: "Error",
    });
    expect(existsSync(path)).toBe(true);
  });
});

describe("the license renewal never reads an outage as an expired license", () => {
  const base = () => {
    const calls = [];
    const ports = {
      probe: vi.fn(),
      waitHealth: vi.fn(),
      capture: vi.fn(async (_s, _d, options) => calls.push(["capture", options.reason])),
      restart: vi.fn(() => calls.push(["restart"])),
      waitFront: vi.fn(async () => calls.push(["front"])),
      log: vi.fn(),
    };
    return { calls, ports };
  };
  const dir = () => mkdtempSync(join(homedir(), ".keiko-lab-renew-test-"));

  it("an unreachable Jira that comes back licensed restarts nothing", async () => {
    const { ports, calls } = base();
    ports.waitHealth.mockImplementation(async (_s, options) => {
      await options.onDown({ state: "unreachable" });
      return { state: "licensed", remaining: 9000 };
    });
    const root = dir();
    try {
      const result = await renewLicenseWindow(session, root, 2700, ports);
      expect(result).toEqual({ restarted: false, remainingBefore: 9000, remainingAfter: 9000 });
      expect(ports.restart).not.toHaveBeenCalled();
      expect(calls).toEqual([["capture", "before-wait-unreachable"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a Jira that stays down ends as a lab outage, with no restart", async () => {
    const { ports } = base();
    ports.waitHealth.mockRejectedValue(new LabOutageError("unreachable"));
    const root = dir();
    try {
      await expect(renewLicenseWindow(session, root, 2700, ports)).rejects.toMatchObject({
        name: "LabOutageError",
        reason: "unreachable",
      });
      expect(ports.restart).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a real expired reading restarts once, keeps the evidence first and waits for the front", async () => {
    const { ports, calls } = base();
    ports.waitHealth
      .mockResolvedValueOnce({ state: "expired" })
      .mockResolvedValue({ state: "licensed", remaining: 10_000 });
    ports.probe
      .mockResolvedValueOnce({ state: "expired" })
      .mockResolvedValue({ state: "licensed", remaining: 10_000 });
    const root = dir();
    try {
      const result = await renewLicenseWindow(session, root, 2700, ports);
      expect(result).toMatchObject({ restarted: true, remainingBefore: 0, remainingAfter: 10_000 });
      expect(calls).toEqual([["capture", "before-license-restart"], ["restart"], ["front"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a journey that meets a down Jira is invalid, never red", () => {
  const red = { status: "red", detail: "turn failed", covers: [] };
  const none = { outages: 0, circuit: 0 };

  it.each(["unreachable", "starting", "expired"])(
    "a red journey with the lab %s is invalid lab-outage",
    (state) => {
      expect(classifyJourney(red, none, true, state)).toMatchObject({
        status: "invalid",
        reason: "lab-outage",
        covers: [],
      });
    },
  );

  it("keeps a red journey red while the lab is licensed, and a green one green", () => {
    expect(classifyJourney(red, none, true, "licensed").status).toBe("red");
    expect(classifyJourney(red, none, true).status).toBe("red");
    expect(classifyJourney({ status: "green" }, none, true, "unreachable").status).toBe("green");
  });

  it("lab-outage is a closed invalid reason", () => {
    expect(invalidCheck("lab-outage", "x").reason).toBe("lab-outage");
    expect(() => invalidCheck("lab-gone", "x")).toThrow("Unknown invalid reason");
  });
});
