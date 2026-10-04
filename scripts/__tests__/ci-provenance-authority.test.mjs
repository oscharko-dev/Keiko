import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"),
  { maxAliasCount: 0 },
);

describe("CI provenance authority", () => {
  it.each(["build-scan-sbom-smoke", "ui"])(
    "%s executes candidate code without OIDC or attestation authority",
    (id) => {
      expect(workflow.jobs[id].permissions).toEqual({ contents: "read" });
      expect(workflow.jobs[id].steps.some((step) => step.uses?.startsWith("actions/attest@"))).toBe(
        false,
      );
    },
  );

  it("attests only trusted push artifacts without executing repository code", () => {
    const job = workflow.jobs["sbom-provenance"];
    expect(job.if).toBe("${{ github.event_name == 'push' }}");
    expect(job.needs).toEqual(["build-scan-sbom-smoke", "ui"]);
    expect(job.permissions).toEqual({
      actions: "read",
      attestations: "write",
      contents: "read",
      "id-token": "write",
    });
    expect(
      job.steps.every(
        (step) =>
          step.run === undefined &&
          /^(?:actions\/download-artifact|actions\/attest)@/u.test(step.uses),
      ),
    ).toBe(true);
    expect(job.steps.filter((step) => step.uses.startsWith("actions/attest@"))).toHaveLength(3);
    expect(workflow.jobs.ci.needs).toContain("sbom-provenance");
  });
});
