import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  checkCodSpeedPolicy,
  loadPolicySource,
  main,
  validateLiveSettings,
} from "../check-codspeed-policy.mjs";

const POLICY = JSON.stringify({
  failOnRegression: true,
  project: "oscharko-dev/Keiko",
  pullRequestReport: "always",
  regressionThresholdPercent: 5,
  schemaVersion: 2,
});
const SETTINGS = {
  data: {
    repository: {
      settings: {
        allowedRegression: 0.05,
        commentingCondition: "ALWAYS",
        informationalCheckOnFailure: false,
      },
    },
  },
};

function response(payload = SETTINGS, ok = true) {
  return { json: vi.fn().mockResolvedValue(payload), ok };
}

describe("live CodSpeed policy", () => {
  it("keeps the base-owned live gate independent from the YAML reviewer parser", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "..", "check-codspeed-policy.mjs"),
      "utf8",
    );
    expect(source).toContain('from "./lib/codspeed-policy-contract.mjs"');
    expect(source).not.toContain("check-external-quality-config");
    expect(source).not.toContain('from "yaml"');
  });

  it("loads the workflow-provided candidate policy path as data", () => {
    const read = vi.fn().mockReturnValue(POLICY);
    expect(loadPolicySource({ QUALITY_CODSPEED_POLICY_PATH: "/runner/policy.json" }, read)).toBe(
      POLICY,
    );
    expect(read).toHaveBeenCalledWith("/runner/policy.json", "utf8");
  });

  it("falls back to the repository policy when the workflow override is empty", () => {
    const read = vi.fn().mockReturnValue(POLICY);
    expect(loadPolicySource({ QUALITY_CODSPEED_POLICY_PATH: "" }, read)).toBe(POLICY);
    expect(read).toHaveBeenCalledWith(expect.stringContaining(".codspeed-policy.json"), "utf8");
  });

  it("accepts the exact blocking five-percent settings", () => {
    expect(validateLiveSettings(JSON.parse(POLICY), SETTINGS)).toEqual([]);
  });

  it("rejects a relaxed threshold, informational failure, or omitted report", () => {
    const payload = structuredClone(SETTINGS);
    payload.data.repository.settings = {
      allowedRegression: 0.1,
      commentingCondition: "ON_CHANGE",
      informationalCheckOnFailure: true,
    };
    expect(validateLiveSettings(JSON.parse(POLICY), payload)).toEqual([
      "live regression threshold differs from the repository policy",
      "live performance failures are not configured as blocking checks",
      "live pull-request reporting differs from the repository policy",
    ]);
  });

  it.each([{}, { data: {} }, { data: { repository: { settings: [] } } }])(
    "rejects a malformed remote response without reflecting it",
    (payload) => {
      expect(() => validateLiveSettings(JSON.parse(POLICY), payload)).toThrow(
        "live settings response is missing the project settings object",
      );
    },
  );

  it.each([undefined, null, "", "0.05", {}, [], Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "rejects malformed live regression threshold %s",
    (allowedRegression) => {
      const payload = structuredClone(SETTINGS);
      payload.data.repository.settings.allowedRegression = allowedRegression;
      expect(() => validateLiveSettings(JSON.parse(POLICY), payload)).toThrow(
        "live regression threshold is invalid",
      );
    },
  );

  it("accepts zero as the finite lower boundary before comparing policy", () => {
    const payload = structuredClone(SETTINGS);
    payload.data.repository.settings.allowedRegression = 0;
    expect(validateLiveSettings(JSON.parse(POLICY), payload)).toContain(
      "live regression threshold differs from the repository policy",
    );
  });

  it("fails closed on a GraphQL error without reflecting provider content", () => {
    expect(() =>
      validateLiveSettings(JSON.parse(POLICY), { errors: [{ message: "sensitive" }] }),
    ).toThrow("live settings response contains GraphQL errors");
  });

  it("sends a bounded unauthenticated query for the fixed public project", async () => {
    const request = vi.fn().mockResolvedValue(response());
    await expect(checkCodSpeedPolicy(POLICY, request)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://gql.codspeed.io");
    expect(options.headers).toEqual({ "content-type": "application/json" });
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body).variables).toEqual({
      owner: "oscharko-dev",
      repository: "Keiko",
    });
    expect(options.signal).toBeInstanceOf(globalThis.AbortSignal);
  });

  it("fails closed when the service request or repository policy is invalid", async () => {
    const unavailable = vi.fn().mockResolvedValue(response({}, false));
    await expect(checkCodSpeedPolicy(POLICY, unavailable)).rejects.toThrow(
      "live settings request did not succeed",
    );
    await expect(checkCodSpeedPolicy("{}", vi.fn())).rejects.toThrow(
      "CodSpeed policy schema version must remain 2",
    );
  });

  it("returns testable success and failure statuses with redacted diagnostics", async () => {
    const log = vi.fn();
    const error = vi.fn();
    await expect(main(POLICY, vi.fn().mockResolvedValue(response()), log, error)).resolves.toBe(0);
    expect(log).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();

    await expect(
      main(POLICY, vi.fn().mockResolvedValue(response({}, false)), log, error),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      "codspeed-policy: FAIL — live settings request did not succeed",
    );
  });
});
