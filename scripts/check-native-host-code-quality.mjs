#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { stageCodingRuntimeNpmServiceHost } from "./build-coding-runtime-npm-package.mjs";
import { loadPortableRuntimeApprovals } from "./portable-runtime-approvals.mjs";
import { npmCommand, shouldShellNpmCommand } from "./package-surface-pack.mjs";
import { runNativePolicy, runnerIdentity } from "./lib/code-quality-runner.mjs";
import { isMainModule } from "./lib/is-main-module.mjs";
import {
  nativeEffectQualityFixtures,
  nativeEffectServiceFixture,
} from "./__tests__/support/native-effect-quality-fixtures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostSource = join(repoRoot, "native/opencode-service-host");

export function runNativeHostQualityProcess(executable, args, options) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.signal || result.status !== 0)
    throw new TypeError("native-host-qualification-process-failed");
  return result.stdout;
}

export function nativeHostQualityTarget(platform = process.platform, architecture = process.arch) {
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture))
    return `macos-${architecture}`;
  throw new TypeError("native-host-qualification-platform-unsupported");
}

function installLockedHost() {
  runNativeHostQualityProcess(
    npmCommand(),
    ["ci", "--ignore-scripts", "--workspaces=false", "--no-audit", "--no-fund"],
    {
      cwd: hostSource,
      // SECURITY-SHELL-OK: fixed npm ci argv; trusted npm.cmd requires the existing Windows helper.
      shell: shouldShellNpmCommand(),
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
}

function writeFixtures(root) {
  writeFileSync(join(root, "services.mjs"), nativeEffectServiceFixture);
  const files = [{ path: "services.mjs" }];
  for (const fixture of nativeEffectQualityFixtures) {
    for (const category of ["safe", "bad"]) {
      const path = `${fixture.rule}-${category}.mjs`;
      writeFileSync(join(root, path), fixture[category]);
      files.push({ path });
    }
  }
  return files;
}

export function assertNativeEffectFixtureDiagnostics(result) {
  const findings = result.diagnostics.filter(({ rule }) => rule.startsWith("anti-slop-effect/"));
  for (const fixture of nativeEffectQualityFixtures) {
    if (findings.some(({ path }) => path === `${fixture.rule}-safe.mjs`))
      throw new TypeError("native-effect-safe-fixture-rejected");
    if (
      !findings.some(
        ({ path, rule }) =>
          path === `${fixture.rule}-bad.mjs` && rule === `anti-slop-effect/${fixture.rule}`,
      )
    )
      throw new TypeError("native-effect-rejected-fixture-accepted");
  }
}

export function qualifyNativeEffectFixtures(
  moduleRoot,
  nodeExecutable = process.execPath,
  execution = runNativeHostQualityProcess,
) {
  runnerIdentity();
  const root = mkdtempSync(join(tmpdir(), "keiko-native-effect-quality-"));
  try {
    symlinkSync(moduleRoot, join(root, "node_modules"), "junction");
    const files = writeFixtures(root);
    const result = runNativePolicy(root, files);
    assertNativeEffectFixtureDiagnostics(result);
    executeFixtures(root, nodeExecutable, execution);
    writeFileSync(join(root, "malformed.mjs"), "export const broken = (");
    let refused = false;
    try {
      runNativePolicy(root, [{ path: "malformed.mjs" }]);
    } catch (error) {
      // Syntax failures must not produce a visited/qualified fixture receipt.
      if (!(error instanceof TypeError) || error.message !== "unknown-diagnostic") throw error;
      refused = true;
    }
    if (!refused) throw new TypeError("native-effect-malformed-fixture-accepted");
    return {
      rules: nativeEffectQualityFixtures.length,
      visited: result.visited,
      malformedRefused: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function executeFixtures(root, nodeExecutable, execution) {
  for (const fixture of nativeEffectQualityFixtures) {
    for (const category of ["safe", "bad"]) {
      const path = `${fixture.rule}-${category}.mjs`;
      const moduleSpecifier = JSON.stringify("./" + path);
      const output = execution(
        nodeExecutable,
        [
          "--input-type=module",
          "-e",
          `const m = await import(${moduleSpecifier}); console.log(JSON.stringify(await m.qualify()));`,
        ],
        { cwd: root, timeout: 30_000 },
      );
      if (!isDeepStrictEqual(JSON.parse(output), fixture.expected))
        throw new TypeError("native-effect-fixture-execution-mismatch");
    }
  }
}

const defaultHostQualification = {
  target: nativeHostQualityTarget,
  install: installLockedHost,
  stage: stageCodingRuntimeNpmServiceHost,
  fixtures: qualifyNativeEffectFixtures,
  execute: runNativeHostQualityProcess,
};

export async function checkNativeHostCodeQuality(qualification = defaultHostQualification) {
  const target = qualification.target();
  const approvals = loadPortableRuntimeApprovals(repoRoot);
  const contract = await import("../packages/keiko-contracts/dist/opencode-service-host.js");
  if (approvals.node.version !== contract.OPENCODE_SERVICE_HOST_FIXED_FACTS.nodeVersion)
    throw new TypeError("native-host-node-approval-version-mismatch");
  const archive = approvals.node.archives[target];
  const temporary = mkdtempSync(join(tmpdir(), "keiko-native-host-quality-"));
  try {
    qualification.install();
    const staged = await qualification.stage({
      target,
      outDir: join(temporary, "staged"),
      node: {
        nodeArchiveUrl: archive.url,
        nodeSha256: archive.sha256,
        nodeCacheDir: join(temporary, "node-cache"),
      },
    });
    const nodeExecutable = join(
      staged.root,
      contract.OPENCODE_SERVICE_HOST_FIXED_FACTS.nodeExecutablePath,
    );
    const moduleRoot = join(staged.root, "node_modules");
    const fixtures = qualification.fixtures(moduleRoot, nodeExecutable);
    const output = qualification.execute(
      nodeExecutable,
      [
        "--test",
        ...["entry", "host", "guard-seams"].map(
          (name) => `native/opencode-service-host/${name}.test.mjs`,
        ),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, KEIKO_TEST_QUALIFIED_HOST_MODULE_ROOT: moduleRoot },
      },
    );
    process.stdout.write(output);
    return { outcome: "passed", qualification: staged.qualification, target, ...fixtures };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await checkNativeHostCodeQuality()));
  } catch {
    console.error("FAIL native-host-code-quality: qualification refused");
    process.exitCode = 1;
  }
}
