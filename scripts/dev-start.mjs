import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  closeSync,
  chmodSync,
  copyFileSync,
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
const gatewayConfigSeedCandidates = [
  join(repoRoot, ".keiko", "ui", "keiko.config.json"),
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

function resolveDevPairingSecret() {
  const provisioned = process.env[APP_SESSION_SECRET_ENV];
  if (typeof provisioned === "string" && provisioned.length >= 32) return provisioned;
  return randomBytes(32).toString("hex");
}

// The claim construction and fragment codec stay single-source in the built workspace packages;
// `dev:start` runs `npm run build` before this executes, so dist/ is present by construction.
async function pairedDevBrowserUrl(pairingSecret) {
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
  return `${publicBrowserUrl(publicPort)}/${fragment}`;
}

function openExternal(url) {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function maybeOpenPairedBrowser(pairingSecret) {
  if (!openBrowserRequested) return;
  try {
    openExternal(await pairedDevBrowserUrl(pairingSecret));
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
  if (typeof pid !== "number" || !Number.isInteger(pid)) return false;
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

function ensureDevGatewayConfig() {
  if (process.env.KEIKO_CONFIG_FILE !== undefined || existsSync(devGatewayConfigFile)) {
    return;
  }
  const source = gatewayConfigSeedCandidates.find((candidate) => existsSync(candidate));
  if (source === undefined) {
    return;
  }
  mkdirSync(dirname(devGatewayConfigFile), { recursive: true });
  copyFileSync(source, devGatewayConfigFile);
  chmodSync(devGatewayConfigFile, 0o600);
  console.log(`[dev:start] seeded gateway config from ${source}`);
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
      name: "assets",
      url: `${baseUrl}/assets/keiko-logo.svg`,
      validate: async (response) => {
        const contentType = response.headers.get("content-type") ?? "";
        const body = await response.text();
        return contentType.includes("image/svg+xml") && body.includes("<svg");
      },
    },
  ];

  for (const check of checks) {
    try {
      const result = await fetchOk(check.url, check.validate);
      if (result !== "ok") return `${check.name}: ${result}`;
    } catch (error) {
      return `${check.name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return "ok";
}

async function stopUnhealthyRunner(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (!isAlive(pid)) return;
  }
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 60_000;
  let lastError = "not started";
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(`development server exited early; see ${logFile}`);
    }
    lastError = await devServerHealth(port);
    if (lastError === "ok") return;
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

function stopSpawnedChild(child) {
  if (child?.pid === undefined || !isAlive(child.pid)) return;
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}

async function launchDevelopmentRunner() {
  ensureDependencies();
  ensureDevGatewayConfig();
  run(npmCommand(), ["run", "build"], repoRoot);
  const { bffPort, nextPort } = await resolveDevPorts();
  const pairingSecret = resolveDevPairingSecret();
  const child = spawnDevelopmentRunner(bffPort, nextPort, pairingSecret);

  try {
    await waitForHealth(publicPort, child);
  } catch (error) {
    stopSpawnedChild(child);
    throw error;
  }

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
