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
import { encodeCodingAppSessionPairingFragment } from "../../packages/keiko-contracts/dist/coding-app-session.js";
import { toolCallingConfigurationFingerprint } from "../../packages/keiko-model-gateway/dist/index.js";
import { mintLauncherPairingAttestation } from "../../packages/keiko-server/dist/index.js";
import {
  installIntoWithYarn,
  persistentVendorSeedDir,
  seedThenPack,
  seedVendoredRegistry,
} from "../installable-package-smoke.mjs";
import {
  CUSTOMER_SHAPE_API_KEY,
  CUSTOMER_SHAPE_MODEL,
  CUSTOMER_SHAPE_REPLY,
  startCustomerShapeLiteLlmTwin,
} from "../lib/customer-shape-litellm-twin.mjs";
import {
  completedTurnEvidence,
  completedToolRoundTripEvidence,
  customerShapeRequestEvidence,
  linkedFailureEvidence,
} from "../lib/customer-shape-evidence.mjs";

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
    KEIKO_DEFAULT_API_KEY: CUSTOMER_SHAPE_API_KEY,
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

function assertAnalyzableFailure(project, stateDir, lines, runId) {
  // OpenCode may publish its terminal failure first. In that ordering the gateway's additional
  // turn event is suppressed; the closed publication reason explains that outcome. The browser
  // assertion above separately proves that the failure itself reached the Workbench.
  const evidence = linkedFailureEvidence(lines, runId);
  if (evidence === undefined) throw new Error("failed turn lacks linked installed-build evidence");
  const { turnFailure, diagnostic } = evidence;
  const bin = join(project, "node_modules", "@oscharko-dev", "keiko", "dist", "cli", "index.js");
  const bundle = join(project, `failure-support-${randomBytes(8).toString("hex")}.jsonl`);
  run(process.execPath, [bin, "support", "export", "--state-dir", stateDir, "--out", bundle], {
    cwd: project,
  });
  const analyzed = run(
    process.execPath,
    [bin, "support", "analyze", bundle, "--correlation-id", diagnostic.correlationId, "--json"],
    { cwd: project },
  );
  const report = JSON.parse(analyzed);
  if (!JSON.stringify(report.lines).includes('"server.diagnostic.failure"')) {
    throw new Error("support analyze omitted the failed turn's correlated diagnostic");
  }
  const analyzedRun = run(
    process.execPath,
    [bin, "support", "analyze", bundle, "--correlation-id", turnFailure.correlationId, "--json"],
    { cwd: project },
  );
  if (
    !JSON.stringify(JSON.parse(analyzedRun).lines).includes('"coding-sidecar.gateway.turn-failed"')
  ) {
    throw new Error("support analyze omitted the run's turn failure projection");
  }
}

