import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  closeSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hostDevLaneTarget, stageDevCodingRuntime } from "./stage-dev-coding-runtime.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const stateDir = resolve(process.env.KEIKO_STATE_DIR ?? join(repoRoot, ".keiko", "dev"));
const pidFile = join(stateDir, "dev-ui.pid.json");
const logFile = join(stateDir, "dev-ui.log");
const devGatewayConfigFile = join(stateDir, "ui", "keiko.config.json");
const host = "127.0.0.1";
const publicBrowserHost = "localhost";
const explicitPublicPort = process.env.KEIKO_DEV_UI_PORT ?? process.env.KEIKO_UI_PORT;
let publicPort = Number(explicitPublicPort ?? "1983");
const runnerScript = join(repoRoot, "scripts", "dev-runner.mjs");
const devLaneModule = join(
  repoRoot,
  "packages",
  "keiko-server",
  "dist",
  "coding-runtime",
  "devLanePortableCodingRuntime.js",
);
const CODING_RUNTIME_DEV_LANE_ENV = "KEIKO_CODING_RUNTIME_DEV_LANE";
const CODING_RUNTIME_READINESS_PATH =
  "/api/coding-workbench/runtime/readiness?requestedMode=governed-assist";
const RUNNER_STOP_TIMEOUT_MS = 40_000;
const gatewayConfigSeedCandidates = [
  join(repoRoot, ".keiko", "ui", "keiko.config.json"),
  join(repoRoot, "keiko.config.json"),
  join(repoRoot, "sandbox", ".keiko", "ui", "keiko.config.json"),
];

export function npmCommand(platform = process.platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export function shouldShellNpmCommand(command, platform = process.platform) {
  return platform === "win32" && /^(?:npm|npm\.cmd)$/i.test(command);
}

function publicBrowserUrl(port) {
  return `http://${publicBrowserHost}:${String(port)}`;
}

// #2478 (ADR-0141 W1.5): `dev:start` is the trusted launcher of the dev BFF. It provisions a
// process-scoped app-session pairing secret through the runner's inherited environment (never a
// disk file, never a URL), and `npm run dev:start -- --open` opens the browser with one
// single-use pairing attestation in the boot URL fragment so runtime question content is
// readable in the dev lane. An operator-provisioned secret in the environment is respected.
const APP_SESSION_SECRET_ENV = "KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET";
const openBrowserRequested = process.argv.includes("--open");

export function resolveDevPairingSecret(env = process.env) {
  const provisioned = env[APP_SESSION_SECRET_ENV];
  if (typeof provisioned === "string" && provisioned.length >= 32) return provisioned;
  return randomBytes(32).toString("hex");
}

// The claim construction and fragment codec stay single-source in the built workspace packages;
// `dev:start` runs `npm run build` before this executes, so dist/ is present by construction.
export async function pairedDevBrowserUrl(pairingSecret, baseUrl = publicBrowserUrl(publicPort)) {
  const serverModule = await import(
    pathToFileURL(join(repoRoot, "packages", "keiko-server", "dist", "index.js")).href
  );
  const contractsModule = await import(
    pathToFileURL(join(repoRoot, "packages", "keiko-contracts", "dist", "index.js")).href
  );
  const attestation = serverModule.mintLauncherPairingAttestation({
    secret: pairingSecret,
    requestId: `req_dev-${randomUUID()}`,
    issuedAtMs: Date.now(),
  });
  const fragment = contractsModule.encodeCodingAppSessionPairingFragment(attestation);
  return `${baseUrl}/${fragment}`;
}

// `cmd /c start` percent-expands its argument, which corrupts a percent-encoded pairing fragment
// (#2478); on Windows the URL therefore travels only inside a Base64-encoded PowerShell command.
export function resolveExternalOpener(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    const command = `Start-Process '${url.replaceAll("'", "''")}'`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
    };
  }
  return { command: "xdg-open", args: [url] };
}

