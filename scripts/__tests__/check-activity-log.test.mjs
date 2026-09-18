import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS } from "../../packages/keiko-contracts/dist/observability.js";
import {
  ACTIVITY_LOG_GATE_CHECKS,
  ACTIVITY_LOG_GATE_PREREQUISITE,
  ACTIVITY_LOG_GATE_STEPS,
  main,
  npmScriptRunner,
  runActivityLogGate,
} from "../check-activity-log.mjs";
import { unregisteredFailurePathViolations } from "../check-error-observability.mjs";
import {
  generateTypedActivityLogRegistry,
  validateActivityLogRegistryExemptions,
} from "../generate-op-catalog.mjs";
import { generateFailureSurfaceInventory } from "../lib/activity-log-failure-surface-inventory.mjs";
import { ACTIVITY_LOG_FAILURE_SURFACES } from "../lib/activity-log-failure-surfaces.mjs";

// The permanent Activity Log implementation gate (`npm run check:activity-log`) is a thin
// composition, so this suite proves three things about it and restates none of its rules:
//   1. the command runs every constituent over the full inventory and cannot be narrowed;
//   2. the command, its constituents, its registry input, its required-CI step and its documented
//      obligation cannot disappear without a red pin here;
//   3. every rule family it composes rejects a single-point mutation of a valid fixture and accepts
//      legitimate refactors, reordering, unrelated files, test-only helpers and documentation, all
//      through the production entry points (the typed-registry generator, the exemption validator,
//      the failure-surface inventory and the failure-path finder).

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

// Harness deadline for the one fixture registry program this suite compiles, not a product budget.
const FIXTURE_PROGRAM_TIMEOUT_MS = 2 * 60_000;
const GATE_COMMAND = "npm run check:activity-log";
const STEP_COUNT = ACTIVITY_LOG_GATE_STEPS.length;
const REQUIRED_CONSTITUENTS = [
  "check:op-catalog",
  "test:activity-log-scenarios",
  "check:error-observability",
  "arch:check",
  "arch:check:negative",
  "check:release-impact",
];

function recordGateRun(failingScripts = [], runScript = undefined) {
  const failing = new Set(failingScripts);
  const ran = [];
  const lines = [];
  let clock = 0;
  const result = runActivityLogGate({
    runScript:
      runScript ??
      ((script) => {
        ran.push(script);
        return !failing.has(script);
      }),
    now: () => {
      clock += 100;
      return clock;
    },
    write: (line) => lines.push(line),
  });
  return { ran, lines, result };
}

describe("the Activity Log gate command", () => {
  it("builds first and then runs every constituent exactly once, in order", () => {
    const { ran, lines, result } = recordGateRun();
    expect(ran).toEqual(ACTIVITY_LOG_GATE_STEPS.map((step) => step.script));
    expect(ran[0]).toBe("build:packages");
    expect(result.passed).toBe(true);
    expect(result.results.every((entry) => entry.passed)).toBe(true);
    expect(lines.at(-1)).toBe(
      `check:activity-log PASS — ${String(STEP_COUNT)} checks over the full registered inventory in 1.5 s.`,
    );
  });

  it("composes every required constituent check", () => {
    const scripts = ACTIVITY_LOG_GATE_CHECKS.map((check) => check.script);
    for (const constituent of REQUIRED_CONSTITUENTS) expect(scripts).toContain(constituent);
    expect(ACTIVITY_LOG_GATE_PREREQUISITE.script).toBe("build:packages");
  });

  it("keeps running after a failing check and names every failing check with its remediation", () => {
    const { ran, lines, result } = recordGateRun(["check:op-catalog", "check:release-impact"]);
    expect(ran).toEqual(ACTIVITY_LOG_GATE_STEPS.map((step) => step.script));
    expect(result.passed).toBe(false);
    const registry = ACTIVITY_LOG_GATE_CHECKS.find((check) => check.id === "registry");
    const releaseImpact = ACTIVITY_LOG_GATE_CHECKS.find((check) => check.id === "release-impact");
    expect(lines).toContain(`check:activity-log: registry failed — ${registry.remediation}`);
    expect(lines).toContain(
      `check:activity-log: release-impact failed — ${releaseImpact.remediation}`,
    );
    expect(lines.at(-1)).toMatch(
      new RegExp(
        `^check:activity-log FAIL — 2 failed and 0 not run of ${String(STEP_COUNT)} checks`,
        "u",
      ),
    );
  });

  it("stops after a failed build so that no check judges stale output", () => {
    const { ran, lines, result } = recordGateRun(["build:packages"]);
    expect(ran).toEqual(["build:packages"]);
    expect(result.passed).toBe(false);
    expect(lines.at(-1)).toMatch(
      new RegExp(
        `^check:activity-log FAIL — 1 failed and ${String(STEP_COUNT - 1)} not run of ${String(STEP_COUNT)} checks`,
        "u",
      ),
    );
  });

  it("fails closed when a constituent reports anything but success", () => {
    for (const outcome of [undefined, 0, "0", null, {}]) {
      const { result } = recordGateRun([], () => outcome);
      expect(result.passed).toBe(false);
    }
  });

  it("measures every step and the whole run", () => {
    const { lines, result } = recordGateRun();
    expect(result.results.map((entry) => entry.durationMs)).toEqual(Array(STEP_COUNT).fill(100));
    // One clock read opens the run, two bracket each step, and one closes it.
    expect(result.durationMs).toBe(100 + 200 * STEP_COUNT);
    expect(lines[0]).toBe("check:activity-log: build (npm run build:packages) PASS in 0.1 s");
  });

  it("refuses any argument, so no changed-file or path selection can narrow the proof", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "check-activity-log.mjs"), "--changed-only"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("always evaluates the full registered inventory");
  });

  it("exits 0 only when every check passed and 1 when one failed", () => {
    const quiet = { now: () => 0, write: () => undefined, writeError: () => undefined };
    expect(main([], { ...quiet, runScript: () => true })).toBe(0);
    expect(main([], { ...quiet, runScript: (script) => script !== "arch:check" })).toBe(1);
    const refused = [];
    expect(
      main(["origin/dev"], {
        ...quiet,
        writeError: (line) => refused.push(line),
        runScript: () => true,
      }),
    ).toBe(2);
    expect(refused).toHaveLength(1);
  });

  it("runs each check as a root npm script without a shell and accepts only a clean exit", () => {
    const calls = [];
    const outcome = (result) =>
      npmScriptRunner(
        (command, args, options) => {
          calls.push({ command, args, options });
          return result;
        },
        () => "/trusted/npm",
      )("check:op-catalog");
    expect(outcome({ status: 0, signal: null })).toBe(true);
    expect(calls[0]).toEqual({
      command: "/trusted/npm",
      args: ["run", "check:op-catalog"],
      options: { shell: false, stdio: "inherit" },
    });
    expect(outcome({ status: 1, signal: null })).toBe(false);
    expect(outcome({ status: null, signal: "SIGTERM" })).toBe(false);
    expect(outcome({ status: null, signal: null, error: new Error("spawn npm ENOENT") })).toBe(
      false,
    );
  });
});