async function awaitProjectedTurnFailure(stateDir, runId) {
  try {
    await expect
      .poll(
        () =>
          activityLines(stateDir).some(
            (line) =>
              line.op === "coding-sidecar.gateway.turn-failed" &&
              line.runId === runId &&
              typeof line.published === "boolean",
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  } catch {
    const lines = activityLines(stateDir);
    const failures = lines.filter((line) => line.op === "coding-sidecar.gateway.turn-failed");
    const diagnostics = lines.filter((line) => line.op === "server.diagnostic.failure");
    const starts = lines.filter((line) => line.op === "coding-runtime.run.started");
    const settlements = lines.filter((line) => line.op === "coding-runtime.run.settled");
    throw new Error(
      `turn-failure projection missing: recorded=${failures.length}, ` +
        `published=${failures.filter((line) => line.published === true).length}, ` +
        `diagnostics=${diagnostics.length}, starts=${starts.length}, settlements=${settlements.length}`,
    );
  }
}

async function awaitSettledUsage(stateDir, runId) {
  await expect
    .poll(() => completedTurnEvidence(activityLines(stateDir), runId), { timeout: 10_000 })
    .toBe(true);
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

async function startedRunId(responsePromise) {
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`coding run start failed (HTTP ${response.status()})`);
  const startedRun = await response.json();
  if (typeof startedRun?.runId !== "string" || startedRun.runId.length === 0) {
    throw new Error("coding run start omitted the run id");
  }
  return startedRun.runId;
}

async function runTurn(page, repository, scpRepository, pairingSecret, phase) {
  const expectFailure = phase === "failure-proof" || phase === "truncation-proof";
  const expectToolCall = phase === "tool-proof";
  await pairWorkbench(page, repository, pairingSecret);
  const scpBound = await page.request.post("/api/task-workspaces", {
    headers: CSRF,
    data: {
      root: scpRepository,
      taskId: `scp-origin-${phase}`,
      baseBranch: "main",
      requestedBy: "customer-shape-lane",
    },
  });
  if (!scpBound.ok()) throw new Error(`scp-like origin binding failed (HTTP ${scpBound.status()})`);
  await provision(page, repository, `customer-shape-${phase}`);
  await selectAskForApproval(page);
  await page
    .getByLabel("Task instructions")
    .fill(
      expectToolCall
        ? "Discover README.md in this repository, then briefly confirm the Workbench is ready."
        : "Reply briefly to confirm that the Workbench is ready.",
    );
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/coding-workbench/runtime/runs"),
  );
  await page.getByRole("button", { name: "Start coding run", exact: true }).click();
  const runId = await startedRunId(started);
  if (expectFailure) {
    const failure =
      phase === "truncation-proof"
        ? /The model response stream stopped before the turn completed/u
        : /The model provider rejected this turn/u;
    await expect(page.getByText(failure).first()).toBeVisible({ timeout: 45_000 });
  } else {
    await expect(page.getByText(CUSTOMER_SHAPE_REPLY, { exact: true })).toBeVisible({
      timeout: TURN_TIMEOUT_MS,
    });
  }
  return runId;
}

function assertGatewayEvidence(twin, firstRequest, lines, runId, phase) {
  const operations = new Set(lines.map((line) => line.op));
  for (const required of [
    "coding-sidecar.gateway.request-validated",
    "chat.request.compatibility-retry",
  ]) {
    if (!operations.has(required)) throw new Error(`missing Activity Log operation ${required}`);
  }
  const requestEvidence = customerShapeRequestEvidence(twin.requests, firstRequest);
  if (!requestEvidence.rejectedOptionalField) {
    throw new Error("twin did not reject the optional streaming field");
  }
  if (!requestEvidence.compatibleRetry) {
    throw new Error("twin did not receive a compatible streaming retry");
  }
  if (phase === "truncation-proof") {
    assertTruncatedStream(twin, firstRequest);
    return;
  }
  if (phase === "failure-proof") return;
  if (phase === "qualification" && !requestEvidence.delayedAcceptedStream) {
    throw new Error("twin did not delay the accepted streaming request");
  }
  const usage = lines.find(
    (line) =>
      line.op === "coding-sidecar.gateway.usage-settled" &&
      ["streamed-byte-estimate", "output-byte-estimate"].includes(line.source) &&
      Number.isInteger(line.completionTokens) &&
      line.completionTokens > 0 &&
      line.parentCorrelationId === runId,
  );
  if (usage === undefined) throw new Error("answered turn lacks estimated usage evidence");
}

function assertTruncatedStream(twin, firstRequest) {
  if (!twin.requests.slice(firstRequest).some((request) => request.truncated === true)) {
    throw new Error("twin did not close the accepted stream without a terminal frame");
  }
}

function assertToolRoundTrip(twin, firstRequest) {
  if (!completedToolRoundTripEvidence(twin.requests, firstRequest)) {
    throw new Error("the governed discovery did not complete after its emitted tool call");
  }
}

async function qualifyInstalled(
  project,
  stateDir,
  configPath,
  twin,
  repository,
  scpRepository,
  phase = "qualification",
) {
  const expectFailure = phase === "failure-proof" || phase === "truncation-proof";
  const expectToolCall = phase === "tool-proof";
  const port = await reservePort();
  const pairingSecret = randomBytes(32).toString("hex");
  const cli = lifecycle(project, stateDir, port, configPath, pairingSecret);
  const firstRequest = twin.requests.length;
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
    const runId = await runTurn(page, repository, scpRepository, pairingSecret, phase);
    if (expectFailure) await awaitProjectedTurnFailure(stateDir, runId);
    else await awaitSettledUsage(stateDir, runId);
    const lines = activityLines(stateDir);
    assertGatewayEvidence(twin, firstRequest, lines, runId, phase);
    if (expectToolCall) assertToolRoundTrip(twin, firstRequest);
    if (expectFailure) assertAnalyzableFailure(project, stateDir, lines, runId);
  } finally {
    await browser?.close();
    if (started) cli("stop");
  }
}

async function qualifyGovernedReadTool(project, configPath, twin, repository, scpRepository) {
  const stateDir = mkdtempSync(join(homedir(), ".keiko-customer-shape-tool-state-"));
  try {
    twin.planSingleWorkspaceDiscovery();
    await qualifyInstalled(
      project,
      stateDir,
      configPath,
      twin,
      repository,
      scpRepository,
      "tool-proof",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function qualifyFailureScenario(
  project,
  configPath,
  twin,
  repository,
  scpRepository,
  phase,
  configureTwin,
) {
  const stateDir = mkdtempSync(join(homedir(), `.keiko-customer-shape-${phase}-state-`));
  try {
    configureTwin();
    await qualifyInstalled(project, stateDir, configPath, twin, repository, scpRepository, phase);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function reportQualification(start) {
  process.stdout.write(
    `customer-shape qualification ok: staged Yarn install, local LiteLLM twin, visible Workbench reply, governed read-tool round trip, truncated stream rejection, typed failure, body-free Activity Log (${Math.round(performance.now() - start)}ms).\n`,
  );
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
    twin.delayAcceptedStreamingBy(35_000);
    await qualifyInstalled(project, stateDir, configPath, twin, repository, scpRepository);
    twin.delayAcceptedStreamingBy(0);
    await qualifyGovernedReadTool(project, configPath, twin, repository, scpRepository);
    await qualifyFailureScenario(
      project,
      configPath,
      twin,
      repository,
      scpRepository,
      "truncation-proof",
      () => twin.truncateNextAcceptedStream(),
    );
    await qualifyFailureScenario(
      project,
      configPath,
      twin,
      repository,
      scpRepository,
      "failure-proof",
      () => twin.rejectAllStreaming(),
    );
    reportQualification(start);
  } finally {
    await twin.close();
    artifact?.cleanup();
    rmSync(project, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

await main();
