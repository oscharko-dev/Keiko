import { expect, it, vi } from "vitest";
import {
  executeJiraRuntimeSettingsRead as read,
  isJiraRuntimeSettingsRead,
  JIRA_RUNTIME_SETTINGS_READS,
} from "./jira-managed-runtime-settings.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

function request(
  scalar: string | number | boolean | null,
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  return vi
    .fn<JiraMutationRequest>()
    .mockResolvedValue({ ok: true, status: 200, body: undefined, scalar });
}
it.each([true, false])("retains actual JMX exposure %s as a read observation", async (exposed) => {
  const port = request(exposed);
  expect((await read("jira.jmx-metrics-exposed", {}, port)).data).toEqual({
    outcome: "succeeded",
    exposed,
  });
  expect(port).toHaveBeenCalledExactlyOnceWith(
    "monitoring/jmx/areMetricsExposed",
    "GET",
    undefined,
    "json-scalar",
  );
});
it.each([
  ["jira.search-max-aggregation-buckets", "searchLimits/maxAggregationBuckets"],
  ["jira.search-max-result-window", "searchLimits/maxResultWindow"],
] as const)(
  "preserves signed native %s without interpreting sentinels as policy",
  async (name, path) => {
    for (const limit of [0, -1, 10000]) {
      const port = request(limit);
      expect((await read(name, {}, port)).data).toEqual({ outcome: "succeeded", limit });
      expect(port).toHaveBeenCalledExactlyOnceWith(path, "GET", undefined, "json-scalar");
    }
  },
);
it.each(["true", 1, null])("refuses non-boolean JMX observations: %j", async (scalar) => {
  expect((await read("jira.jmx-metrics-exposed", {}, request(scalar))).data.reason).toBe(
    "malformed-payload",
  );
});
it.each(["10000", false, null, 0.5])(
  "refuses absent or non-integer search limits: %j",
  async (scalar) => {
    expect((await read("jira.search-max-result-window", {}, request(scalar))).data.reason).toBe(
      "malformed-payload",
    );
  },
);
it("labels a native search limit beyond the exact numeric bound instead of rounding it", async () => {
  expect(
    (await read("jira.search-max-result-window", {}, request(Number.MAX_SAFE_INTEGER + 1))).data
      .reason,
  ).toBe("bounds-exceeded");
});
it.each(JIRA_RUNTIME_SETTINGS_READS)(
  "refuses target, authority and setting changes on %s before transport",
  async (name) => {
    const port = request(false);
    expect(
      (await read(name, { url: "https://untrusted.invalid", value: true }, port)).data.reason,
    ).toBe("invalid-input");
    expect(port).not.toHaveBeenCalled();
  },
);
it.each(JIRA_RUNTIME_SETTINGS_READS)(
  "preserves native permission refusal for %s without alternate calls",
  async (name) => {
    const port = vi
      .fn<JiraMutationRequest>()
      .mockResolvedValue({ ok: false, reason: "permission-denied", httpStatus: 403 });
    expect((await read(name, {}, port)).data.reason).toBe("permission-denied");
    expect(port).toHaveBeenCalledTimes(1);
  },
);
it("does not mistake a monitoring state change for a registered scalar observation", () => {
  expect(isJiraRuntimeSettingsRead("jira.jmx-metrics-exposed")).toBe(true);
  expect(isJiraRuntimeSettingsRead("jira.start-monitoring")).toBe(false);
});
