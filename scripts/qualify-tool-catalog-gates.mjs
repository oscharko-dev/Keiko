import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assessGitCiFacts,
  createNodeGitCiReader,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { detectWorkspaceAt } from "@oscharko-dev/keiko-workspace";

import {
  CATALOG_CLOSEOUT_CHECKS,
  CATALOG_CLOSEOUT_CONSUMERS,
  catalogCloseoutHead,
  requireExternalManifest,
} from "./check-tool-catalog-closeout.mjs";
import { compareStrings } from "./lib/compare-strings.mjs";
import { resolveHostExecutable } from "./lib/host-executable.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import { writeToolCatalogQualificationReports } from "./qualify-tool-catalog-consumers.mjs";

const COMMAND_TIMEOUT_MS = 45 * 60 * 1_000;
const LOCAL_GATE_COMMANDS = Object.freeze({
  "catalog-conformance": [["node", "scripts/check-tool-catalog-conformance.mjs", "--closeout"]],
  "catalog-performance": [["npm", "run", "check:tool-catalog-performance"]],
  "support-timelines": [
    [
      "npm",
      "exec",
      "vitest",
      "run",
      "--",
      "packages/keiko-cli/src/support-tool-catalog.test.ts",
      "packages/keiko-server/src/tool-catalog/catalogToolBinder.test.ts",
      "packages/keiko-server/src/tool-catalog/catalogToolDispatch.test.ts",
      "packages/keiko-server/src/tool-catalog/catalogToolProduction.test.ts",
      "packages/keiko-server/src/tool-catalog/catalogToolSettlement.test.ts",
      "--reporter=dot",
    ],
  ],
  "package-surface": [["npm", "run", "check:package-surface:assembled"]],
  "clean-checkout": [],
  "generated-manifests": [
    ["npm", "run", "check:governed-tool-contract"],
    ["npm", "run", "check:tool-catalog-conformance"],
    ["npm", "run", "check:op-catalog"],
    ["npm", "run", "check:publish-manifests"],
    ["npm", "run", "check:portable-manifest"],
  ],
  "release-metadata": [
    ["npm", "run", "check:adr-index"],
    ["npm", "run", "check:version-consistency"],
    ["npm", "run", "check:release-impact"],
    ["npm", "run", "check:release-alignment"],
    ["npm", "run", "check:release-required-workflows"],
  ],
  types: [["npm", "run", "typecheck"]],
  lint: [["npm", "run", "lint"]],
  format: [["npm", "run", "format:check"]],
  tests: [["npm", "test"]],
  architecture: [
    ["npm", "run", "arch:check"],
    ["npm", "run", "arch:check:negative"],
  ],
  coverage: [["npm", "run", "test:coverage:quality"]],
  sonar: [["npm", "run", "gates:sonar"]],
});

export const LOCAL_CATALOG_GATE_IDS = Object.freeze(Object.keys(LOCAL_GATE_COMMANDS));
export const CATALOG_GATE_IDS = Object.freeze(
  CATALOG_CLOSEOUT_CHECKS.filter((id) => !CATALOG_CLOSEOUT_CONSUMERS.includes(id)),
);

if (
  !isDeepStrictEqual(
    [...LOCAL_CATALOG_GATE_IDS, "required-ci"].sort(compareStrings),
    [...CATALOG_GATE_IDS].sort(compareStrings),
  )
) {
  throw new TypeError("Tool catalog gate qualification: producer inventory is incomplete");
}

function requireQualification(condition, message) {
  if (!condition) throw new TypeError(`Tool catalog gate qualification: ${message}`);
}

function privateReceiptsDirectory(directory) {
  requireQualification(isAbsolute(directory), "receipts directory must be absolute");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  requireQualification(
    entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0,
    "receipts directory must be a private real directory",
  );
  return resolve(directory);
}

function requireExternalOutputs(root, ...directories) {
  for (const directory of directories) requireExternalManifest(root, directory);
}

function platformTarget(platform = process.platform, architecture = process.arch) {
  return `${platform}-${architecture}`;
}

function commandExecutable(name) {
  return name === "node" ? process.execPath : resolveHostExecutable(name);
}

function writeCommandLog(directory, id, index, result) {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  writeFileSync(join(directory, `${id}-${String(index + 1)}.log`), `${stdout}${stderr}`, {
    mode: 0o600,
  });
}

function runGateCommands(id, commands, root, logsDir, deps) {
  commands.forEach(([name, ...args], index) => {
    const result = deps.run(deps.executable(name), args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      stdio: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
    });
    writeCommandLog(logsDir, id, index, result);
    requireQualification(
      result.error === undefined && result.signal === null && result.status === 0,
      `${id} command ${String(index + 1)} did not pass`,
    );
  });
}

function gateReport(currentHead, passed, root) {
  const product = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  return {
    schemaVersion: 1,
    currentHead,
    artifactDigest: null,
    platform: platformTarget(),
    runtime: { node: process.versions.node, product },
    executionKind: "qualification-gate",
    status: "passed",
    passed,
    failed: 0,
    skipped: 0,
    binding: null,
    components: null,
    packages: null,
  };
}

function writeGateReport(receiptsDir, id, report, recordedAt) {
  const directory = privateReceiptsDirectory(receiptsDir);
  writeToolCatalogQualificationReports(directory, new Map([[id, report]]), recordedAt);
}

