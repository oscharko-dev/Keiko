import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

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
  return (
    step.if === undefined &&
    step["continue-on-error"] === undefined &&
    step.shell === undefined &&
    step["working-directory"] === undefined
  );
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

function publishStepsGate(steps) {
  const buildIndex = steps.findIndex(
    (step) => step.name === "Build workspace packages for publisher imports",
  );
  const publishIndex = steps.findIndex((step) => step.name === "Publish package");
  return (
    buildIndex >= 0 &&
    publishIndex > buildIndex &&
    steps[buildIndex]?.run === "npm run build:packages" &&
    unconditionalStep(steps[buildIndex]) &&
    steps[publishIndex]?.run === 'npm run release:publish -- --tag "$NPM_DIST_TAG"'
  );
}

function publishJobGate(publishJob) {
  if (!publishJob.needs?.includes("qualify-customer-shape")) return false;
  if (!publishJob.if?.includes("needs.qualify-customer-shape.result == 'success'")) return false;
  return publishStepsGate(publishJob.steps);
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

  it("rejects a publish job whose clean runner never builds publisher imports", () => {
    const modified = parse(workflow);
    const step = modified.jobs.publish.steps.find(
      (candidate) => candidate.name === "Build workspace packages for publisher imports",
    );
    if (step === undefined) throw new Error("publisher build step missing");
    step.run = "echo bypassed";
    expect(executableGate(stringify(modified))).toBe(false);
  });

  it("rejects a conditional publisher build that publication could skip", () => {
    const modified = parse(workflow);
    const step = modified.jobs.publish.steps.find(
      (candidate) => candidate.name === "Build workspace packages for publisher imports",
    );
    if (step === undefined) throw new Error("publisher build step missing");
    step.if = "false";
    expect(executableGate(stringify(modified))).toBe(false);
  });

  it.each(["shell", "working-directory"])(
    "rejects a qualification step with a %s execution override",
    (property) => {
      const modified = parse(workflow);
      const step = modified.jobs["qualify-customer-shape"].steps.find(
        (candidate) => candidate.name === "Run customer-shape qualification",
      );
      if (step === undefined) throw new Error("qualification step missing");
      step[property] = property === "shell" ? 'bash -c "true" -- {0}' : "scripts";
      expect(executableGate(stringify(modified))).toBe(false);
    },
  );
});
