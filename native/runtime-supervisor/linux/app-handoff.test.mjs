/* Native ownership and cutover regression. This fixture is not an installed-product acceptance. */
import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  readdir,
  realpath,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  appLaunchPacket,
  appResponse,
  commitPacket,
  compileOwnerFixture,
} from "./test-support.app-owner.mjs";
import { streamReader } from "../protocol-harness.mjs";
import { writeExclusivePidFile } from "../../../packages/keiko-cli/dist/state-paths.js";
import {
  createPortableHandoffPlan,
  writePortableHandoffPlan,
} from "../../../packages/keiko-server/dist/update-portable-handoff-plan.js";
import { hashPortableHandoffTree } from "../../../packages/keiko-server/dist/update-portable-handoff-tree.js";
import {
  portableRegistrationDocument,
  posixPortableActivationLayout,
} from "../../../packages/keiko-server/dist/update-portable-activation-files.js";
import { readPortableHandoffReceipts } from "../../../packages/keiko-server/dist/update-portable-handoff-receipts.js";
import {
  primaryLauncher,
  runtimeFor,
} from "../../../packages/keiko-server/dist/update-portable-staging-shared.js";

const { fetch, AbortSignal, performance } = globalThis;
const coalesced = process.argv.includes("--coalesced");
const restoration = process.argv.includes("--restore");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = async (path) => sha(await readFile(path));
const environmentMarker = "native-handoff-fixture-data";
const directory = await realpath(await mkdtemp(join(tmpdir(), "keiko-app-handoff-")));
const target = process.platform === "darwin" ? `macos-${process.arch}` : "linux-x64";
const bundleName = process.platform === "darwin" ? "Keiko.app" : "Keiko";
const resources = (root) =>
  process.platform === "darwin" ? join(root, "Contents/Resources") : root;
const launcherFor = (root) =>
  process.platform === "darwin" ? join(root, "Contents/MacOS/Keiko") : join(root, "Keiko");
const helperFor = (root) => join(resources(root), "runtime/native/keiko-runtime-supervisor");
const stateDir = join(directory, "state");
const managedRoot = join(directory, bundleName);
const rootFixture = fileURLToPath(
  new URL("./test-support.app-handoff-bootstrap.mjs", import.meta.url),
);
const INITIAL_START_TIMEOUT_MS = 15_000;
let initialOwner;
let ownerExited;
let ownerExitedAt;
let port;
let currentActivation;
const knownLaunchIds = new Set();

async function fixturePackage(root, launcher, helper, version) {
  for (const path of ["runtime/native", "runtime/node/bin", "app/dist/cli", ".portable"])
    await mkdir(join(resources(root), path), { recursive: true, mode: 0o700 });
  await mkdir(dirname(launcherFor(root)), { recursive: true, mode: 0o700 });
  await copyFile(launcher, launcherFor(root));
  await copyFile(helper, helperFor(root));
  // Use a relocatable Node binary: Homebrew's executable depends on its host libnode dylib.
  await copyFile(
    process.env.KEIKO_NATIVE_TEST_NODE ?? process.execPath,
    join(resources(root), "runtime/node/bin/node"),
  );
  for (const path of [
    launcherFor(root),
    helperFor(root),
    join(resources(root), "runtime/node/bin/node"),
  ])
    await chmod(path, 0o700);
  const entry =
    `process.env.KEIKO_HANDOFF_FIXTURE_VERSION=${JSON.stringify(version)};\n` +
    `process.env.KEIKO_HANDOFF_FIXTURE_RESUME="1";\n` +
    `process.env.KEIKO_HANDOFF_FIXTURE_FAIL_BOOT=${JSON.stringify(restoration && version === "1.0.1" ? "1" : "0")};\n` +
    // A valid successor may start after the former 15-second observation cutoff.
    // Exercise that scheduling delay inside the unchanged native verification grant.
    (restoration && version === "1.0.2"
      ? `await new Promise(resolve => setTimeout(resolve, 16_000));\n`
      : "") +
    `await import(${JSON.stringify(rootFixture)});\n`;
  await writeFile(join(resources(root), "app/dist/cli/index.js"), entry, { mode: 0o600 });
  await writeFile(
    join(resources(root), "app/package.json"),
    JSON.stringify({ name: "native-handoff-fixture", version, type: "module" }),
  );
  await writeFile(
    join(resources(root), ".portable/setup-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      packageName: "@oscharko-dev/keiko",
      packageVersion: version,
      platformTarget: target,
      stable: true,
      bootstrapUpdateEligible: false,
      primaryLauncher: primaryLauncher(target),
      runtime: runtimeFor(target),
    }),
  );
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  const selected = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return selected;
}