function openExternal(url) {
  const opener = resolveExternalOpener(url);
  const child = spawn(opener.command, [...opener.args], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function maybeOpenPairedBrowser(pairingSecret, seams = {}) {
  const requested = seams.requested ?? openBrowserRequested;
  const buildUrl = seams.buildUrl ?? pairedDevBrowserUrl;
  const open = seams.open ?? openExternal;
  if (!requested) return;
  try {
    open(await buildUrl(pairingSecret));
    console.log("[dev:start] opened a paired browser window (single-use app-session pairing).");
  } catch (error) {
    console.error(
      `[dev:start] could not open a paired browser window: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function run(command, args, cwd, options = {}) {
  const platform = options.platform ?? process.platform;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  console.log(`[dev:start] ${command} ${args.join(" ")}`);
  // SECURITY-SHELL-OK: npm/npm.cmd dev helper on Windows only; command is selected by npmCommand().
  const result = spawnSyncImpl(command, args, {
    cwd,
    stdio: "inherit",
    shell: shouldShellNpmCommand(command, platform),
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.error !== undefined) {
    throw new Error(`${command} ${args.join(" ")} could not spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const code = result.status === null ? (result.signal ?? "unknown") : result.status;
    throw new Error(`${command} ${args.join(" ")} failed (${String(code)})`);
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(pidFile, "utf8"));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dependenciesNeedInstall() {
  const nodeModules = join(repoRoot, "node_modules");
  const lock = join(repoRoot, "package-lock.json");
  const installedLock = join(nodeModules, ".package-lock.json");
  if (!existsSync(nodeModules) || !existsSync(installedLock)) return true;
  const installed = statSync(installedLock).mtimeMs;
  return (
    statSync(join(repoRoot, "package.json")).mtimeMs > installed ||
    statSync(lock).mtimeMs > installed
  );
}

function ensureDependencies() {
  if (!dependenciesNeedInstall()) {
    console.log("[dev:start] dependencies already installed");
    return;
  }
  run(npmCommand(), ["ci", "--no-audit", "--no-fund"], repoRoot);
}

/**
 * Decide what dev-start should do about the gateway config. Pure, so the decision is unit-tested
 * without touching the filesystem (same pattern as npmCommand/resolveExternalOpener above).
 *
 * KEIKO-0286: skipping the seed whenever KEIKO_CONFIG_FILE is merely SET defeats the safety net
 * exactly when it is needed. Sourcing an operator .env that carries a stale KEIKO_CONFIG_FILE
 * leaves the variable pointing at a file that does not exist; the server then degrades to zero
 * providers with no diagnostic — the "no provisioned config" condition that blocked four prior
 * live-test attempts. A configured path only earns the skip when the file is actually there.
 *
 * Repointing matters as much as seeding: the development runner inherits this process's
 * environment, so a seed written while KEIKO_CONFIG_FILE still names the dead path would be
 * invisible to the server and would reproduce the very condition this exists to prevent.
 *
 * @returns {{ repointTo?: string, seedFrom?: string, notices: string[] }}
 */
export function resolveDevGatewayConfigAction({
  configuredPath,
  devConfigFile,
  seedCandidates,
  fileExists,
}) {
  if (configuredPath !== undefined && fileExists(configuredPath)) return { notices: [] };

  const notices = [];
  const result = {};
  if (configuredPath !== undefined) {
    // Path only, never contents: the file this names holds credential references.
    notices.push(
      `[dev:start] KEIKO_CONFIG_FILE points at ${configuredPath}, which does not exist ` +
        "(a stale value from a sourced operator .env does this); falling back to the local dev " +
        "config so the gateway does not start with zero providers",
    );
    result.repointTo = devConfigFile;
  }
  if (fileExists(devConfigFile)) return { ...result, notices };

  const seedFrom = seedCandidates.find((candidate) => fileExists(candidate));
  if (seedFrom === undefined) {
    // Said unconditionally. Previously only the stale-path branch reported this, so the plain
    // "nothing configured and nothing to seed" case — the most common first-run shape — started an
    // unprovisioned gateway in silence, which is the condition KEIKO-0286 is about (review finding
    // on #3159).
    notices.push(
      "[dev:start] no gateway config is configured and no seed candidate is available — the " +
        "gateway will start unprovisioned; configure a model in Settings or point " +
        "KEIKO_CONFIG_FILE at a real file",
    );
    return { ...result, notices };
  }
  notices.push(`[dev:start] seeded gateway config from ${seedFrom}`);
  return { ...result, seedFrom, notices };
}

// KEIKO-0542: mirror packages/keiko-server/src/credentialVault.ts's on-disk convention when
// seeding a fresh dev config: a `credentials/` subdirectory sits next to the config file so the
// gateway can find the vault it references. When the seed source has one, copy it beside the
// seeded config; when it doesn't, the gateway will still start (unprovisioned) exactly the way
// it did before this fix — and we surface both outcomes as notices so a silent degrade to "not
// configured" no longer looks the same as a successful seed.
function statIsDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function copyDirectoryTree(source, target) {
  // Directory tree copy: recursive, preserve mode, follow no symlinks (a credentials dir is
  // regular files).
  cpSync(source, target, { recursive: true, errorOnExist: false, dereference: false });
}

const DEFAULT_ENSURE_DEV_GATEWAY_CONFIG_SEAMS = {
  fileExists: existsSync,
  directoryExists: statIsDirectory,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  copyFile: copyFileSync,
  copyDirectory: copyDirectoryTree,
  chmod: chmodSync,
  notify: (message) => console.log(message),
  env: process.env,
};

function seedGatewayCredentials(seams, seedFrom, notices) {
  const seedCredentialsDir = join(dirname(seedFrom), "credentials");
  const destinationCredentialsDir = join(dirname(devGatewayConfigFile), "credentials");
  if (seams.directoryExists(seedCredentialsDir)) {
    seams.copyDirectory(seedCredentialsDir, destinationCredentialsDir);
    notices.push(
      `[dev:start] seeded credentials/ from ${seedCredentialsDir} (${destinationCredentialsDir})`,
    );
    return;
  }
  notices.push(
    `[dev:start] no credentials/ subdirectory next to ${seedFrom} — the gateway will start ` +
      "with the seeded config but no vault; add a credentials/ directory beside the seed " +
      "or configure a model in Settings",
  );
}

export function ensureDevGatewayConfig(seams = DEFAULT_ENSURE_DEV_GATEWAY_CONFIG_SEAMS) {
  const { repointTo, seedFrom, notices } = resolveDevGatewayConfigAction({
    configuredPath: seams.env.KEIKO_CONFIG_FILE,
    devConfigFile: devGatewayConfigFile,
    seedCandidates: gatewayConfigSeedCandidates,
    fileExists: seams.fileExists,
  });
  if (repointTo !== undefined) seams.env.KEIKO_CONFIG_FILE = repointTo;
  if (seedFrom !== undefined) {
    seams.mkdir(dirname(devGatewayConfigFile));
    seams.copyFile(seedFrom, devGatewayConfigFile);
    seams.chmod(devGatewayConfigFile, 0o600);
    seedGatewayCredentials(seams, seedFrom, notices);
  }
  for (const notice of notices) seams.notify(notice);
}

function checkPortAvailable(port) {
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => resolveAvailable(false));
    server.listen(port, host, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

async function findAvailablePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await checkPortAvailable(port)) return port;
  }
  throw new Error(`No free loopback port found at or above ${String(start)}`);
}

async function fetchOk(url, validate = async () => true) {
  const response = await globalThis.fetch(url, { cache: "no-store" });
  if (!response.ok) return `HTTP ${String(response.status)}`;
  return (await validate(response)) ? "ok" : "unexpected response";
}

export async function codingRuntimeHealth(baseUrl, fetchFn = globalThis.fetch) {
  const response = await fetchFn(`${baseUrl}${CODING_RUNTIME_READINESS_PATH}`, {
    cache: "no-store",
  });
  if (!response.ok) return `HTTP ${String(response.status)}`;
  const body = await response.json();
  // The launcher's success line must not imply platform qualification either (ADR-0163 D9). An
  // available runtime always declares how strong its evidence is; an absent or weak class reports
  // the honest posture instead of a bare "ok".
  if (body?.runtimeAvailable === true) {
    // The status word stays exactly "ok" because three private gates below compare against that
    // literal — requiredRuntimeHealth, devServerHealth's early return, and waitForHealth's success
    // test. Encoding the honesty signal INTO the word made every macOS `dev:start` skip the
    // remaining checks and then time out against a perfectly healthy server; the detail travels
    // beside the status instead.
    return body?.runtimeEvidenceClass === "platform-qualified"
      ? "ok"
      : "ok · unverified evaluation runtime (no platform signature)";
  }
  const reason =
    typeof body?.runtimeUnavailableReason === "string"
      ? body.runtimeUnavailableReason
      : "invalid-readiness";
  return `unavailable (${reason})`;
}

export function codingRuntimeRequired(platform = process.platform, arch = process.arch) {
  return hostDevLaneTarget(platform, arch) !== undefined;
}

function healthError(name, error) {
  if (error instanceof Error) return `${name}: ${error.message}`;
  return `${name}: ${String(error)}`;
}

// Exported for test: the gate that consumes codingRuntimeHealth. It went untested, which is how an
// honest status string could break every macOS `dev:start` while the suite stayed green.
export async function requiredRuntimeHealth(baseUrl, required = codingRuntimeRequired()) {
  // `required` is a parameter so the gate is assertable on any host: codingRuntimeRequired() is
  // true only where a dev-lane target exists (darwin), so a test that let it default would take
  // the short-circuit on Linux CI and pass without ever reaching the code under test.
  if (!required) return "ok";
  try {
    const runtime = await codingRuntimeHealth(baseUrl);
    // `startsWith`, not equality: an available runtime reports "ok" possibly followed by its
    // honest evidence detail, and only an UNAVAILABLE runtime may fail the gate.
    return runtime.startsWith("ok") ? runtime : `runtime: ${runtime}`;
  } catch (error) {
    return healthError("runtime", error);
  }
}

async function devServerHealth(port) {
  const baseUrl = `http://${host}:${String(port)}`;
  const checks = [
    {
      name: "api",
      url: `${baseUrl}/api/health`,
      validate: async (response) => {
        const body = await response.json();
        return body?.status === "ok";
      },
    },
    {
      name: "ui",
      url: `${baseUrl}/`,
      validate: async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        return contentType.includes("text/html") && body.includes("Keiko");
      },
    },
    {
      // #2906 round 3 (comment 3865329060): the duplicate /assets/keiko-logo.svg copy was
      // dropped in favor of the one committed SVG at the root of public/ — every runtime
      // reference (and this smoke check) now points at it.
      name: "static-asset",
      url: `${baseUrl}/keiko-logo.svg`,
      validate: async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        return contentType.includes("image/svg+xml") && body.includes("<svg");
      },
    },
  ];

  const runtime = await requiredRuntimeHealth(baseUrl);
  if (!runtime.startsWith("ok")) return runtime;
  const runtimeDetail = runtime === "ok" ? "" : runtime.slice("ok".length);

  for (const check of checks) {
    try {
      const result = await fetchOk(check.url, check.validate);
      if (result !== "ok") return `${check.name}: ${result}`;
    } catch (error) {
      return healthError(check.name, error);
    }
  }
  return `ok${runtimeDetail}`;
}

