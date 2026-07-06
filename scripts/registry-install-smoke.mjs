import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, URL } from "node:url";

import rootManifest from "../package.json" with { type: "json" };

const packageSpec =
  process.env.KEIKO_REGISTRY_INSTALL_PACKAGE ?? `${rootManifest.name}@${rootManifest.version}`;
const registry = process.env.KEIKO_REGISTRY_URL ?? "https://registry.npmjs.org/";
const timeoutMs = Number.parseInt(process.env.KEIKO_REGISTRY_INSTALL_TIMEOUT_MS ?? "300000", 10);
const skipYarn = process.env.KEIKO_REGISTRY_INSTALL_SKIP_YARN === "1";
const forceYarn = process.env.KEIKO_REGISTRY_INSTALL_FORCE_YARN === "1";

function fail(message) {
  console.error(`registry-install-smoke failed: ${message}`);
  process.exit(1);
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

function rootPackageSpec() {
  return `${rootManifest.name}@${rootManifest.version}`;
}

function isInternalRuntimeDependency(name) {
  return name.startsWith("@oscharko-dev/keiko-");
}

function hasRootOnlyBundledRuntimeWorkspaces() {
  const dependencies =
    rootManifest.dependencies && typeof rootManifest.dependencies === "object"
      ? Object.keys(rootManifest.dependencies)
      : [];
  const bundled = Array.isArray(rootManifest.bundleDependencies)
    ? new Set(rootManifest.bundleDependencies)
    : new Set();
  const internalDependencies = dependencies.filter(isInternalRuntimeDependency);
  return internalDependencies.length > 0 && internalDependencies.every((name) => bundled.has(name));
}

function yarnSkipReason() {
  if (skipYarn) return "KEIKO_REGISTRY_INSTALL_SKIP_YARN=1";
  if (forceYarn) return undefined;
  if (packageSpec === rootPackageSpec() && hasRootOnlyBundledRuntimeWorkspaces()) {
    return "root-only package bundles private runtime workspaces";
  }
  return undefined;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    ...options,
  });
  if (result.error !== undefined) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${cmd} ${args.join(" ")} exited ${String(result.status)}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`,
    );
  }
  return result;
}

function installedPackageRoot(projectDir) {
  return join(projectDir, "node_modules", "@oscharko-dev", "keiko");
}

function assertBundledPayload(projectDir) {
  const bundleRoot = join(installedPackageRoot(projectDir), "node_modules");
  const bundled = Array.isArray(rootManifest.bundleDependencies)
    ? rootManifest.bundleDependencies
    : [];
  for (const name of bundled) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const dist = join(bundleRoot, "@oscharko-dev", shortName, "dist");
    if (!existsSync(dist)) {
      fail(`registry-installed package missing bundled dependency dist: ${dist}`);
    }
    if (readdirSync(dist).length === 0) {
      fail(`registry-installed package has empty bundled dependency dist: ${dist}`);
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
    fail(`installed CLI version output did not include ${rootManifest.version}: ${result.stdout}`);
  }
  run(process.execPath, [bin, "--help"], { cwd: projectDir });
  assertBundledPayload(projectDir);
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

async function yarnSmoke() {
  const skipReason = yarnSkipReason();
  if (skipReason !== undefined) {
    console.log(`registry-install-smoke: yarn check skipped (${skipReason}).`);
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), "keiko-registry-yarn-"));
  try {
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify(
        {
          private: true,
          packageManager: "yarn@4.9.1",
          devDependencies: {
            [rootManifest.name]: rootManifest.version,
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(projectDir, ".yarnrc.yml"),
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
    run("corepack", ["yarn", "install", "--no-immutable", "--mode=skip-build"], {
      cwd: projectDir,
      env: {
        ...process.env,
        YARN_ENABLE_GLOBAL_CACHE: "false",
        YARN_NPM_REGISTRY_SERVER: registry,
      },
    });
    await assertInstalledRuntime(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

assertTlsVerificationEnabled();
await npmSmoke();
await yarnSmoke();

console.log(`registry-install-smoke: PASS - ${packageSpec} installs from ${registry}.`);