async function receipt(launchId) {
  return (await readFile(join(stateDir, ".keiko/ui-runtime", `${launchId}.receipt`), "utf8")).split(
    "\n",
  );
}

async function awaitPhase(launchId, phase, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while ((await receipt(launchId))[4] !== phase && performance.now() < deadline) await delay(20);
  const observed = (await receipt(launchId))[4];
  if (observed !== phase)
    console.error(
      JSON.stringify({
        classification: "native-fixture-phase-failure",
        expected: phase,
        observed,
        bootstrap: await readFixtureObservation("bootstrap", launchId),
        startup: await readFixtureObservation("startup", launchId),
      }),
    );
  assert.equal(observed, phase);
}

function updateOutcome(plan, previous, index, newLaunchId) {
  const restores = restoration && index === 0;
  return {
    launchId: restores ? plan.restoreLaunchId : newLaunchId,
    version: restores ? previous.version : plan.targetVersion,
    timeoutMs: Math.max(0, plan.deadlines.cleanupAt - Date.now()),
    receiptKind: restores ? "restored-verify" : "complete",
  };
}

async function assertClosedNativeLoader(launchId) {
  const proof = await receipt(launchId);
  if (process.platform === "darwin") {
    const command = execFileSync("/bin/ps", ["eww", "-p", proof[3], "-o", "command="], {
      encoding: "utf8",
      env: {},
    });
    assert(!command.includes("OPENAI_API_KEY="));
    assert(!command.includes("KEIKO_HANDOFF_FIXTURE_DATA="));
    return;
  }
  const names = (await readFile(`/proc/${proof[3]}/environ`, "utf8"))
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(0, entry.indexOf("=")))
    .sort();
  assert.deepEqual(
    names,
    [
      "KEIKO_STATE_DIR",
      "KEIKO_START_TIMEOUT_SECS",
      "KEIKO_UI_LAUNCH_ID",
      "KEIKO_UI_START_DEADLINE_MS",
      "KEIKO_UI_COMMIT_DEADLINE_MS",
    ].sort(),
  );
}

function unavailableObservation(error) {
  if (error?.code === "ERR_ASSERTION") throw error;
  return error instanceof Error ? error.name : "unknown";
}

