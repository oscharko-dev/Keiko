import { describe, expect, it } from "vitest";
import { gitDeliveryObservationFailure } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import type { GitProviderPageResult } from "./git-provider-observation.js";
import { collectGitCiRequirements } from "./git-ci-requirements.js";

function page(values: readonly unknown[]): GitProviderPageResult {
  return { values, completeness: { complete: true, entries: values.length, pages: 1, bytes: 1 } };
}
const SOURCE = { ruleset_id: 12, ruleset_source_type: "Organization" };

describe("active branch CI requirements union", () => {
  it("deduplicates exact requirements and produces an order-independent immutable digest", () => {
    const rules = [7, 8].map((id) => ({
      ...SOURCE,
      ruleset_id: id,
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: "build", integration_id: 9 }],
      },
    }));
    const first = collectGitCiRequirements({
      protection: { outcome: "unprotected" },
      rules: page(rules),
    });
    const second = collectGitCiRequirements({
      protection: { outcome: "unprotected" },
      rules: page([...rules].reverse()),
    });
    expect(first).toEqual(second);
    if (first.status !== "observed") throw new Error("missing requirements");
    expect(first.requirements).toHaveLength(1);
    expect(first.requirements[0]?.sources).toHaveLength(2);
    expect(Object.isFrozen(first.requirements[0]?.sources)).toBe(true);
    expect(Object.isFrozen(first.requirements[0]?.sources[0])).toBe(true);
  });

  it.each(["required_deployments", "code_scanning", "merge_queue"])(
    "does not hide unsupported technical rule %s",
    (type) => {
      expect(
        collectGitCiRequirements({
          protection: { outcome: "unprotected" },
          rules: page([{ ...SOURCE, type, parameters: {} }]),
        }),
      ).toMatchObject({ status: "unknown", failure: { reason: "requirements-ambiguous" } });
    },
  );

  it.each([
    {},
    { contexts: ["private\ncontext"] },
    { checks: [{ context: "build", app_id: 0 }] },
    { contexts: [], strict: true },
    { contexts: "missing-array" },
  ])("fails closed on incomplete protection shape %j", (checks) => {
    expect(
      collectGitCiRequirements({
        protection: { outcome: "protected", value: { checks, strict: false, reviewCount: 0 } },
        rules: page([]),
      }),
    ).toMatchObject({ status: "unknown" });
  });

  it("distinguishes explicit empty requirements from an inconsistent complete-page claim", () => {
    expect(
      collectGitCiRequirements({ protection: { outcome: "unprotected" }, rules: page([]) }),
    ).toMatchObject({ status: "observed", requirements: [] });
    expect(
      collectGitCiRequirements({
        protection: { outcome: "unprotected" },
        rules: {
          values: [],
          completeness: { complete: true, entries: 1, pages: 1, bytes: 1 },
        },
      }),
    ).toMatchObject({ status: "unknown" });
  });

  it("unions legacy contexts, app-bound protection checks and active organization workflow rules", () => {
    const result = collectGitCiRequirements({
      protection: {
        outcome: "protected",
        value: {
          checks: { contexts: ["legacy", "build"], checks: [{ context: "build", app_id: 7 }] },
          strict: false,
          reviewCount: 2,
        },
      },
      rules: page([
        {
          ...SOURCE,
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "security", integration_id: 8 }],
            strict_required_status_checks_policy: true,
          },
        },
        {
          ...SOURCE,
          type: "workflows",
          parameters: {
            workflows: [
              { repository_id: 9, path: ".github/workflows/policy.yml", sha: "d".repeat(40) },
            ],
          },
        },
      ]),
    });
    expect(result.status).toBe("observed");
    if (result.status !== "observed") throw new Error("missing requirements");
    expect(result.strict).toBe(true);
    expect(result.requirements).toHaveLength(4);
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ kind: "status-context", context: "build", appId: 7 }),
    );
    expect(result.requirements).toContainEqual(
      expect.objectContaining({ kind: "workflow", repositoryId: 9, sha: "d".repeat(40) }),
    );
  });

  it("never turns hidden protection or a partial ruleset page into empty green requirements", () => {
    const failure = gitDeliveryObservationFailure("provider-not-found");
    expect(
      collectGitCiRequirements({ protection: { outcome: "unknown", failure }, rules: page([]) }),
    ).toMatchObject({ status: "unknown", failure });
    expect(
      collectGitCiRequirements({
        protection: { outcome: "unprotected" },
        rules: {
          values: [],
          completeness: {
            complete: false,
            entries: 0,
            pages: 3,
            bytes: 1,
            failure: gitDeliveryObservationFailure("pagination-exhausted"),
          },
        },
      }),
    ).toMatchObject({ status: "unknown", failure: { reason: "pagination-exhausted" } });
  });

  it("rejects malformed requirements and unknown rule kinds without discarding them", () => {
    for (const rule of [
      { ...SOURCE, type: "required_status_checks", parameters: { required_status_checks: [] } },
      {
        ...SOURCE,
        type: "workflows",
        parameters: { workflows: [{ repository_id: 9, path: "../escape" }] },
      },
      { ...SOURCE, type: "future_required_gate", parameters: {} },
    ])
      expect(
        collectGitCiRequirements({ protection: { outcome: "unprotected" }, rules: page([rule]) }),
      ).toMatchObject({ status: "unknown" });
  });
});
