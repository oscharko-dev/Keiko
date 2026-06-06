// Installable-package smoke (Issue #169 D2, AC2). Packs the root, installs the tarball into a
// fresh tmpdir, and asserts that (a) every bundleDependencies workspace ships under
// node_modules/@oscharko-dev/keiko/node_modules/@oscharko-dev/keiko-<name>/dist/, (b) the CLI bin
// is executable end-to-end (`--version`, `--help`), (c) the SDK root export resolves with the
// bundle in place, and (d) the packaged UI static export resolves through `keiko ui`. This is the
// runtime mirror of `scripts/check-package-surface.mjs`'s static tarball assertions, intended to
// fire BEFORE publish so a broken bundle can never reach users.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_INSTALL_TIMEOUT_MS = 90_000;
const UI_HEALTH_TIMEOUT_MS = 30_000;
const UI_HEALTH_POLL_INTERVAL_MS = 250;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const rootVersion = rootPackageJson.version;
const bundled = rootPackageJson.bundleDependencies ?? [];

function fail(message) {
  console.error(`installable-smoke failed: ${message}`);
  process.exit(1);
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error) {
    fail(`${cmd} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolvePromise) => globalThis.setTimeout(resolvePromise, ms));
}

function packRoot() {
  const result = run("npm", ["pack", "--silent"], { cwd: repoRoot });
  if (result.status !== 0) {
    fail(`npm pack exited ${String(result.status)}: ${result.stderr}`);
  }
  const tarballName = `oscharko-dev-keiko-${rootVersion}.tgz`;
  const tarballPath = join(repoRoot, tarballName);
  if (!existsSync(tarballPath)) {
    fail(`expected tarball at ${tarballPath} after npm pack`);
  }
  return tarballPath;
}

function installInto(tmp, tarballPath) {
  const initResult = run("npm", ["init", "-y"], { cwd: tmp });
  if (initResult.status !== 0) {
    fail(`npm init -y exited ${String(initResult.status)}: ${initResult.stderr}`);
  }
  // `--ignore-scripts` matches the conservative posture the gate models for consumer installs:
  // a future bundled package that acquires a `postinstall` hook would otherwise execute it on
  // every CI build and developer machine before review (issue #169 security-triage finding L1).
  const installResult = run(
    "npm",
    ["install", tarballPath, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional"],
    { cwd: tmp, timeout: NPM_INSTALL_TIMEOUT_MS },
  );
  if (installResult.status !== 0) {
    fail(
      `npm install of tarball exited ${String(installResult.status)} ` +
        `(signal=${String(installResult.signal)}): ${installResult.stderr}`,
    );
  }
}

function assertCliExecutable(tmp) {
  const cliEntry = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  if (!existsSync(cliEntry)) {
    fail(`installed tarball missing CLI entry at ${cliEntry}`);
  }
  const mode = statSync(cliEntry).mode;
  if ((mode & 0o111) === 0) {
    fail(`installed CLI entry ${cliEntry} is not executable (mode ${mode.toString(8)})`);
  }
}

function assertBundledPayload(tmp) {
  const bundleRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko", "node_modules");
  for (const name of bundled) {
    const shortName = name.replace(/^@oscharko-dev\//, "");
    const dist = join(bundleRoot, "@oscharko-dev", shortName, "dist");
    if (!existsSync(dist)) {
      fail(`bundleDependencies payload missing: ${dist}`);
    }
    const entries = readdirSync(dist);
    if (entries.length === 0) {
      fail(`bundleDependencies payload empty: ${dist}`);
    }
  }
}

function assertCliVersionAndHelp(tmp) {
  // Resolve the installed CLI entry directly rather than the `node_modules/.bin/keiko` symlink so
  // the gate does not depend on npm's per-platform `.bin` shim shape (Copilot review on #169).
  const bin = join(tmp, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  const versionResult = run("node", [bin, "--version"], { cwd: tmp });
  if (versionResult.status !== 0) {
    fail(`keiko --version exited ${String(versionResult.status)}: ${versionResult.stderr}`);
  }
  if (!versionResult.stdout.includes(rootVersion)) {
    fail(`keiko --version stdout did not include ${rootVersion}: ${versionResult.stdout}`);
  }
  const helpResult = run("node", [bin, "--help"], { cwd: tmp });
  if (helpResult.status !== 0) {
    fail(`keiko --help exited ${String(helpResult.status)}: ${helpResult.stderr}`);
  }
}

// `runVerification` is the SDK sentinel mirrored from `scripts/check-package-surface.mjs`:
// the static surface check asserts the same symbol resolves as a function, so the runtime
// smoke would otherwise be weaker than the static gate (issue #169 verifier finding gap 1).
const SDK_SENTINEL_TOKEN = "runVerification";

function assertSdkRootImport(tmp) {
  const sdkProbe =
    "import('@oscharko-dev/keiko').then(m => { " +
    "if (typeof m !== 'object' || m === null) process.exit(2); " +
    "const keys = Object.keys(m); " +
    "if (keys.length === 0) process.exit(3); " +
    `if (typeof m["${SDK_SENTINEL_TOKEN}"] !== 'function') process.exit(4); ` +
    "console.log(String(keys.length)); " +
    "});";
  const result = run("node", ["-e", sdkProbe], { cwd: tmp });
  if (result.status !== 0) {
    fail(`SDK root import exited ${String(result.status)}: ${result.stderr}`);
  }
}

async function reserveUiPort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not reserve a loopback TCP port for keiko ui"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

async function waitForHealth(baseUrl, child, stdoutChunks, stderrChunks) {
  const deadline = Date.now() + UI_HEALTH_TIMEOUT_MS;
  let lastError = "health endpoint did not respond";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(
        `keiko ui exited ${String(child.exitCode)} before /api/health was reachable.\n` +
          `stdout:\n${stdoutChunks.join("")}\n` +
          `stderr:\n${stderrChunks.join("")}`,
      );
    }
    try {
      const res = await globalThis.fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = `/api/health returned ${String(res.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(UI_HEALTH_POLL_INTERVAL_MS);
  }
  fail(
    `keiko ui did not become healthy within ${String(UI_HEALTH_TIMEOUT_MS)}ms: ${lastError}\n` +
      `stdout:\n${stdoutChunks.join("")}\n` +
      `stderr:\n${stderrChunks.join("")}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise())),
    sleep(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

async function assertPackagedUi(tmp) {
  const packageRoot = join(tmp, "node_modules", "@oscharko-dev", "keiko");
  const staticRoot = join(packageRoot, "dist", "ui", "static");
  const hashesFile = join(packageRoot, "dist", "ui", "csp-hashes.json");
  if (!existsSync(staticRoot)) {
    fail(`installed tarball missing packaged UI static root at ${staticRoot}`);
  }
  if (readdirSync(staticRoot).length === 0) {
    fail(`installed packaged UI static root is empty: ${staticRoot}`);
  }
  if (!existsSync(hashesFile)) {
    fail(`installed tarball missing packaged UI CSP hashes at ${hashesFile}`);
  }
  const bin = join(packageRoot, "dist", "cli", "index.js");
  const port = await reserveUiPort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn("node", [bin, "ui", "--port", String(port)], {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr?.on("data", (chunk) => stderrChunks.push(String(chunk)));
  try {
    await waitForHealth(baseUrl, child, stdoutChunks, stderrChunks);
    const home = await globalThis.fetch(`${baseUrl}/`);
    if (!home.ok) {
      fail(`keiko ui GET / exited with HTTP ${String(home.status)}`);
    }
    const html = await home.text();
    if (!html.includes("Keiko")) {
      fail("keiko ui home page did not contain the Keiko shell marker");
    }
  } finally {
    await stopChild(child);
  }
}

async function main() {
  const tarballPath = packRoot();
  const tmp = mkdtempSync(join(tmpdir(), "keiko-install-smoke-"));
  try {
    installInto(tmp, tarballPath);
    assertCliExecutable(tmp);
    assertBundledPayload(tmp);
    assertCliVersionAndHelp(tmp);
    assertSdkRootImport(tmp);
    await assertPackagedUi(tmp);
    console.log(
      `installable-smoke ok: tarball installed, ${String(bundled.length)} bundled packages present, CLI + SDK + UI reachable.`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
}

void main();