async function awaitState(version, launchId, timeoutMs = 15_000) {
  const startedAt = performance.now();
  const deadline = performance.now() + timeoutMs;
  let last;
  let unavailable;
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/state`, {
        signal: AbortSignal.timeout(500),
      });
      const body = await response.json();
      const proof = await receipt(launchId);
      last = { version: body.version, pid: body.pid, phase: proof[4] };
      if (response.ok && body.version === version && proof[4] === "owned") {
        assert.equal(body.retainedEnvironment, true);
        assert.equal(body.environmentDigest, sha(environmentMarker));
        assert.equal(body.workingDirectoryDigest, sha(directory));
        assert.equal(Number(proof[1]), body.pid);
        const record = await readFile(join(stateDir, "ui.pid"), "utf8");
        assert.equal(record, `${body.pid}\n${launchId}\nbrowser-open-v1\nnative-app-v1\n`);
        return body;
      }
    } catch (error) {
      unavailable = unavailableObservation(error);
      // A replacement has a bounded interval with no listener or only a provisional receipt.
    }
    await delay(20);
  }
  console.error(
    JSON.stringify({
      classification: "native-fixture-failure",
      expectedVersion: version,
      observationMs: Math.round(performance.now() - startedAt),
      timeoutMs,
      unavailable,
      last,
      owners: await Promise.all(
        (await readdir(join(stateDir, ".keiko/ui-runtime"))).map(async (name) => {
          const record = (await readFile(join(stateDir, ".keiko/ui-runtime", name), "utf8")).split(
            "\n",
          );
          return { pid: record[1], phase: record[4], expected: record[2] === launchId };
        }),
      ),
      startupFailures: await Promise.all(
        (await readdir(stateDir))
          .filter((name) => /^fixture-failure-[a-f0-9]{32}\.json$/u.test(name))
          .map(async (name) => JSON.parse(await readFile(join(stateDir, name), "utf8"))),
      ),
      bootstrapObservations: await Promise.all(
        [...knownLaunchIds].map((id) => readFixtureObservation("bootstrap", id)),
      ),
      receipts:
        currentActivation === undefined
          ? []
          : readPortableHandoffReceipts(stateDir, currentActivation).map(
              ({ kind, outcome, at }) => ({
                kind,
                outcome,
                at,
              }),
            ),
    }),
  );
  throw new Error("native fixture did not reach the selected owned version");
}

async function startupControlObservation(reader) {
  if (!reader.ended || reader.size < 12) return { bufferedBytes: reader.size, ended: reader.ended };
  try {
    const frame = await appResponse(reader);
    return {
      kind: frame.kind,
      payloadBytes: frame.payload.length,
      ...(frame.kind === 2 && frame.payload.length === 8
        ? {
            rootExitCode: frame.payload.readUInt32LE(0),
            remainingProcesses: frame.payload.readUInt32LE(4),
          }
        : {}),
    };
  } catch {
    return { unavailable: true };
  }
}

async function readFixtureObservation(kind, launchId) {
  try {
    return JSON.parse(await readFile(join(stateDir, `fixture-${kind}-${launchId}.json`), "utf8"));
  } catch {
    return undefined;
  }
}

async function startupObservation(launchId, reader) {
  return {
    classification: "native-fixture-startup-failure",
    ownerExitCode: initialOwner.exitCode,
    ownerSignal: initialOwner.signalCode,
    ownerExitedAt,
    startup: await readFixtureObservation("startup", launchId),
    failure: await readFixtureObservation("failure", launchId),
    bootstrap: await readFixtureObservation("bootstrap", launchId),
    control: await startupControlObservation(reader),
  };
}

async function initialStart(launcher, helper, hash) {
  const requestedAt = Date.now();
  const launchId = randomBytes(16).toString("hex");
  knownLaunchIds.add(launchId);
  initialOwner = spawn(launcher, ["--own-app-runtime", helper, hash], {
    env: {},
    stdio: ["ignore", "pipe", "inherit", "pipe", "pipe"],
  });
  ownerExited = new Promise((resolve) => {
    initialOwner.once("exit", (code, signal) => {
      ownerExitedAt = Date.now();
      resolve({ code, signal });
    });
  });
  const reader = streamReader(initialOwner.stdio[4]);
  initialOwner.stdio[3].write(
    appLaunchPacket(
      {
        recoveryHandle: launchId,
        args: [rootFixture, "ui", "--port", String(port)],
        env: {
          KEIKO_STATE_DIR: stateDir,
          KEIKO_UI_LAUNCH_ID: launchId,
          KEIKO_START_TIMEOUT_SECS: String(INITIAL_START_TIMEOUT_MS / 1000),
        },
      },
      { executable: process.execPath, cwd: directory },
      {
        KEIKO_HANDOFF_FIXTURE_VERSION: "1.0.0",
        KEIKO_HANDOFF_FIXTURE_DATA: environmentMarker,
        KEIKO_UI_WORKING_DIRECTORY: directory,
        KEIKO_HANDOFF_FIXTURE_WRONG_LAUNCH: "1",
        KEIKO_HANDOFF_FIXTURE_COALESCED: coalesced ? "1" : "0",
        OPENAI_API_KEY: "fixture-placeholder",
        ...Object.fromEntries(
          Array.from({ length: 140 }, (_, index) => [
            `KEIKO_HANDOFF_FIXTURE_VALUE_${index}`,
            "x".repeat(512),
          ]),
        ),
      },
    ),
  );
  const started = await appResponse(reader);
  assert.equal(started.kind, 4);
  writeExclusivePidFile(
    join(stateDir, "ui.pid"),
    started.payload.readUInt32LE(0),
    launchId,
    true,
    true,
  );
  // Observe the complete startup grant already admitted by the native owner.
  const readyDeadline = performance.now() + INITIAL_START_TIMEOUT_MS;
  let ready = false;
  let lastObservation;
  while (!ready && performance.now() < readyDeadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/state`, {
        signal: AbortSignal.timeout(500),
      });
      const body = await response.json();
      ready = response.ok && body.pid === started.payload.readUInt32LE(0);
      lastObservation = {
        status: response.status,
        expectedPid: body.pid === started.payload.readUInt32LE(0),
      };
    } catch (error) {
      lastObservation = { unavailable: unavailableObservation(error) };
      // The actual root must consume and prove its metadata port before ownership commits.
    }
    if (!ready) await delay(20);
  }
  if (!ready)
    console.error(
      JSON.stringify({
        ...(await startupObservation(launchId, reader)),
        requestedAt,
        lastObservation,
      }),
    );
  assert(ready);
  initialOwner.stdio[3].write(commitPacket(launchId));
  assert.equal((await appResponse(reader)).kind, 5);
  initialOwner.stdio[3].end();
  return { launchId, ...(await awaitState("1.0.0", launchId)) };
}

