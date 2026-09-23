// Release-only proof of the staged package on the field customer's install and gateway shape.
// The browser, BFF, sidecar, and model gateway are real; only the model endpoint is a local twin.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, expect } from "@playwright/test";
import { encodeCodingAppSessionPairingFragment } from "../packages/keiko-contracts/dist/coding-app-session.js";
import { toolCallingConfigurationFingerprint } from "../packages/keiko-model-gateway/dist/index.js";
import { mintLauncherPairingAttestation } from "../packages/keiko-server/dist/index.js";
import {
  installIntoWithYarn,
  persistentVendorSeedDir,
  seedThenPack,
  seedVendoredRegistry,
} from "./installable-package-smoke.mjs";
import {
  CUSTOMER_SHAPE_MODEL,
  CUSTOMER_SHAPE_REPLY,
  startCustomerShapeLiteLlmTwin,
} from "./lib/customer-shape-litellm-twin.mjs";

const CSRF = { "X-Keiko-CSRF": "1" };
const TURN_TIMEOUT_MS = 120_000;

function run(command, args, options) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("port reservation failed");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function createRepository(root, remote) {
  mkdirSync(root, { recursive: true });
  run("git", ["init", "-b", "main", root]);
  writeFileSync(join(root, "README.md"), "Synthetic release qualification repository.\n");
  run("git", ["add", "README.md"], { cwd: root });
  run(
    "git",
    [
      "-c",
      "user.name=Keiko Qualification",
      "-c",
      "user.email=qualify@example.invalid",
      "commit",
      "-m",
      "Initial synthetic fixture",
    ],
    { cwd: root },
  );
  run("git", ["remote", "add", "origin", remote], { cwd: root });
}