async function stopUnhealthyRunner(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + RUNNER_STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    await sleep(500);
    if (!isAlive(pid)) return;
  }
  throw new Error(
    `existing development server did not stop within ${String(
      RUNNER_STOP_TIMEOUT_MS / 1_000,
    )}s; retry with \`npm run dev:stop -- --force\``,
  );
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 60_000;
  let lastError = "not started";
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(`development server exited early; see ${logFile}`);
    }
    lastError = await devServerHealth(port);
    // Same rule as the gate above: the status word is "ok", anything after it is the runtime's
    // honest evidence detail and must never turn a healthy server into a failed start.
    if (lastError.startsWith("ok"))
      return lastError === "ok" ? undefined : lastError.slice(2).trim();
    if (lastError.startsWith("runtime: unavailable")) {
      throw new Error(`coding runtime failed readiness: ${lastError}; see ${logFile}`);
    }
    await sleep(500);
  }
  throw new Error(`development server did not become healthy: ${lastError}; see ${logFile}`);
}

function validatePublicPort() {
  if (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
    console.error(`Invalid KEIKO_DEV_UI_PORT/KEIKO_UI_PORT: ${String(publicPort)}`);
    process.exit(2);
  }
}

async function restartExistingRunnerIfNeeded() {
  const state = readState();
  if (state === undefined || !isAlive(state.runnerPid)) return;

  const runningPort = state.publicPort ?? publicPort;
  const health = await devServerHealth(runningPort);
  if (health === "ok") {
    console.log(
      `Keiko dev UI already running on ${publicBrowserUrl(runningPort)} (pid ${String(
        state.runnerPid,
      )}).`,
    );
    if (openBrowserRequested) {
      // The running BFF's pairing secret is private to its own launch, so no fresh attestation
      // can be minted here (fail closed): re-pairing needs a restart through this launcher.
      console.log(
        "Pairing: the running dev UI keeps its existing app session; run `npm run dev:stop && npm run dev:start -- --open` to pair a fresh browser window.",
      );
    }
    process.exit(0);
  }

  console.log(
    `[dev:start] existing runner ${String(state.runnerPid)} is unhealthy (${health}); restarting.`,
  );
  await stopUnhealthyRunner(state.runnerPid);
}

