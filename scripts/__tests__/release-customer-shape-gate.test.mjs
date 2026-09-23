import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = resolve(
  import.meta.dirname,
  "..",
  "..",
  ".github",
  "workflows",
  "release.yml",
);
const workflow = readFileSync(workflowPath, "utf8");

function unconditionalStep(step) {
  return step.if === undefined && step["continue-on-error"] === undefined;
}

function noRedundantBuildStep(steps) {
  return !steps.some((step) => step.name === "Build workspace packages");
}

function qualificationStepGate(installStep, qualifyStep, steps) {
  return (
    installStep.run === "npx playwright install --with-deps chromium" &&
    installStep["timeout-minutes"] === 10 &&
    qualifyStep.run === "npm run qualify:coding-workbench:customer-shape" &&
    qualifyStep["timeout-minutes"] === 25 &&
    unconditionalStep(qualifyStep) &&
    noRedundantBuildStep(steps)
  );
}

function qualificationJobGate(qualification) {
  if (qualification?.["runs-on"] !== "macos-15") return false;
  if (qualification.needs !== "authorize") return false;
  const steps = qualification.steps;
  const index = (name) => steps.findIndex((step) => step.name === name);
  const install = index("Install Chromium for customer-shape qualification");
  const qualify = index("Run customer-shape qualification");
  if (install < 0 || qualify <= install) return false;
  const installStep = steps[install];
  const qualifyStep = steps[qualify];
  return qualificationStepGate(installStep, qualifyStep, steps);
}

function publishJobGate(publishJob) {
  if (!publishJob.needs?.includes("qualify-customer-shape")) return false;
  if (!publishJob.if?.includes("needs.qualify-customer-shape.result == 'success'")) return false;
  const publishStep = publishJob.steps.find((step) => step.name === "Publish package");
  return publishStep?.run === 'npm run release:publish -- --tag "$NPM_DIST_TAG"';
}

function executableGate(source) {
  const { jobs } = parse(source);
  return qualificationJobGate(jobs["qualify-customer-shape"]) && publishJobGate(jobs.publish);
}

describe("customer-shape publish gate", () => {
  it("runs the bounded staged Yarn Workbench journey on macOS before npm publication", () => {
    expect(executableGate(workflow)).toBe(true);
  });

  it("rejects a comment that mentions qualification when the executable step is bypassed", () => {
    const bypassed = workflow.replace(
      "run: npm run qualify:coding-workbench:customer-shape",
      "run: echo bypassed\n        # run: npm run qualify:coding-workbench:customer-shape",
    );
    expect(executableGate(bypassed)).toBe(false);
  });
});