function writeGatewayConfig(path, baseUrl) {
  const provider = {
    modelId: CUSTOMER_SHAPE_MODEL,
    baseUrl,
    apiKeyHeaderName: "x-litellm-key",
    timeoutMs: 30_000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    apiKeySecretRef: `cred:${CUSTOMER_SHAPE_MODEL}`,
  };
  const config = {
    schemaVersion: 2,
    providers: [provider],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
    capabilities: [
      {
        id: CUSTOMER_SHAPE_MODEL,
        kind: "chat",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
        toolCalling: true,
        toolCallingVerification: {
          status: "verified",
          checkedAt: new Date().toISOString(),
          probe: "gateway-tool-calling-v1",
          configurationFingerprint: toolCallingConfigurationFingerprint(provider),
        },
        structuredOutput: true,
        streaming: true,
        supportsImageInput: false,
        supportsDocumentInput: false,
        workflowEligible: true,
        costClass: "low",
        latencyClass: "standard",
        throughputHint: "synthetic",
        preferredUseCases: ["Coding"],
        knownLimitations: [],
      },
    ],
  };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function lifecycle(project, stateDir, port, configPath, pairingSecret) {
  const bin = join(project, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  const args = ["--host", "127.0.0.1", "--port", String(port), "--state-dir", stateDir];
  const env = {
    ...process.env,
    KEIKO_CONFIG_FILE: configPath,
    KEIKO_DEFAULT_API_KEY: "synthetic-local-key",
    KEIKO_CODING_APP_SESSION_LAUNCHER_SECRET: pairingSecret,
    KEIKO_CODING_DEPLOYMENT_CEILING: "autonomous-delivery",
  };
  return (action) => run(process.execPath, [bin, action, ...args], { cwd: project, env });
}

function activityLines(stateDir) {
  const logs = join(stateDir, "logs");
  return readdirSync(logs)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(logs, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function pairWorkbench(page, repository, pairingSecret) {
  await page.addInitScript((root) => {
    globalThis.localStorage.setItem(
      "keiko.workspace.v4",
      JSON.stringify([
        {
          id: "qualification-workbench",
          type: "coding",
          x: 40,
          y: 48,
          w: 1120,
          h: 900,
          z: 10,
          zoom: 1,
          cfg: { repositoryPath: root },
          max: false,
        },
      ]),
    );
  }, repository);
  const fragment = encodeCodingAppSessionPairingFragment(
    mintLauncherPairingAttestation({
      secret: pairingSecret,
      requestId: `qualification-${randomBytes(8).toString("hex")}`,
      issuedAtMs: Date.now(),
    }),
  );
  await page.goto(`/${fragment}`);
  await expect(page.locator('section[aria-label="Coding Workbench"][data-state]')).toBeVisible();
}

async function provision(page, repository, taskId) {
  const created = await page.request.post("/api/task-workspaces", {
    headers: CSRF,
    data: { root: repository, taskId, baseBranch: "main", requestedBy: "customer-shape-lane" },
  });
  if (!created.ok()) throw new Error(`workspace provisioning failed (HTTP ${created.status()})`);
  const { instance } = await created.json();
  const reconciled = await page.request.post("/api/task-workspaces/reconciliation", {
    headers: CSRF,
    data: { requestedBy: "customer-shape-lane" },
  });
  if (!reconciled.ok())
    throw new Error(`workspace reconciliation failed (HTTP ${reconciled.status()})`);
  const active = await page.request.post("/api/task-workspaces/active", {
    headers: CSRF,
    data: {
      workspaceId: instance.workspaceId,
      requestedBy: "customer-shape-lane",
      acquireLock: false,
    },
  });
  if (!active.ok()) throw new Error(`workspace activation failed (HTTP ${active.status()})`);
  await page.reload();
}

async function selectAskForApproval(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("region", { name: /^Settings/u })
    .getByRole("button", { name: "Security" })
    .click();
  const mode = page.getByRole("radio", { name: /Ask for approval/u });
  await mode.click();
  await expect(mode).toBeChecked();
  await page.getByRole("button", { name: "Close Settings window", exact: true }).click();
}

async function runTurn(page, repository, scpRepository, pairingSecret) {
  await pairWorkbench(page, repository, pairingSecret);
  const scpBound = await page.request.post("/api/task-workspaces", {
    headers: CSRF,
    data: {
      root: scpRepository,
      taskId: "scp-origin-qualification",
      baseBranch: "main",
      requestedBy: "customer-shape-lane",
    },
  });
  if (!scpBound.ok()) throw new Error(`scp-like origin binding failed (HTTP ${scpBound.status()})`);
  await provision(page, repository, "customer-shape-qualification");
  await selectAskForApproval(page);
  await page
    .getByLabel("Task instructions")
    .fill("Reply briefly to confirm that the Workbench is ready.");
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  const startResponse = await started;
  if (!startResponse.ok())
    throw new Error(`coding run start failed (HTTP ${startResponse.status()})`);
  await expect(page.getByText(CUSTOMER_SHAPE_REPLY, { exact: true })).toBeVisible({
    timeout: TURN_TIMEOUT_MS,
  });
}

async function qualifyInstalled(project, stateDir, configPath, twin, repository, scpRepository) {
  const port = await reservePort();
  const pairingSecret = randomBytes(32).toString("hex");
  const cli = lifecycle(project, stateDir, port, configPath, pairingSecret);
  let started = false;
  let browser;
  try {
    cli("start");
    started = true;
    const health = await globalThis.fetch(`http://127.0.0.1:${String(port)}/api/health`);
    if (!health.ok) throw new Error(`installed UI unhealthy (HTTP ${health.status})`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      baseURL: `http://127.0.0.1:${String(port)}`,
      viewport: { width: 1440, height: 1400 },
    });
    await runTurn(page, repository, scpRepository, pairingSecret);
    const operations = new Set(activityLines(stateDir).map((line) => line.op));
    for (const required of [
      "coding-sidecar.gateway.request-validated",
      "chat.request.compatibility-retry",
    ]) {
      if (!operations.has(required))
        throw new Error(`missing Activity Log operation ${required}`);
    }
    if (!twin.requests.some((request) => request.stream && request.hasStreamOptions)) {
      throw new Error("twin did not reject the optional streaming field");
    }
    if (!twin.requests.some((request) => request.stream && !request.hasStreamOptions)) {
      throw new Error("twin did not receive a compatible streaming retry");
    }
  } finally {
    await browser?.close();
    if (started) cli("stop");
  }
}

async function main() {
  const start = performance.now();
  const project = mkdtempSync(join(tmpdir(), "keiko-customer-shape-yarn-"));
  const stateDir = mkdtempSync(join(homedir(), ".keiko-customer-shape-state-"));
  const twin = await startCustomerShapeLiteLlmTwin();
  let artifact;
  try {
    const configPath = join(project, "gateway.json");
    writeGatewayConfig(configPath, twin.baseUrl);
    const repository = join(project, "synthetic-repository");
    createRepository(repository, "https://code.example.invalid/team/synthetic.git");
    const scpRepository = join(project, "synthetic-scp-repository");
    createRepository(scpRepository, "git@code.example.invalid:team/synthetic.git");
    const vendorTmp = persistentVendorSeedDir();
    // The qualify script runs after an explicit build; stage exactly that built package without
    // invoking the full prepack chain again. Publish still runs prepack independently.
    process.env.KEIKO_SMOKE_PACK_IGNORE_SCRIPTS = "1";
    const seeded = seedThenPack(vendorTmp);
    artifact = seeded.artifact;
    seedVendoredRegistry(vendorTmp, undefined, artifact.manifest, seeded.vendored);
    await installIntoWithYarn(project, artifact, seeded.vendored);
    await qualifyInstalled(project, stateDir, configPath, twin, repository, scpRepository);
    process.stdout.write(
      `customer-shape qualification ok: staged Yarn install, local LiteLLM twin, visible Workbench reply, body-free Activity Log (${Math.round(performance.now() - start)}ms).\n`,
    );
  } finally {
    await twin.close();
    artifact?.cleanup();
    rmSync(project, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

await main();