async function resolveDevPorts() {
  if (!(await checkPortAvailable(publicPort))) {
    if (explicitPublicPort !== undefined) {
      throw new Error(`Port ${host}:${String(publicPort)} is already in use.`);
    }
    const fallbackPort = await findAvailablePort(publicPort + 1);
    console.log(
      `[dev:start] default port ${host}:${String(publicPort)} is busy; using ${host}:${String(
        fallbackPort,
      )}`,
    );
    publicPort = fallbackPort;
  }

  const bffPort = await findAvailablePort(
    Number(process.env.KEIKO_DEV_BFF_PORT ?? String(publicPort + 1)),
  );
  const nextStart = Number(process.env.KEIKO_DEV_NEXT_PORT ?? String(publicPort + 2));
  const nextPort = await findAvailablePort(nextStart === bffPort ? bffPort + 1 : nextStart);
  return { bffPort, nextPort };
}

function spawnDevelopmentRunner(bffPort, nextPort, pairingSecret) {
  mkdirSync(stateDir, { recursive: true });
  // Bounded log growth: append mode grew dev-ui.log without limit across daily
  // dev sessions (webpack/next/tsc-watch output is verbose). Keep exactly one
  // previous generation for post-mortems and start each run on a fresh file.
  try {
    renameSync(logFile, `${logFile}.prev`);
  } catch {
    // First run in this state dir — nothing to rotate.
  }
  const logFd = openSync(logFile, "w", 0o600);
  const child = spawn(process.execPath, [runnerScript], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      KEIKO_DEV_UI_PORT: String(publicPort),
      KEIKO_DEV_BFF_PORT: String(bffPort),
      KEIKO_DEV_NEXT_PORT: String(nextPort),
      KEIKO_DEV_PID_FILE: pidFile,
      KEIKO_STATE_DIR: stateDir,
      [APP_SESSION_SECRET_ENV]: pairingSecret,
    },
  });
  closeSync(logFd);
  child.unref();
  if (child.pid === undefined) throw new Error("failed to spawn development runner");
  return child;
}

