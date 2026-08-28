import { describe, expect, it, vi } from "vitest";

import { observeInfrastructureRuns } from "../report-infra-failure-observation.mjs";

function page(runs, next, totalCount = runs.length) {
  return {
    ok: true,
    status: 200,
    headers: new globalThis.Headers(next === undefined ? {} : { link: `<${next}>; rel="next"` }),
    json: async () => ({ total_count: totalCount, workflow_runs: runs }),
  };
}

describe("report-infra-failure-observation", () => {
  it("paginates one UTC day and excludes manual dispatches from the observation envelope", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        page(
          [
            { event: "workflow_run", conclusion: "skipped" },
            { event: "workflow_dispatch", conclusion: "success" },
          ],
          "https://api.github.com/repos/oscharko-dev/Keiko/actions/workflows/infra-failure-retry.yml/runs?created=2026-08-25&page=2",
        ),
      )
      .mockResolvedValueOnce(page([{ event: "workflow_run", conclusion: "success" }]));

    const report = await observeInfrastructureRuns(
      { from: "2026-08-25", to: "2026-08-25", repo: "oscharko-dev/Keiko" },
      { fetch, token: "test-token" },
    );

    expect(report).toMatchObject({ total: 2, skipped: 1, observerCompleted: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects impossible UTC dates before querying GitHub", async () => {
    const fetch = vi.fn();

    await expect(
      observeInfrastructureRuns(
        { from: "2026-02-31", to: "2026-02-31", repo: "oscharko-dev/Keiko" },
        { fetch, token: "test-token" },
      ),
    ).rejects.toThrow("valid UTC calendar dates");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed workflow-run responses instead of publishing an empty report", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new globalThis.Headers(),
      json: async () => ({ total_count: 0, workflow_runs: {} }),
    });

    await expect(
      observeInfrastructureRuns(
        { from: "2026-08-25", to: "2026-08-25", repo: "oscharko-dev/Keiko" },
        { fetch, token: "test-token" },
      ),
    ).rejects.toThrow("has no workflow_runs");
  });

  it("rejects hostile pagination links before sending the token to another endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(page([], "https://attacker.invalid/steal?created=2026-08-25"));

    await expect(
      observeInfrastructureRuns(
        { from: "2026-08-25", to: "2026-08-25", repo: "oscharko-dev/Keiko" },
        { fetch, token: "test-token" },
      ),
    ).rejects.toThrow("unsafe pagination link");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a day at the GitHub filtered-listing cap", async () => {
    const fetch = vi.fn().mockResolvedValue(page([], undefined, 1000));

    await expect(
      observeInfrastructureRuns(
        { from: "2026-08-25", to: "2026-08-25", repo: "oscharko-dev/Keiko" },
        { fetch, token: "test-token" },
      ),
    ).rejects.toThrow("1,000-run listing cap");
  });

  it("preserves an explicit empty observation day", async () => {
    const fetch = vi.fn().mockResolvedValue(page([]));

    await expect(
      observeInfrastructureRuns(
        { from: "2026-08-25", to: "2026-08-25", repo: "oscharko-dev/Keiko" },
        { fetch, token: "test-token" },
      ),
    ).resolves.toMatchObject({
      days: [{ date: "2026-08-25", total: 0, skipped: 0, observerCompleted: 0 }],
      total: 0,
      skipped: 0,
      observerCompleted: 0,
    });
  });
});
