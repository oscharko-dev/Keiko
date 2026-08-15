import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";

import {
  PINNED_YARN,
  pinnedYarnLocatorParts,
  yarnLocatorParts,
  yarnPackageManagerFromLocator,
} from "./lib/pinned-yarn.mjs";
import {
  isSmokeGateFailure,
  privateYarnHome,
  provisionPinnedYarnForSetup,
  runAsync,
  SmokeGateFailure,
  withCorepackYarnCacheLock,
  yarnChildEnv,
  YARN_RC_FILENAME,
} from "./installable-package-smoke.mjs";
import rootManifest from "../package.json" with { type: "json" };

const packageSpec =
  process.env.KEIKO_REGISTRY_INSTALL_PACKAGE ?? `${rootManifest.name}@${rootManifest.version}`;
const registry = process.env.KEIKO_REGISTRY_URL ?? "https://registry.npmjs.org/";
const TEST_RUNNER_ENV = "VITEST_WORKER_ID";

function registryYarnLocator() {
  pinnedYarnLocatorParts(PINNED_YARN);
  return PINNED_YARN;
}

function smokeGateYarnLocatorParts(locator) {
  try {
    return yarnLocatorParts(locator);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SmokeGateFailure(`registry install smoke Yarn locator is invalid: ${reason}`);
  }
}

function smokeGateYarnPackageManager(locator) {
  try {
    return yarnPackageManagerFromLocator(locator);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SmokeGateFailure(`registry install smoke Yarn locator is invalid: ${reason}`);
  }
}

function testRegistryYarnLocator(locator) {
  if (process.env.NODE_ENV !== "test" || process.env[TEST_RUNNER_ENV] === undefined) {
    throw new SmokeGateFailure("fixture Yarn locators are only accepted inside Vitest");
  }
  smokeGateYarnLocatorParts(locator);
  return locator;
}
const timeoutMs = parseRegistryInstallTimeoutEnv();

function fail(message) {
  console.error(`registry-install-smoke failed: ${message}`);
  process.exit(1);
}

function parseRegistryInstallTimeoutEnv() {
  const value = process.env.KEIKO_REGISTRY_INSTALL_TIMEOUT_MS;
  if (value === undefined || value === "") return 300_000;
  if (!/^[1-9]\d*$/u.test(value)) {
    fail("KEIKO_REGISTRY_INSTALL_TIMEOUT_MS must be a positive integer number of milliseconds.");
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    fail("KEIKO_REGISTRY_INSTALL_TIMEOUT_MS must be a safe integer number of milliseconds.");
  }
  return parsed;
}

function assertTlsVerificationEnabled() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    fail("NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed for registry install smoke.");
  }
  const url = new URL(registry);
  if (url.protocol === "https:") return;
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (loopback && process.env.KEIKO_REGISTRY_INSTALL_ALLOW_INSECURE_LOOPBACK === "1") {
    console.log(
      "registry-install-smoke: using explicit insecure loopback registry override for local test.",
    );
    return;
  }
  fail(
    "registry install smoke requires an HTTPS registry URL. " +
      "Only loopback HTTP is allowed with KEIKO_REGISTRY_INSTALL_ALLOW_INSECURE_LOOPBACK=1.",
  );
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    ...options,
  });
  assertRunSucceeded(cmd, args, result);
  return result;
}

function commandSummary(cmd, args) {
  return `${cmd} (${String(args.length)} arg${args.length === 1 ? "" : "s"})`;
}

function outputByteSummary(result) {
  const stdoutBytes = Buffer.byteLength(String(result.stdout ?? ""), "utf8");
  const stderrBytes = Buffer.byteLength(String(result.stderr ?? ""), "utf8");
  return `stdoutBytes=${String(stdoutBytes)}, stderrBytes=${String(stderrBytes)}`;
}

function assertRunSucceeded(cmd, args, result) {
  if (result.error !== undefined) {
    fail(`${commandSummary(cmd, args)} could not spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${commandSummary(cmd, args)} exited ${String(result.status)} ` +
        `(signal=${String(result.signal)}, ${outputByteSummary(result)})`,
    );
  }
}

function installedPackageRoot(projectDir) {
  return join(projectDir, "node_modules", "@oscharko-dev", "keiko");
}

function assertVendoredPayload(projectDir) {
  const roots = [
    join(projectDir, "node_modules"),
    join(installedPackageRoot(projectDir), "node_modules"),
  ];
  const runtimeWorkspaces = Array.isArray(rootManifest.bundleDependencies)
    ? rootManifest.bundleDependencies
    : [];
  for (const name of runtimeWorkspaces) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const dist = roots
      .map((root) => join(root, "@oscharko-dev", shortName, "dist"))
      .find((candidate) => existsSync(candidate));
    if (dist === undefined) {
      fail(`registry-installed package missing runtime dependency dist: ${name}`);
    }
    if (readdirSync(dist).length === 0) {
      fail(`registry-installed package has empty runtime dependency dist: ${name}`);
    }
  }
}