async function discoverDevCodingRuntime(input) {
  const module = await import(pathToFileURL(devLaneModule).href);
  return module.discoverDevLaneOpenCode(input);
}

const STAGEABLE_DEV_RUNTIME_REASONS = new Set([
  "payload-missing",
  "payload-unapproved",
  "payload-tampered",
  "secure-read-helper-missing",
  "secure-read-helper-stale",
]);

function devRuntimeDiscoveryReason(discovery) {
  return discovery.outcome === "refused" ? discovery.reason : "inactive";
}

function requireStageableDevRuntime(discovery) {
  if (discovery.outcome === "refused" && STAGEABLE_DEV_RUNTIME_REASONS.has(discovery.reason)) {
    return discovery.reason;
  }
  throw new Error(`coding runtime dev lane refused (${devRuntimeDiscoveryReason(discovery)})`);
}

function requireActivatedDevRuntime(discovery) {
  if (discovery.outcome === "activated") return;
  throw new Error(
    `coding runtime did not activate after staging (${devRuntimeDiscoveryReason(discovery)})`,
  );
}

export async function ensureDevCodingRuntime(seams = {}) {
  const platform = seams.platform ?? process.platform;
  const arch = seams.arch ?? process.arch;
  const target = hostDevLaneTarget(platform, arch);
  if (target === undefined) return false;
  const env = {
    ...(seams.env ?? process.env),
    [CODING_RUNTIME_DEV_LANE_ENV]: "1",
  };
  const discover = seams.discover ?? discoverDevCodingRuntime;
  const stage = seams.stage ?? (() => stageDevCodingRuntime([]));
  let discovery = await discover({ env, platform, arch });
  if (discovery.outcome === "activated") {
    console.log(`[dev:start] verified coding runtime for ${target}`);
    return true;
  }
  const reason = requireStageableDevRuntime(discovery);
  console.log(`[dev:start] coding runtime ${reason}; preparing ${target}`);
  await stage();
  discovery = await discover({ env, platform, arch });
  requireActivatedDevRuntime(discovery);
  console.log(`[dev:start] coding runtime ready for ${target}`);
  return true;
}