function registration(root) {
  const layout = posixPortableActivationLayout(target, root);
  return portableRegistrationDocument({
    layout: { ...layout, installRoot: managedRoot },
    target: target,
    env: {},
    home: directory,
    now: Date.now(),
  });
}

async function planUpdate(previous, candidateRoot, targetVersion) {
  const activationId = randomBytes(16).toString("hex");
  const stageRoot = dirname(candidateRoot);
  const previousRegistration = await readFile(join(stateDir, "portable-install-state.json"));
  const preparedRegistration = registration(candidateRoot);
  const newLaunchId = randomBytes(16).toString("hex");
  const restoreLaunchId = randomBytes(16).toString("hex");
  knownLaunchIds.add(newLaunchId);
  knownLaunchIds.add(restoreLaunchId);
  const hashTree = (root) => hashPortableHandoffTree(root, { deadline: Date.now() + 30_000 });
  const now = Date.now();
  const plan = createPortableHandoffPlan({
    activationId,
    sessionId: "native-fixture",
    stageId: basename(stageRoot),
    target: target,
    targetVersion,
    newLaunchId,
    restoreLaunchId,
    aggregateRevision: 1,
    previousRegistrationState: "present",
    oldProcess: {
      pid: previous.pid,
      launchId: previous.launchId,
      host: "127.0.0.1",
      port,
      version: previous.version,
    },
    paths: {
      managedRoot,
      stageRoot,
      candidateRoot,
      backupRoot: join(directory, `.keiko-previous-${activationId}`),
      candidateLauncher: launcherFor(candidateRoot),
      candidateSupervisor: helperFor(candidateRoot),
    },
    digests: {
      currentTreeSha256: await hashTree(managedRoot),
      candidateTreeSha256: await hashTree(candidateRoot),
      currentLauncherSha256: await digest(launcherFor(managedRoot)),
      currentSupervisorSha256: await digest(helperFor(managedRoot)),
      candidateLauncherSha256: await digest(launcherFor(candidateRoot)),
      candidateSupervisorSha256: await digest(helperFor(candidateRoot)),
      previousRegistrationSha256: sha(previousRegistration),
      preparedRegistrationSha256: sha(preparedRegistration),
    },
    deadlines: {
      oldExitAt: now + 15_000,
      startAt: now + 35_000,
      verifyAt: now + 50_000,
      cleanupAt: now + 65_000,
    },
  });
  writePortableHandoffPlan({ stateDir, plan });
  const capsule = join(stateDir, "updates/handoff", activationId);
  await writeFile(join(capsule, "registration.previous"), previousRegistration, { mode: 0o600 });
  await writeFile(join(capsule, "registration.next"), preparedRegistration, { mode: 0o600 });
  return { plan, newLaunchId };
}

