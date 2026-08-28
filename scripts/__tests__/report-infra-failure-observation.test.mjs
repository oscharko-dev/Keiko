import { describe, expect, it, vi } from "vitest";

import { observeInfrastructureRuns } from "../report-infra-failure-observation.mjs";

function page(runs, next) {
  return {
    ok: true,
    status: 200,
    headers: new globalThis.Headers(next === undefined ? {} : { link: `<${next}>; rel="next"` }),
    json: async () => ({ workflow_runs: runs }),
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
});