function stopSpawnedChild(child) {
  if (child?.pid === undefined || !isAlive(child.pid)) return;
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}

// KEIKO-0719: bound a second `npm run dev:start` against the same repoRoot so it either
// waits for the in-progress instance's build+port-claim to finish or fails fast with a clear
// message that names the first instance's stateDir. Two concurrent invocations otherwise both
// run `npm run build` in the shared repo tree and race to bind the same ports; the loser
// crashes with a stack that never mentions the collision.
const DEV_START_LOCK_FILE = join(stateDir, "dev-start.lock");
const DEV_START_LOCK_WAIT_MS = 60_000;

async function withDevStartLock(work) {
  mkdirSync(stateDir, { recursive: true });
  const started = Date.now();
  let fd;
  for (;;) {
    try {
      // O_EXCL | O_CREAT is atomic across processes on POSIX and NTFS.
      fd = openSync(DEV_START_LOCK_FILE, "wx");
      break;
    } catch (openError) {
      if (openError?.code !== "EEXIST") throw openError;
      if (Date.now() - started > DEV_START_LOCK_WAIT_MS) {
        throw new Error(
          `[dev:start] another dev-start is holding ${DEV_START_LOCK_FILE} — either wait for it ` +
            "or `npm run dev:stop` first (use a distinct KEIKO_STATE_DIR to run in parallel)",
        );
      }
      await sleep(200);
    }
  }
  try {
    return await work();
  } finally {
    closeSync(fd);
    rmSync(DEV_START_LOCK_FILE, { force: true });
  }
}

async function launchDevelopmentRunner() {
  return withDevStartLock(async () => {
    ensureDependencies();
    ensureDevGatewayConfig();
    run(npmCommand(), ["run", "build"], repoRoot);
    await ensureDevCodingRuntime();
    const { bffPort, nextPort } = await resolveDevPorts();
    const pairingSecret = resolveDevPairingSecret();
    const child = spawnDevelopmentRunner(bffPort, nextPort, pairingSecret);

    let runtimeNote;
    try {
      runtimeNote = await waitForHealth(publicPort, child);
    } catch (error) {
      stopSpawnedChild(child);
      throw error;
    }
    // ADR-0163 D9: the launcher's success line must not imply platform qualification. The detail is
    // printed beside the success, never folded into the word the health gates compare against.
    if (runtimeNote !== undefined) console.log(`Coding runtime: ${runtimeNote}`);

    console.log(
      `Keiko dev UI running on ${publicBrowserUrl(publicPort)} (pid ${String(child.pid)}).`,
    );
    console.log(`State: ${stateDir}`);
    console.log(`Logs: ${logFile}`);
    console.log(`Stop: npm run dev:stop`);
    if (!openBrowserRequested) {
      console.log(
        "Pairing: run `npm run dev:start -- --open` to open a browser window paired for coding question content.",
      );
    }
    await maybeOpenPairedBrowser(pairingSecret);
  });
}

export async function main() {
  validatePublicPort();
  await restartExistingRunnerIfNeeded();
  rmSync(pidFile, { force: true });

  try {
    await launchDevelopmentRunner();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === scriptPath) {
  await main();
}