// --- Wiring ----------------------------------------------------------------------------------------

function calledIdentifiers(source) {
  const sourceFile = ts.createSourceFile("pin.mjs", source, ts.ScriptTarget.Latest, true);
  const names = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.add(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function markdownSection(markdown, number) {
  const start = markdown.indexOf(`\n## ${String(number)}.`);
  if (start < 0) return "";
  const end = markdown.indexOf("\n## ", start + 1);
  return end < 0 ? markdown.slice(start) : markdown.slice(start, end);
}

function workspaceScripts() {
  const byName = new Map();
  for (const name of readdirSync(join(repoRoot, "packages"))) {
    const manifestPath = join("packages", name, "package.json");
    if (!existsSync(join(repoRoot, manifestPath))) continue;
    const manifest = JSON.parse(read(manifestPath));
    byName.set(manifest.name, manifest.scripts ?? {});
  }
  return byName;
}

function unknownDocumentedCommands(markdown, rootScripts, workspaces) {
  const unknown = [];
  for (const match of markdown.matchAll(/npm run ([\w:.-]+)(?:\s+--workspace\s+(@[\w./-]+))?/gu)) {
    const name = String(match[1]).replace(/\.+$/u, "");
    const scripts = match[2] === undefined ? rootScripts : (workspaces.get(match[2]) ?? {});
    if (scripts[name] === undefined) unknown.push(name);
  }
  return unknown;
}

function registryInputFindings(manifest, driftTest) {
  const findings = [];
  if (
    manifest.scripts["check:op-catalog"] !==
    "vitest run scripts/__tests__/op-catalog-drift.test.mjs"
  ) {
    findings.push("registry-input:script");
  }
  const called = calledIdentifiers(driftTest);
  for (const producer of [
    "generateOpCatalog",
    "generateActivityLogFailureSurfaceInventory",
    "failureSurfaceInventoryDrift",
    "validateActivityLogRegistryExemptions",
  ]) {
    if (!called.has(producer)) findings.push(`registry-input:${producer}`);
  }
  return findings;
}

function hostingJobs(workflow) {
  return Object.entries(workflow?.jobs ?? {}).flatMap(([name, job]) =>
    (job?.steps ?? [])
      .filter((step) => typeof step?.run === "string" && step.run.trim() === GATE_COMMAND)
      .map((step) => ({ name, job, step })),
  );
}

function ciFindings(workflowText) {
  const workflow = parse(workflowText);
  const hosts = hostingJobs(workflow);
  if (hosts.length !== 1) return [hosts.length === 0 ? "ci-step-missing" : "ci-step-duplicated"];
  const [{ name, job, step }] = hosts;
  const findings = [];
  if (!(workflow.jobs.ci?.needs ?? []).includes(name)) findings.push("ci-job-not-required");
  if (job.if !== undefined) findings.push("ci-job-conditional");
  if (step.if !== undefined || step["continue-on-error"] !== undefined) {
    findings.push("ci-step-conditional");
  }
  return findings;
}

function documentationFindings(inputs) {
  const findings = [];
  if (!markdownSection(inputs.agents, 3).includes(`\`${GATE_COMMAND}\``)) {
    findings.push("agents-gate-table");
  }
  if (!markdownSection(inputs.agents, 8).includes(`\`${GATE_COMMAND}\``)) {
    findings.push("agents-logging-obligation");
  }
  if (!inputs.contributing.includes(`\`${GATE_COMMAND}\``)) findings.push("contributing-gate");
  for (const [label, markdown] of [
    ["agents", inputs.agents],
    ["contributing", inputs.contributing],
  ]) {
    for (const name of unknownDocumentedCommands(
      markdown,
      inputs.manifest.scripts,
      inputs.workspaces,
    )) {
      findings.push(`${label}-unknown-command:${name}`);
    }
  }
  return findings;
}

function gateWiringFindings(inputs) {
  const findings = [];
  if (inputs.manifest.scripts["check:activity-log"] !== "node scripts/check-activity-log.mjs") {
    findings.push("script");
  }
  const scripts = inputs.steps.map((step) => step.script);
  if (scripts[0] !== "build:packages") findings.push("prerequisite");
  for (const constituent of REQUIRED_CONSTITUENTS) {
    if (!scripts.includes(constituent)) findings.push(`constituent:${constituent}`);
  }
  for (const script of scripts) {
    if (inputs.manifest.scripts[script] === undefined) findings.push(`unknown-script:${script}`);
  }
  return [
    ...findings,
    ...registryInputFindings(inputs.manifest, inputs.driftTest),
    ...ciFindings(inputs.workflow),
    ...documentationFindings(inputs),
  ];
}

function currentWiring() {
  return {
    manifest: JSON.parse(read("package.json")),
    steps: [...ACTIVITY_LOG_GATE_STEPS],
    driftTest: read("scripts/__tests__/op-catalog-drift.test.mjs"),
    workflow: read(".github/workflows/ci.yml"),
    agents: read("AGENTS.md"),
    contributing: read("CONTRIBUTING.md"),
    workspaces: workspaceScripts(),
  };
}

function withScripts(wiring, change) {
  const scripts = { ...wiring.manifest.scripts };
  change(scripts);
  return { ...wiring, manifest: { ...wiring.manifest, scripts } };
}

function replaced(text, search, replacement) {
  expect(text).toContain(search);
  return text.replace(search, () => replacement);
}

describe("required wiring of the Activity Log gate", () => {
  const current = currentWiring();
  const gateRun = `        run: ${GATE_COMMAND}\n`;

  it("is complete in the repository today", () => {
    expect(gateWiringFindings(current)).toEqual([]);
  });

  it.each([
    [
      "the package script is removed",
      (w) => withScripts(w, (s) => delete s["check:activity-log"]),
      "script",
    ],
    [
      "the package script gains a narrowing argument",
      (w) =>
        withScripts(
          w,
          (s) => (s["check:activity-log"] = "node scripts/check-activity-log.mjs --diff"),
        ),
      "script",
    ],
    ...REQUIRED_CONSTITUENTS.map((constituent) => [
      `the ${constituent} constituent is dropped`,
      (w) => ({ ...w, steps: w.steps.filter((step) => step.script !== constituent) }),
      `constituent:${constituent}`,
    ]),
    [
      "the build prerequisite is dropped",
      (w) => ({ ...w, steps: w.steps.slice(1) }),
      "prerequisite",
    ],
    [
      "a constituent names a script that does not exist",
      (w) => withScripts(w, (s) => delete s["check:release-impact"]),
      "unknown-script:check:release-impact",
    ],
    [
      "check:op-catalog stops running the registry drift suite",
      (w) =>
        withScripts(
          w,
          (s) => (s["check:op-catalog"] = "vitest run scripts/__tests__/other.test.mjs"),
        ),
      "registry-input:script",
    ],
    [
      "the drift suite stops generating the authoritative registry",
      (w) => ({
        ...w,
        driftTest: w.driftTest.replaceAll("generateOpCatalog(", "cachedOpCatalog("),
      }),
      "registry-input:generateOpCatalog",
    ],
    [
      "the drift suite stops comparing the failure-surface inventory",
      (w) => ({
        ...w,
        driftTest: w.driftTest.replaceAll("failureSurfaceInventoryDrift(", "ignoredDrift("),
      }),
      "registry-input:failureSurfaceInventoryDrift",
    ],
    [
      "the required CI step stops running the command",
      (w) => ({
        ...w,
        workflow: replaced(w.workflow, gateRun, "        run: npm run check:op-catalog\n"),
      }),
      "ci-step-missing",
    ],
    [
      "the hosting job leaves the required aggregate",
      (w) => ({ ...w, workflow: replaced(w.workflow, "      - core-quality\n", "") }),
      "ci-job-not-required",
    ],
    [
      "the CI step becomes conditional",
      (w) => ({
        ...w,
        workflow: replaced(w.workflow, gateRun, `${gateRun}        continue-on-error: true\n`),
      }),
      "ci-step-conditional",
    ],
    [
      "the CI step runs twice",
      (w) => ({
        ...w,
        workflow: replaced(w.workflow, gateRun, `${gateRun}      - run: ${GATE_COMMAND}\n`),
      }),
      "ci-step-duplicated",
    ],
    [
      "AGENTS.md drops the logging obligation",
      (w) => ({
        ...w,
        agents: w.agents.replace(markdownSection(w.agents, 8), () =>
          markdownSection(w.agents, 8).replaceAll(GATE_COMMAND, "the op catalog check"),
        ),
      }),
      "agents-logging-obligation",
    ],
    [
      "AGENTS.md drops the touched-area gate row",
      (w) => ({
        ...w,
        agents: w.agents.replace(markdownSection(w.agents, 3), () =>
          markdownSection(w.agents, 3).replaceAll(GATE_COMMAND, "the op catalog check"),
        ),
      }),
      "agents-gate-table",
    ],
    [
      "CONTRIBUTING.md drops the command",
      (w) => ({ ...w, contributing: w.contributing.replaceAll(GATE_COMMAND, "the gate") }),
      "contributing-gate",
    ],
    [
      "AGENTS.md names a command that does not exist",
      (w) => ({ ...w, agents: `${w.agents}\nRun \`npm run check:activity-log-lite\`.\n` }),
      "agents-unknown-command:check:activity-log-lite",
    ],
  ])("fails when %s", (_label, mutate, finding) => {
    expect(gateWiringFindings(mutate(current))).toContain(finding);
  });
});

// --- Rule families ---------------------------------------------------------------------------------

const FIXTURE_API = [
  "export function defineActivityLogOperation<const T>(value: T): T { return value; }",
  "export function activityLogEvent<const T>(",
  "  registration: T,",
  "  _envelope: object,",
  "  fields: Record<string, unknown>,",
  "): object {",
  '  return { ...fields, contractKind: "activity-log-event" as const, registration };',
  "}",
  "",
].join("\n");

const API_IMPORT =
  'import { activityLogEvent, defineActivityLogOperation } from "../../keiko-contracts/src/observability.js";';

function baselineSource(name) {
  return [
    API_IMPORT,
    "",
    "const operation = defineActivityLogOperation({",
    '  contractKind: "activity-log-operation" as const,',
    "  schemaVersion: 1 as const,",
    `  op: "fixture.gate.${name}",`,
    '  category: "diagnostic",',
    `  owner: "zzz-gate-${name}",`,
    '  emitter: "fixture",',
    "  fields: {",
    '    runId: { type: "string", dataClass: "opaque-id", required: true, maxLength: 128 },',
    "  },",
    '  causal: "correlation",',
    '  lifecycle: "failure",',
    '  analyzerProjection: "failure-cluster",',
    `  failureClasses: ["fixture-${name}"],`,
    `  proofIds: ["fixture-${name}-proof"],`,
    '  releaseImpact: "patch",',
    "});",
    "",
    "export function emitFixture(): object {",
    '  return activityLogEvent(operation, {}, { runId: "run-1" });',
    "}",
    "",
  ].join("\n");
}

// The declared obligations of the baseline's failure class: checked-in manifest data, exactly like
// activity-log-failure-class-contracts.ts, which the generator then verifies against the source.
function baselineContract(name) {
  const op = `fixture.gate.${name}`;
  return {
    contractKind: "activity-log-failure-class",
    schemaVersion: 1,
    failureClass: `fixture-${name}`,
    requiredProductSurfaces: [`zzz-gate-${name}`],
    requiredLifecycleOperations: { start: [], state: [], end: [], failure: [op], loss: [] },
    requiredCausalOperations: [op],
    requiredLossOperations: [],
    requiredProofOperations: [op],
    requiredReplayProofIds: [`fixture-${name}-proof`],
    requiredResourceOperations: [],
    requiredEvidenceClasses: ["completeness-state", "loss-state", "opaque-id"],
    requiredFrameOperations: [],
    requiredCauseOperations: [],
  };
}

const edit = (search, replacement) => (source) => {
  if (!source.includes(search)) throw new TypeError(`fixture mutation target missing: ${search}`);
  return source.replace(search, () => replacement);
};
const insertAfter = (anchor, line) => edit(anchor, `${anchor}\n${line}`);
const EMITTER_FUNCTION = [
  "export function emitFixture(): object {",
  '  return activityLogEvent(operation, {}, { runId: "run-1" });',
  "}",
  "",
].join("\n");
const UNREGISTERED_EMISSION = [
  API_IMPORT,
  'export const leaked = activityLogEvent({ op: "fixture.gate.unregistered" }, {}, {});',
  "",
].join("\n");

// One single-point mutation of the valid baseline per row. `obligation` is the registry's own
// implementation-obligation vocabulary, so a new obligation category without a mutation fails the
// completeness pin below.
const REGISTRY_MUTATIONS = [
  {
    name: "unregistered-emission",
    obligation: "typed-operation-registration",
    mutate: edit("activityLogEvent(operation,", "activityLogEvent({ ...operation },"),
    code: "emission-unregistered",
  },
  {
    name: "dynamic-operation",
    obligation: "typed-operation-registration",
    mutate: edit('op: "fixture.gate.dynamic-operation",', 'op: ["fixture", "gate"].join("."),'),
    code: "registration-not-literal",
  },
  {
    name: "unbounded-field",
    obligation: "closed-bounded-fields",
    mutate: edit(", maxLength: 128 }", " }"),
    code: "registration-invalid",
    detail: "fields.runId",
  },
  {
    name: "forbidden-data-class",
    obligation: "closed-bounded-fields",
    mutate: edit('dataClass: "opaque-id"', 'dataClass: "prompt-text"'),
    code: "registration-invalid",
    detail: "fields.runId",
  },
  {
    name: "unknown-registration-key",
    obligation: "closed-bounded-fields",
    mutate: insertAfter('  emitter: "fixture",', '  body: "captured",'),
    code: "registration-invalid",
    detail: "unknown-key",
  },
  {
    name: "unknown-causal-mode",
    obligation: "causal-correlation",
    mutate: edit('causal: "correlation"', 'causal: "best-effort"'),
    code: "registration-invalid",
    detail: "causal",
  },
  {
    name: "removed-causal-edge",
    obligation: "causal-correlation",
    mutate: edit('causal: "correlation"', 'causal: "none"'),
    code: "failure-class-contract-unsatisfied",
    detail: "causal-edges",
  },
  {
    name: "unknown-lifecycle",
    obligation: "lifecycle-evidence",
    mutate: edit('lifecycle: "failure"', 'lifecycle: "crashed"'),
    code: "registration-invalid",
    detail: "lifecycle",
  },
  {
    name: "moved-lifecycle-phase",
    obligation: "lifecycle-evidence",
    mutate: edit('lifecycle: "failure"', 'lifecycle: "state"'),
    code: "failure-class-contract-unsatisfied",
    detail: "lifecycle-failure",
  },
  {
    name: "unemitted-registration",
    obligation: "failure-evidence",
    mutate: edit(EMITTER_FUNCTION, ""),
    code: "registration-not-emitted",
  },
  {
    name: "undeclared-failure-class",
    obligation: "failure-evidence",
    mutate: edit(
      '["fixture-undeclared-failure-class"]',
      '["fixture-undeclared-failure-class-undeclared"]',
    ),
    code: "failure-class-contract-missing",
    detail: "fixture-undeclared-failure-class-undeclared",
  },
  {
    name: "overridden-loss-field",
    obligation: "loss-evidence",
    mutate: insertAfter(
      "  fields: {",
      '    loss: { type: "string", dataClass: "opaque-id", required: true, maxLength: 16 },',
    ),
    code: "registration-invalid",
    detail: "fields.loss",
  },
  {
    name: "overridden-completeness-field",
    obligation: "loss-evidence",
    mutate: insertAfter(
      "  fields: {",
      '    completeness: { type: "string", dataClass: "completeness-state", required: false },',
    ),
    code: "registration-invalid",
    detail: "fields.completeness",
  },
  {
    name: "unknown-analyzer-projection",
    obligation: "analyzer-projection",
    mutate: edit('analyzerProjection: "failure-cluster"', 'analyzerProjection: "dashboard"'),
    code: "registration-invalid",
    detail: "analyzerProjection",
  },
  {
    name: "removed-proof-link",
    obligation: "executable-proof",
    mutate: edit('["fixture-removed-proof-link-proof"]', "[]"),
    code: "registration-invalid",
    detail: "proofIds",
  },
  {
    name: "unknown-release-impact",
    obligation: "release-impact",
    mutate: edit('releaseImpact: "patch"', 'releaseImpact: "cosmetic"'),
    code: "registration-invalid",
    detail: "releaseImpact",
  },
  {
    name: "missing-release-impact",
    obligation: "release-impact",
    mutate: edit('  releaseImpact: "patch",\n', ""),
    code: "registration-invalid",
    detail: "releaseImpact",
  },
];

// Legitimate changes the gate must accept: each keeps the baseline's contract intact.
const REGISTRY_CONTROLS = [
  {
    name: "renamed-and-reordered",
    mutate: (source) =>
      [
        edit('  releaseImpact: "patch",\n', ""),
        insertAfter("  schemaVersion: 1 as const,", '  releaseImpact: "patch",'),
        edit("const operation =", "const failureRecord ="),
        edit("activityLogEvent(operation,", "activityLogEvent(failureRecord,"),
      ].reduce((text, step) => step(text), source),
  },
  {
    name: "aliased-emitter",
    mutate: (source) =>
      source
        .replace(
          "{ activityLogEvent, defineActivityLogOperation }",
          () => "{ activityLogEvent as emitActivity, defineActivityLogOperation }",
        )
        .replace("return activityLogEvent(", () => "return emitActivity("),
  },
  {
    name: "unrelated-file",
    files: {
      "src/unrelated.ts": [
        "function activityLogEvent(value: object): object { return value; }",
        'export const sample = activityLogEvent({ op: "fixture.gate.not-an-operation" });',
        "",
      ].join("\n"),
    },
  },
  {
    name: "test-only-helper",
    files: {
      "src/emit.test.ts": UNREGISTERED_EMISSION,
      "src/__tests__/helper.ts": UNREGISTERED_EMISSION,
    },
  },
  {
    name: "documentation-only",
    files: { "README.md": ["```ts", UNREGISTERED_EMISSION, "```", ""].join("\n") },
  },
];

// The same violations the controls contain, placed in production source: they must still fail.
const REGISTRY_FALSE_NEGATIVE_PINS = [
  {
    name: "production-helper",
    files: { "src/helper.ts": UNREGISTERED_EMISSION },
    code: "emission-unregistered",
    site: "packages/zzz-gate-production-helper/src/helper.ts:2",
  },
  {
    name: "aliased-unregistered-emission",
    mutate: (source) =>
      source
        .replace(
          "{ activityLogEvent, defineActivityLogOperation }",
          () => "{ activityLogEvent as emitActivity, defineActivityLogOperation }",
        )
        .replace(
          "return activityLogEvent(operation,",
          () => "return emitActivity({ ...operation },",
        ),
    code: "emission-unregistered",
  },
];

const FIXTURE_VARIANTS = [
  { name: "baseline" },
  ...REGISTRY_MUTATIONS,
  ...REGISTRY_CONTROLS,
  ...REGISTRY_FALSE_NEGATIVE_PINS,
];

function writeFixtureVariant(root, variant) {
  const packageDir = join(root, "packages", `zzz-gate-${variant.name}`);
  mkdirSync(join(packageDir, "src", "__tests__"), { recursive: true });
  const source = (variant.mutate ?? ((text) => text))(baselineSource(variant.name));
  writeFileSync(join(packageDir, "src", "fixture.ts"), source, "utf8");
  for (const [path, contents] of Object.entries(variant.files ?? {})) {
    writeFileSync(join(packageDir, ...path.split("/")), contents, "utf8");
  }
}

function variantViolations(registry, name) {
  const attributed = new RegExp(
    String.raw`(?:^packages/zzz-gate-${name}/|\.fixture-${name}(?:-undeclared)?$)`,
    "u",
  );
  return registry.violations.filter((violation) => attributed.test(violation.site));
}

describe("rule families the gate composes", () => {
  let root;
  let registry;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "activity-log-gate-fixture-"));
    const contractsDir = join(root, "packages", "keiko-contracts", "src");
    mkdirSync(contractsDir, { recursive: true });
    writeFileSync(join(contractsDir, "observability.ts"), FIXTURE_API, "utf8");
    for (const variant of FIXTURE_VARIANTS) writeFixtureVariant(root, variant);
    registry = generateTypedActivityLogRegistry(
      root,
      FIXTURE_VARIANTS.map((variant) => baselineContract(variant.name)),
    );
  }, FIXTURE_PROGRAM_TIMEOUT_MS);

  afterAll(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("covers every implementation obligation the registry publishes with a mutation", () => {
    expect(new Set(REGISTRY_MUTATIONS.map((mutation) => mutation.obligation))).toEqual(
      new Set(ACTIVITY_LOG_IMPLEMENTATION_OBLIGATIONS),
    );
  });

  it("accepts the valid baseline with its complete failure class", () => {
    expect(variantViolations(registry, "baseline")).toEqual([]);
    const baseline = registry.failureClassCoverage.classes.find(
      (entry) => entry.failureClass === "fixture-baseline",
    );
    expect(baseline.completeness).toBe("complete");
    expect(registry.operations.find((entry) => entry.op === "fixture.gate.baseline")).toMatchObject(
      {
        owner: "zzz-gate-baseline",
        registrationSite: "packages/zzz-gate-baseline/src/fixture.ts:3",
        emitterSites: ["packages/zzz-gate-baseline/src/fixture.ts:22"],
      },
    );
  });

  it.each(REGISTRY_MUTATIONS.map((mutation) => [mutation.name, mutation]))(
    "rejects the %s mutation with an actionable, body-free violation",
    (_name, mutation) => {
      const violations = variantViolations(registry, mutation.name);
      expect(violations).toContainEqual(
        expect.objectContaining({
          code: mutation.code,
          ...(mutation.detail === undefined ? {} : { detail: mutation.detail }),
          correctiveAction: expect.any(String),
        }),
      );
      for (const violation of violations) {
        expect(violation.site).toMatch(/^(?:packages\/[\w./-]+:\d+|typedRegistry\.[\w.-]+)$/u);
        expect(JSON.stringify(violation)).not.toContain("captured");
        expect(JSON.stringify(violation)).not.toContain("run-1");
      }
    },
  );

  it.each(REGISTRY_CONTROLS.map((control) => [control.name]))(
    "accepts the %s control without a false positive",
    (name) => {
      expect(variantViolations(registry, name)).toEqual([]);
      expect(registry.operations.filter((entry) => entry.owner === `zzz-gate-${name}`)).toEqual([
        expect.objectContaining({ op: `fixture.gate.${name}`, emitterSites: [expect.any(String)] }),
      ]);
    },
  );

  it.each(REGISTRY_FALSE_NEGATIVE_PINS.map((pin) => [pin.name, pin]))(
    "still rejects the %s production violation a control would hide",
    (_name, pin) => {
      expect(variantViolations(registry, pin.name)).toContainEqual(
        expect.objectContaining({
          code: pin.code,
          ...(pin.site === undefined ? {} : { site: pin.site }),
        }),
      );
    },
  );

  describe("exemptions", () => {
    const now = new Date("2026-09-18T00:00:00.000Z");
    const daysAhead = (days) =>
      new Date(now.valueOf() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const baselineOperation = () =>
      registry.operations.find((entry) => entry.op === "fixture.gate.baseline");
    const validExemption = (overrides = {}) => ({
      contractKind: "activity-log-exemption",
      schemaVersion: 1,
      id: "gate-fixture-durability-boundary",
      operation: "fixture.gate.baseline",
      failureClass: "fixture-baseline",
      boundary: "durability",
      owner: "zzz-gate-baseline",
      reason: "The fixture durability boundary cannot expose this proof signal.",
      trackingIssue: 3540,
      expiresOn: daysAhead(30),
      ...overrides,
    });
    const validate = (exemptions) =>
      validateActivityLogRegistryExemptions(exemptions, [baselineOperation()], now);

    it("accepts one exact, owned, expiring record in any key order", () => {
      expect(validate([validExemption()])).toEqual([]);
      const reordered = Object.fromEntries(Object.entries(validExemption()).toReversed());
      expect(validate([reordered])).toEqual([]);
      expect(validate([validExemption({ expiresOn: daysAhead(0) })])).toEqual([]);
      expect(
        validate([
          validExemption({
            expiresOn: daysAhead(registry.exemptionSchema.maximumValidityDays),
          }),
        ]),
      ).toEqual([]);
    });

    it("rejects the removal of every required field the published schema names", () => {
      for (const field of registry.exemptionSchema.required) {
        const exemption = Object.fromEntries(
          Object.entries(validExemption()).filter(([key]) => key !== field),
        );
        expect(validate([exemption]), field).toEqual([
          expect.objectContaining({ code: "exemption-invalid", detail: field }),
        ]);
      }
    });

    it.each([
      ["prohibited data", { fields: ["prompt"] }, "exemption-invalid", "unknown-key"],
      ["silent loss", { allowSilentLoss: true }, "exemption-invalid", "unknown-key"],
      ["incomplete evidence", { completeness: "partial" }, "exemption-invalid", "unknown-key"],
      ["a wildcard operation", { operation: "fixture.gate.*" }, "exemption-invalid", "operation"],
      [
        "a broader operation prefix",
        { operation: "fixture.gate" },
        "exemption-unknown-operation",
        "fixture.gate",
      ],
      [
        "an undeclared failure class",
        { failureClass: "fixture-other" },
        "exemption-failure-class-mismatch",
        "fixture-other",
      ],
      ["another owner", { owner: "keiko-server" }, "exemption-owner-mismatch", "keiko-server"],
      ["an unknown boundary", { boundary: "convenience" }, "exemption-invalid", "boundary"],
      ["an expired record", { expiresOn: daysAhead(-1) }, "exemption-expired", daysAhead(-1)],
      [
        "an effectively permanent record",
        { expiresOn: daysAhead(181) },
        "exemption-permanent",
        daysAhead(181),
      ],
    ])("rejects %s", (_label, overrides, code, detail) => {
      expect(validate([validExemption(overrides)])).toContainEqual(
        expect.objectContaining({ code, detail }),
      );
    });

    it("rejects a record that went stale when its operation left the registry", () => {
      expect(validateActivityLogRegistryExemptions([validExemption()], [], now)).toEqual([
        expect.objectContaining({ code: "exemption-unknown-operation" }),
      ]);
    });
  });

  describe("failure-surface inventory", () => {
    const surfaceRules = [
      { owner: "zzz-gate-baseline", emitterPrefix: "", surface: "runtime-packages" },
    ];
    const ownerPorts = {
      "zzz-gate-baseline": { port: "GateFixtureLogSink", declaredIn: "zzz-gate-baseline" },
    };
    const proofCall = {
      kind: "proof",
      id: "fixture-baseline-proof",
      file: "packages/zzz-gate-baseline/src/fixture.test.ts",
      site: "packages/zzz-gate-baseline/src/fixture.test.ts:4",
    };

    function baselineRegistry() {
      return {
        ...registry,
        operations: registry.operations.filter((entry) => entry.op === "fixture.gate.baseline"),
        failureClassContracts: [baselineContract("baseline")],
      };
    }

    // The fixture instruments one closed surface on purpose. The other closed surfaces report
    // `surface-uninstrumented`, which the first test pins once; every other assertion reads the
    // remaining violations, the ones this fixture's single operation can cause.
    function inventory(options = {}) {
      const generated = generateFailureSurfaceInventory(root, baselineRegistry(), {
        surfaceRules,
        ownerPorts,
        calls: [proofCall],
        enforceResolution: true,
        ...options,
      });
      return {
        ...generated,
        violations: generated.violations.filter(
          (violation) => violation.code !== "surface-uninstrumented",
        ),
        uninstrumented: generated.violations
          .filter((violation) => violation.code === "surface-uninstrumented")
          .map((violation) => violation.detail),
      };
    }

    function scenarioCall(scenario, site = "tests/activity-log-scenarios/gate.test.ts:7") {
      return { kind: "scenario", id: scenario, file: site.split(":")[0], site };
    }

    beforeAll(() => {
      writeFileSync(
        join(root, "packages", "zzz-gate-baseline", "src", "port.ts"),
        "export interface GateFixtureLogSink { write(event: object): void; }\n",
        "utf8",
      );
    });

    function requiredScenario() {
      return inventory().failureClassScenarios["fixture-baseline"][0];
    }

    it("accepts a mapped, port-bound, proven operation with its scenario", () => {
      const scenario = requiredScenario();
      expect(scenario).toMatch(/^runtime-packages\./u);
      const accepted = inventory({ calls: [proofCall, scenarioCall(scenario)] });
      expect(accepted.violations).toEqual([]);
      expect(new Set(accepted.uninstrumented)).toEqual(
        new Set(ACTIVITY_LOG_FAILURE_SURFACES.filter((surface) => surface !== "runtime-packages")),
      );
    });

    it("rejects a removed port binding and a port its package no longer declares", () => {
      const scenario = requiredScenario();
      const calls = [proofCall, scenarioCall(scenario)];
      expect(inventory({ calls, ownerPorts: {} }).violations).toContainEqual(
        expect.objectContaining({ code: "owner-port-unmapped", detail: "zzz-gate-baseline" }),
      );
      expect(
        inventory({
          calls,
          ownerPorts: {
            "zzz-gate-baseline": { port: "RenamedLogSink", declaredIn: "zzz-gate-baseline" },
          },
        }).violations,
      ).toContainEqual(expect.objectContaining({ code: "owner-port-undeclared" }));
    });

    it("rejects an operation no surface rule maps", () => {
      const scenario = requiredScenario();
      expect(
        inventory({ calls: [proofCall, scenarioCall(scenario)], surfaceRules: [] }).violations,
      ).toContainEqual(expect.objectContaining({ code: "surface-unmapped" }));
    });

    it("rejects a removed proof link and a proof outside the owning package", () => {
      const scenario = requiredScenario();
      expect(inventory({ calls: [scenarioCall(scenario)] }).violations).toContainEqual(
        expect.objectContaining({ code: "proof-unresolved", detail: "fixture.gate.baseline" }),
      );
      expect(
        inventory({
          calls: [
            { ...proofCall, file: "tests/elsewhere.test.ts", site: "tests/elsewhere.test.ts:1" },
            scenarioCall(scenario),
          ],
        }).violations,
      ).toContainEqual(expect.objectContaining({ code: "proof-outside-owner" }));
    });

    it("rejects a missing scenario mapping and an unknown scenario name", () => {
      expect(inventory().violations).toContainEqual(
        expect.objectContaining({ code: "scenario-unresolved", detail: "fixture-baseline" }),
      );
      expect(
        inventory({ calls: [proofCall, scenarioCall("runtime-packages.meltdown")] }).violations,
      ).toContainEqual(expect.objectContaining({ code: "scenario-unknown" }));
    });

    it("accepts the same proof and scenario resolved from reordered test files", () => {
      const scenario = requiredScenario();
      const calls = [
        scenarioCall(scenario, "tests/activity-log-scenarios/z.test.ts:3"),
        { ...proofCall, site: "packages/zzz-gate-baseline/src/fixture.test.ts:9" },
      ];
      expect(inventory({ calls }).violations).toEqual([]);
    });
  });

  describe("failure paths", () => {
    const path = "packages/zzz-gate-baseline/src/failure.ts";
    const evidenced = [
      "export function load(): void {",
      "  try { run(); } catch (error) { log.warn(error); }",
      "}",
    ].join("\n");

    it("accepts a failure path that emits evidence or propagates", () => {
      expect(unregisteredFailurePathViolations(evidenced, path)).toEqual([]);
      expect(
        unregisteredFailurePathViolations(
          evidenced.replace("log.warn(error);", "throw error;"),
          path,
        ),
      ).toEqual([]);
    });

    it("rejects the mutation that drops the evidence from the same failure path", () => {
      expect(
        unregisteredFailurePathViolations(
          evidenced.replace("log.warn(error);", "void error;"),
          path,
        ),
      ).toEqual([expect.objectContaining({ owner: "load", kind: "unregistered-catch" })]);
    });
  });
});