await test(
  `native app owner hands off two real coordinators outside the previous generations (${restoration ? "restoration" : coalesced ? "coalesced cancellation" : "production admission"})`,
  { timeout: 180_000 },
  async (context) => {
    context.after(async () => {
      if (port === undefined) return;
      try {
        const base = `http://127.0.0.1:${port}`;
        const state = await fetch(`${base}/state`, { signal: AbortSignal.timeout(500) }).then(
          (response) => response.json(),
        );
        const proofs = await Promise.all(
          [...knownLaunchIds].map(async (id) => {
            try {
              return await receipt(id);
            } catch {
              return [];
            }
          }),
        );
        if (proofs.some((proof) => Number(proof[1]) === state.pid))
          await fetch(`${base}/shutdown`, { method: "POST", signal: AbortSignal.timeout(1000) });
      } catch {
        // A stopped fixture has no HTTP endpoint; cleanup never signals a numeric PID.
      }
    });
    await mkdir(stateDir, { mode: 0o700 });
    const launcher = await compileOwnerFixture(
      directory,
      "launcher",
      "../../portable-launcher/keiko-portable-launcher.c",
    );
    const helper = await compileOwnerFixture(
      directory,
      "supervisor",
      "./keiko_runtime_supervisor.c",
    );
    const hash = await digest(helper);
    const stages = [
      join(directory, ".keiko-portable-updates/stage-b", bundleName),
      join(directory, ".keiko-portable-updates/stage-c", bundleName),
    ];
    await fixturePackage(managedRoot, launcher, helper, "1.0.0");
    await fixturePackage(stages[0], launcher, helper, "1.0.1");
    await fixturePackage(stages[1], launcher, helper, "1.0.2");
    await writeFile(join(stateDir, "portable-install-state.json"), registration(managedRoot));
    port = await unusedPort();
    let previous = await initialStart(launcherFor(managedRoot), helper, hash);
    for (let index = 0; index < (coalesced ? 3 : 0); ++index) {
      const { plan } = await planUpdate(previous, stages[0], "1.0.1");
      const before = await hashPortableHandoffTree(managedRoot, { deadline: Date.now() + 30_000 });
      const response = await fetch(`http://127.0.0.1:${port}/handoff`, {
        method: "POST",
        body: JSON.stringify({ activationId: plan.activationId, cancel: true }),
        signal: AbortSignal.timeout(20_000),
      });
      const cancelled = await response.json();
      assert.equal(response.status, 200, JSON.stringify(cancelled));
      assert.equal(cancelled.cancelled, true);
      assert(cancelled.coordinatorPid > 1 && cancelled.coordinatorPid !== previous.pid);
      assert.equal(
        await hashPortableHandoffTree(managedRoot, { deadline: Date.now() + 30_000 }),
        before,
      );
      assert.equal((await awaitState(previous.version, previous.launchId)).pid, previous.pid);
    }
    for (const [index, candidateRoot] of stages.entries()) {
      const version = `1.0.${index + 1}`;
      const { plan, newLaunchId } = await planUpdate(previous, candidateRoot, version);
      currentActivation = plan.activationId;
      const response = await fetch(`http://127.0.0.1:${port}/handoff`, {
        method: "POST",
        body: JSON.stringify({ activationId: plan.activationId }),
        signal: AbortSignal.timeout(20_000),
      });
      const accepted = await response.json();
      assert.equal(response.status, 200, JSON.stringify(accepted));
      assert.equal(accepted.accepted, true);
      assert.notEqual(accepted.coordinatorPid, previous.pid);
      const outcome = updateOutcome(plan, previous, index, newLaunchId);
      const next = await awaitState(outcome.version, outcome.launchId, outcome.timeoutMs);
      await assertClosedNativeLoader(outcome.launchId);
      await awaitPhase(previous.launchId, "reaped", 5000);
      assert.equal(
        readPortableHandoffReceipts(stateDir, plan.activationId).at(-1).kind,
        outcome.receiptKind,
      );
      if (index === 0) assert.deepEqual(await ownerExited, { code: 0, signal: null });
      previous = { ...next, launchId: outcome.launchId };
    }
    await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(1000),
    });
    await awaitPhase(previous.launchId, "reaped", 10_000);
  },
);

if (initialOwner !== undefined && initialOwner.exitCode === null) initialOwner.kill("SIGKILL");
await rm(directory, { recursive: true, force: true });
