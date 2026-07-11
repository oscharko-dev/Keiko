import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
const config = readFileSync(resolve(repoRoot, ".github/zizmor.yml"), "utf8");

const ZIZMOR_ACTION_SHA = "192e21d79ab29983730a13d1382995c2307fbcaa";

describe("zizmor workflow job", () => {
  it("uses the verified zizmor-action release commit and a pinned zizmor version", () => {
    expect(workflow).toContain(`zizmorcore/zizmor-action@${ZIZMOR_ACTION_SHA}`);
    expect(workflow).toMatch(/zizmor:\s*\n[\s\S]*?version:\s*"1\.26\.1"/u);
  });

  it("fails the job on findings instead of only reporting via SARIF", () => {
    // advanced-security uses zizmor's --format=sarif under the hood, which never returns a
    // non-zero exit code (SARIF consumers read the report, not the process exit code) - so the
    // job would stay green even with findings. annotations: true keeps the job's own exit code
    // as the gate, matching every other check in this repository.
    const jobBlock = workflow.match(/ {2}zizmor:\n(?:.*\n)*?(?= {2}\S|$)/u)?.[0] ?? "";
    expect(jobBlock).toMatch(/advanced-security:\s*false/u);
    expect(jobBlock).toMatch(/annotations:\s*true/u);
  });

  it("uses read-only repository permissions and disables checkout credentials", () => {
    const jobBlock = workflow.match(/ {2}zizmor:\n(?:.*\n)*?(?= {2}\S|$)/u)?.[0] ?? "";
    expect(jobBlock).toMatch(/permissions:\s*\n\s+contents: read/u);
    expect(jobBlock).toContain("persist-credentials: false");
  });

  it("does not suppress cache-poisoning findings", () => {
    expect(config).not.toContain("cache-poisoning:");
  });

  it("documents the misfeature ignore with the Windows MSVC toolchain constraint", () => {
    expect(config).toMatch(
      /misfeature:\n\s+ignore:\n(\s+#[^\n]+\n)+\s+- portable-assets\.yml:115\n\s+- portable-assets\.yml:181/u,
    );
  });

  it("documents the adhoc-packages ignore with the npm Trusted Publishing bootstrap constraint", () => {
    expect(config).toMatch(/adhoc-packages:\n\s+ignore:\n(\s+#[^\n]+\n)+\s+- release\.yml:\d+/u);
  });
});
