import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "release.yml",
);

describe("customer-shape publish gate", () => {
  it("runs the staged Yarn Workbench journey before npm publication without a bypass", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const install = workflow.indexOf("run: npx playwright install --with-deps chromium");
    const qualify = workflow.indexOf("run: npm run qualify:coding-workbench:customer-shape");
    const publish = workflow.indexOf('run: npm run release:publish -- --tag "$NPM_DIST_TAG"');
    expect(install).toBeGreaterThan(0);
    expect(qualify).toBeGreaterThan(install);
    expect(publish).toBeGreaterThan(qualify);
    const gate = workflow.slice(workflow.lastIndexOf("- name:", qualify), publish);
    expect(gate).not.toContain("continue-on-error:");
    expect(gate).not.toMatch(/^\s+if:/mu);
  });
});
