import { describe, expect, it } from "vitest";

import {
  api,
  ceilingViolations,
  CEILINGS,
  computeHealth,
  failedRunJobs,
  fetchRuns,
  formatReport,
  jobList,
  percentile,
  runPage,
  topFailingJobs,
  windowStart,
} from "../report-ci-health.mjs";

const T0 = "2026-11-20T10:00:00Z";

function run(overrides) {
  return {
    id: 1,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: "a",
    created_at: T0,
    run_started_at: T0,
    updated_at: "2026-11-20T11:00:00Z",
    ...overrides,
  };
}

describe("percentile", () => {
  it("uses the nearest rank and is null for an empty list", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe("computeHealth", () => {
  it("counts only completed pull-request runs by conclusion", () => {
    const health = computeHealth([
      run({ conclusion: "success" }),
      run({ conclusion: "failure", head_sha: "b" }),
      run({ conclusion: "cancelled", head_sha: "b" }),
      run({ event: "push", conclusion: "failure" }),
      run({ status: "in_progress", conclusion: null }),
    ]);
    expect(health).toMatchObject({ completed: 3, succeeded: 1, failed: 1, cancelled: 1 });
  });

  it("counts heads run more than once", () => {
    const health = computeHealth([
      run({ head_sha: "a" }),
      run({ head_sha: "a", conclusion: "cancelled" }),
      run({ head_sha: "b" }),
    ]);
    expect(health.heads).toBe(2);
    expect(health.repeatedHeads).toBe(1);
  });

  it("sums cancelled hours from the run start, not the creation", () => {
    const health = computeHealth([
      run({
        conclusion: "cancelled",
        created_at: "2026-11-20T09:00:00Z",
        run_started_at: "2026-11-20T10:00:00Z",
        updated_at: "2026-11-20T11:30:00Z",
      }),
      run({ conclusion: "cancelled", run_started_at: undefined }),
    ]);
    expect(health.cancelledHours).toBe(2.5);
  });

  it("measures verdict minutes per outcome from creation", () => {
    const health = computeHealth([
      run({ updated_at: "2026-11-20T10:30:00Z" }),
      run({ updated_at: "2026-11-20T11:30:00Z" }),
      run({ conclusion: "failure", updated_at: "2026-11-20T10:10:00Z" }),
    ]);
    expect(health.successVerdictMinutes).toEqual({ median: 30, p90: 90 });
    expect(health.failureVerdictMinutes).toEqual({ median: 10, p90: 10 });
  });

  it("reports no verdict times for an empty window", () => {
    const health = computeHealth([]);
    expect(health.successVerdictMinutes).toEqual({ median: null, p90: null });
    expect(ceilingViolations(health)).toEqual([]);
  });
});

describe("topFailingJobs", () => {
  it("counts each failing job once per run, most frequent first, ties by name", () => {
    const jobs = topFailingJobs([
      [
        { name: "ui", conclusion: "failure" },
        { name: "ui", conclusion: "failure" },
        { name: "ci", conclusion: "failure" },
      ],
      [
        { name: "ci", conclusion: "failure" },
        { name: "Core quality", conclusion: "failure" },
        { name: "lint", conclusion: "success" },
      ],
    ]);
    expect(jobs).toEqual([
      { name: "ci", runs: 2 },
      { name: "Core quality", runs: 1 },
      { name: "ui", runs: 1 },
    ]);
  });

  it("keeps at most the requested number", () => {
    const jobs = topFailingJobs(
      [["a", "b", "c"].map((name) => ({ name, conclusion: "failure" }))],
      2,
    );
    expect(jobs).toHaveLength(2);
  });
});

describe("ceilingViolations", () => {
  const healthy = {
    failed: 1,
    succeeded: 3,
    successVerdictMinutes: { median: 40, p90: 60 },
  };

  it("holds at the ceilings and fails just above them", () => {
    expect(ceilingViolations(healthy)).toEqual([]);
    const atCeiling = { failed: 53, succeeded: 47, successVerdictMinutes: { median: 85 } };
    expect(ceilingViolations(atCeiling)).toEqual([]);
    const above = { failed: 54, succeeded: 46, successVerdictMinutes: { median: 86 } };
    const violations = ceilingViolations(above);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("54/100");
    expect(violations[1]).toContain("86 min");
  });

  it("names the ceilings it checks", () => {
    expect(Object.keys(CEILINGS).sort()).toEqual([
      "failedShareOfDecided",
      "successVerdictMedianMinutes",
    ]);
  });
});

describe("formatReport", () => {
  it("renders the window, the measures, the jobs and the verdict", () => {
    const health = computeHealth([run({})]);
    const report = formatReport(health, [{ name: "ui", runs: 3 }], [], "2026-11-14");
    expect(report).toContain("since 2026-11-14");
    expect(report).toContain("| Cancelled / failed / succeeded | 0 / 0 / 1 |");
    expect(report).toContain("| ui | 3 |");
    expect(report).toContain("All ceilings hold.");
  });

  it("renders an empty job table and every crossed ceiling", () => {
    const report = formatReport(computeHealth([]), [], ["x is above y"], "2026-11-14");
    expect(report).toContain("| none | 0 |");
    expect(report).toContain("n/a / n/a");
    expect(report).toContain("- x is above y");
  });
});

describe("windowStart", () => {
  const now = new Date("2026-11-21T12:00:00Z");

  it("defaults to seven days and accepts --days", () => {
    expect(windowStart([], now)).toBe("2026-11-14");
    expect(windowStart(["--days", "1"], now)).toBe("2026-11-20");
  });

  it("refuses a missing, zero or fractional window", () => {
    for (const argv of [["--days"], ["--days", "0"], ["--days", "1.5"], ["--days", "x"]]) {
      expect(() => windowStart(argv, now)).toThrow(TypeError);
    }
  });
});

describe("api", () => {
  const noPause = () => Promise.resolve();

  function answers(...statuses) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      const status = statuses[Math.min(calls.length, statuses.length) - 1];
      return { ok: status === 200, status, json: async () => ({ status }) };
    };
    return { calls, fetch };
  }

  it("sends the token and returns the body", async () => {
    const { calls, fetch } = answers(200);
    expect(await api("/x", "t0k", { fetch, pause: noPause })).toEqual({ status: 200 });
    expect(calls[0].url).toBe("https://api.github.com/x");
    expect(calls[0].init.headers.authorization).toBe("Bearer t0k");
  });

  it("retries a 5xx answer with growing pauses", async () => {
    const { calls, fetch } = answers(502, 503, 200);
    const pauses = [];
    const pause = async (ms) => {
      pauses.push(ms);
    };
    expect(await api("/x", "t", { fetch, pause })).toEqual({ status: 200 });
    expect(calls).toHaveLength(3);
    expect(pauses).toEqual([2000, 4000]);
  });

  it("gives up after the last attempt and never retries a 4xx", async () => {
    const failing = answers(502);
    await expect(api("/x", "t", { fetch: failing.fetch, pause: noPause })).rejects.toThrow(
      "GitHub API 502 for /x",
    );
    expect(failing.calls).toHaveLength(3);
    const refused = answers(403);
    await expect(api("/x", "t", { fetch: refused.fetch, pause: noPause })).rejects.toThrow(
      "GitHub API 403",
    );
    expect(refused.calls).toHaveLength(1);
  });
});

// CodeRabbit on #4513: gate and evidence tooling fails closed. A malformed answer or a window the
// page limit cut short is a measurement error, never an empty or complete window.
describe("acquisition", () => {
  const noPause = () => Promise.resolve();

  function pages(...bodies) {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      const body = bodies[Math.min(urls.length, bodies.length) - 1];
      return { ok: true, status: 200, json: async () => body };
    };
    return { urls, fetch };
  }

  const fullPage = { workflow_runs: Array.from({ length: 100 }, (_, id) => run({ id })) };

  it("reads pages until a short one, and keeps a valid empty window", async () => {
    const { urls, fetch } = pages(fullPage, { workflow_runs: [run({ id: 7 })] });
    expect(await fetchRuns("o/r", "t", "2026-11-14", { fetch, pause: noPause })).toHaveLength(101);
    expect(urls).toHaveLength(2);
    const empty = pages({ workflow_runs: [] });
    expect(await fetchRuns("o/r", "t", "2026-11-14", { fetch: empty.fetch })).toEqual([]);
  });

  it("refuses a window the page limit would cut short", async () => {
    const { urls, fetch } = pages(fullPage);
    await expect(fetchRuns("o/r", "t", "2026-11-14", { fetch })).rejects.toThrow(
      "more than 1000 runs since 2026-11-14",
    );
    expect(urls).toHaveLength(10);
  });

  it.each([
    ["no run list", {}],
    ["a run list that is not a list", { workflow_runs: { id: 1 } }],
    ["a run without its head", { workflow_runs: [run({ head_sha: undefined })] }],
    ["a run with an unreadable time", { workflow_runs: [run({ updated_at: "later" })] }],
  ])("refuses an answer with %s", async (_, body) => {
    const { fetch } = pages(body);
    await expect(fetchRuns("o/r", "t", "2026-11-14", { fetch })).rejects.toThrow(TypeError);
    expect(() => runPage(body, 1)).toThrow("page 1");
  });

  it("refuses a failed run's malformed job list and reads a valid one", async () => {
    const runs = [run({ id: 9, conclusion: "failure" })];
    const valid = pages({ jobs: [{ name: "ci", conclusion: "failure" }] });
    expect(await failedRunJobs("o/r", "t", runs, { fetch: valid.fetch })).toEqual([
      [{ name: "ci", conclusion: "failure" }],
    ]);
    for (const body of [{}, { jobs: [{ conclusion: "failure" }] }]) {
      const { fetch } = pages(body);
      await expect(failedRunJobs("o/r", "t", runs, { fetch })).rejects.toThrow("run 9");
    }
    expect(jobList({ jobs: [] }, 9)).toEqual([]);
  });
});