async function assertRootImport(projectDir) {
  const moduleUrl = pathToFileURL(join(installedPackageRoot(projectDir), "dist", "index.js")).href;
  const mod = await import(moduleUrl);
  if (mod.SDK_VERSION !== rootManifest.version) {
    fail(
      `registry-installed root import SDK_VERSION mismatch: ${String(mod.SDK_VERSION)} ` +
        `!= ${rootManifest.version}`,
    );
  }
}

async function assertInstalledRuntime(projectDir) {
  const bin = join(installedPackageRoot(projectDir), "dist", "cli", "index.js");
  const result = run(process.execPath, [bin, "--version"], { cwd: projectDir });
  if (!result.stdout.includes(rootManifest.version)) {
    fail(
      `installed CLI version output did not include ${rootManifest.version} ` +
        `(${outputByteSummary(result)})`,
    );
  }
  run(process.execPath, [bin, "--help"], { cwd: projectDir });
  assertVendoredPayload(projectDir);
  await assertRootImport(projectDir);
}

async function npmSmoke() {
  const projectDir = mkdtempSync(join(tmpdir(), "keiko-registry-npm-"));
  try {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
    );
    writeFileSync(
      join(projectDir, ".npmrc"),
      `registry=${registry}\n` +
        `@oscharko-dev:registry=${registry}\n` +
        `cache=${join(projectDir, ".npm-cache")}\n` +
        "strict-ssl=true\n",
    );
    run(
      "npm",
      ["install", packageSpec, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"],
      // SECURITY-SHELL-OK: npm-only Windows .cmd compatibility for install smoke; argv is fixed.
      { cwd: projectDir, shell: process.platform === "win32" },
    );
    await assertInstalledRuntime(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function writeYarnSmokeManifest(projectDir, yarnLocator) {
  const packageManager = smokeGateYarnPackageManager(yarnLocator);
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      {
        private: true,
        packageManager,
        devDependencies: {
          [rootManifest.name]: rootManifest.version,
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function writeYarnSmokeConfiguration(projectDir) {
  writeFileSync(
    join(projectDir, YARN_RC_FILENAME),
    [
      "nodeLinker: node-modules",
      "enableGlobalCache: false",
      "enableStrictSsl: true",
      `cacheFolder: "${join(projectDir, ".yarn-cache").replaceAll("\\", "/")}"`,
      `npmRegistryServer: "${registry}"`,
      "npmScopes:",
      "  oscharko-dev:",
      `    npmRegistryServer: "${registry}"`,
      "",
    ].join("\n"),
  );
}

async function runCorepackYarnInstall(projectDir, yarnHome, yarnLocator, installArgs) {
  return await withCorepackYarnCacheLock(
    yarnLocator,
    async () => {
      await provisionPinnedYarnForSetup(yarnLocator, timeoutMs);
      const env = yarnChildEnv(registry, process.env, yarnHome, yarnLocator);
      return await runAsync("corepack", installArgs, {
        cwd: projectDir,
        env,
        timeout: timeoutMs,
      });
    },
    timeoutMs,
  );
}

async function checkedCorepackYarnInstall(projectDir, yarnHome, yarnLocator) {
  const installArgs = ["yarn", "install", "--no-immutable", "--mode=skip-build"];
  try {
    const result = await runCorepackYarnInstall(projectDir, yarnHome, yarnLocator, installArgs);
    assertRunSucceeded("corepack", installArgs, result);
  } catch (error) {
    if (isSmokeGateFailure(error)) fail(error.message);
    throw error;
  }
}

async function yarnSmoke(yarnLocator) {
  const projectDir = mkdtempSync(join(tmpdir(), "keiko-registry-yarn-"));
  const yarnHome = privateYarnHome();
  try {
    writeYarnSmokeManifest(projectDir, yarnLocator);
    writeYarnSmokeConfiguration(projectDir);
    await checkedCorepackYarnInstall(projectDir, yarnHome, yarnLocator);
    await assertInstalledRuntime(projectDir);
  } finally {
    rmSync(yarnHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
}

async function runRegistryInstallSmokeWithLocator(yarnLocator) {
  assertTlsVerificationEnabled();
  await npmSmoke();
  await yarnSmoke(yarnLocator);

  console.log(`registry-install-smoke: PASS - ${packageSpec} installs from ${registry}.`);
}

export async function runRegistryInstallSmoke() {
  await runRegistryInstallSmokeWithLocator(registryYarnLocator());
}

export async function runRegistryInstallSmokeForTest(yarnLocator) {
  await runRegistryInstallSmokeWithLocator(testRegistryYarnLocator(yarnLocator));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRegistryInstallSmoke();
}
