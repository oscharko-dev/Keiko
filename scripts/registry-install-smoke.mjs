import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import rootManifest from "../package.json" with { type: "json" };

const packageSpec =
  process.env.KEIKO_REGISTRY_INSTALL_PACKAGE ?? `${rootManifest.name}@${rootManifest.version}`;
const registry = process.env.KEIKO_REGISTRY_URL ?? "https://registry.npmjs.org/";
const timeoutMs = Number.parseInt(process.env.KEIKO_REGISTRY_INSTALL_TIMEOUT_MS ?? "300000", 10);
const skipYarn = process.env.KEIKO_REGISTRY_INSTALL_SKIP_YARN === "1";

function fail(message) {
  console.error(`registry-install-smoke failed: ${message}`);
  process.exit(1);
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

function assertCliVersion(projectDir) {
  const result = run(
    process.execPath,
    [
      join(projectDir, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js"),
      "--version",
    ],
    { cwd: projectDir },
  );
  if (!result.stdout.includes(rootManifest.version)) {
    fail(`installed CLI version output did not include ${rootManifest.version}: ${result.stdout}`);
  }
}

function npmSmoke() {
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
        "strict-ssl=false\n",
    );
    run(
      "npm",
      ["install", packageSpec, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"],
      { cwd: projectDir, shell: process.platform === "win32" },
    );
    assertCliVersion(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function yarnSmoke() {
  if (skipYarn) {
    console.log(
      "registry-install-smoke: yarn check skipped by KEIKO_REGISTRY_INSTALL_SKIP_YARN=1.",
    );
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
        "enableStrictSsl: false",
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
    assertCliVersion(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

npmSmoke();
yarnSmoke();

console.log(`registry-install-smoke: PASS - ${packageSpec} installs from ${registry}.`);