function defaultDependencies() {
  return {
    cleanHead: catalogCloseoutHead,
    executable: commandExecutable,
    now: () => new Date(),
    run: spawnSync,
  };
}

export function qualifyLocalCatalogGate(input, deps = defaultDependencies()) {
  const commands = LOCAL_GATE_COMMANDS[input.id];
  requireQualification(commands !== undefined, "unsupported local catalog gate");
  requireExternalOutputs(input.root, input.logsDir, input.receiptsDir);
  const currentHead = deps.cleanHead(input.root);
  const logsDir = privateReceiptsDirectory(input.logsDir);
  runGateCommands(input.id, commands, input.root, logsDir, deps);
  requireQualification(
    deps.cleanHead(input.root) === currentHead,
    "source changed during qualification",
  );
  const passed = input.id === "clean-checkout" ? 1 : commands.length;
  requireQualification(passed > 0, "gate performed no checks");
  if (input.id === "clean-checkout") {
    writeFileSync(join(logsDir, "clean-checkout-1.log"), "exact clean head observed twice\n", {
      mode: 0o600,
    });
  }
  const report = gateReport(currentHead, passed, input.root);
  writeGateReport(input.receiptsDir, input.id, report, deps.now().toISOString());
  return report;
}

function githubRepository(origin) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
      origin,
    );
  requireQualification(match?.groups !== undefined, "origin is not a GitHub repository");
  return match.groups;
}

function requiredCiDependencies() {
  return {
    cleanHead: catalogCloseoutHead,
    now: () => new Date(),
    origin: (root) =>
      spawnSync(resolveHostExecutable("git"), ["remote", "get-url", "origin"], {
        cwd: root,
        encoding: "utf8",
        shell: false,
      }).stdout.trim(),
    reader: (root, stillAuthorized) =>
      createNodeGitCiReader({
        workspace: detectWorkspaceAt(root, undefined, { scanSourceFilesForLanguages: false }),
        processEnv: process.env,
        stillAuthorized,
      }),
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  requireQualification(Number.isSafeInteger(parsed) && parsed > 0, "invalid pull request number");
  return parsed;
}

function allRequiredChecksPassed(required) {
  return (
    required.total > 0 &&
    required.passed === required.total &&
    required.failed === 0 &&
    required.pending === 0 &&
    required.blocked === 0 &&
    required.unknown === 0
  );
}

function passedRequiredCi(facts, currentHead) {
  requireQualification(facts.status === "observed", "required CI evidence is unavailable");
  const assessment = assessGitCiFacts(facts);
  const required = assessment.requiredChecks;
  requireQualification(
    facts.identity.headSha === currentHead &&
      assessment.complete &&
      assessment.reason === "required-checks-passed" &&
      assessment.requirementsDigest !== null &&
      assessment.strictBaseRequired &&
      allRequiredChecksPassed(required),
    "required CI is not complete on the exact source head",
  );
  return { passed: required.passed, requirementsDigest: assessment.requirementsDigest };
}

async function requiredCiResult(repository, currentHead, prNumber, root, deps) {
  let facts;
  try {
    facts = await deps
      .reader(root, () => deps.cleanHead(root) === currentHead)
      .readFacts({
        ownerAndRepo: `${repository.owner}/${repository.repo}`,
        prExternalId: String(prNumber),
        baseBranchName: "dev",
        headSha: currentHead,
      });
  } catch {
    throw new TypeError("Tool catalog gate qualification: required CI evidence is unavailable");
  }
  return passedRequiredCi(facts, currentHead);
}

export async function qualifyRequiredCi(input, deps = requiredCiDependencies()) {
  requireExternalOutputs(input.root, input.logsDir, input.receiptsDir);
  const currentHead = deps.cleanHead(input.root);
  const logsDir = privateReceiptsDirectory(input.logsDir);
  const repository = githubRepository(deps.origin(input.root));
  const result = await requiredCiResult(
    repository,
    currentHead,
    positiveInteger(input.prNumber),
    input.root,
    deps,
  );
  requireQualification(
    deps.cleanHead(input.root) === currentHead,
    "source changed during qualification",
  );
  const report = gateReport(currentHead, result.passed, input.root);
  writeFileSync(
    join(logsDir, "required-ci-1.log"),
    `${JSON.stringify({
      exactHead: true,
      passedCount: result.passed,
      requirementsDigest: result.requirementsDigest,
    })}\n`,
    { mode: 0o600 },
  );
  writeGateReport(input.receiptsDir, "required-ci", report, deps.now().toISOString());
  return report;
}

function requiredArgument(argv, flag) {
  const index = argv.indexOf(flag);
  requireQualification(index >= 0 && argv[index + 1] !== undefined, `missing ${flag}`);
  return argv[index + 1];
}

if (isMainModule(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const input = {
      id: requiredArgument(argv, "--check"),
      logsDir: resolve(requiredArgument(argv, "--logs")),
      ...(argv.includes("--pull-request")
        ? { prNumber: requiredArgument(argv, "--pull-request") }
        : {}),
      receiptsDir: resolve(requiredArgument(argv, "--receipts")),
      root: process.cwd(),
    };
    if (input.id === "required-ci") await qualifyRequiredCi(input);
    else qualifyLocalCatalogGate(input);
    process.stdout.write(`Tool catalog gate qualification: PASS ${input.id}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "qualification failed"}\n`);
    process.exitCode = 1;
  }
}
