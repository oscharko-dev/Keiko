// #4492 (epic #4491): the acceptance task a person gives a Coding run, worked end to end on macOS
// through production composition only. A project's tests fail; the run reads the file, repairs it
// with the runtime's own `edit` and runs `npm test` in its own shell. That shell is a child of the
// runtime process Keiko spawned inside the Seatbelt boundary, and no container runtime is
// involved. The tester then checks the end state outside Keiko: the run's outcome, the project's
// own `npm test`, the untouched test files and the Activity Log. The model is scripted
// (`acceptance` mode), so this proves the product's part of the promise, not a model's skill; a
// real-model run of the same task closes the acceptance criteria. Proving each boundary statement
// from the model's own shell belongs to #4521.
//
// Runs where the dev-lane functional suite runs: macOS with `KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1`
// and the staged payload (`npm run dev:coding-runtime:stage`). Set `KEIKO_ACCEPTANCE_EVIDENCE_FILE`
// to keep the body-free evidence of every case (platform, user class, container runtime, versions
// and outcomes; no paths, no content).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { CodingWorkbenchRuntimeStateName } from "@oscharko-dev/keiko-contracts";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";

import { resetServerLogger } from "../../../../tests/support/activity-log-test-support.js";
import {
  createBufferedServerLogSink,
  type BufferedServerLogSink,
} from "../../../../tests/support/buffered-server-log.js";
import { createServerLogger, setServerLogger } from "../observability/index.js";
import { createInMemoryUiStore } from "../store/index.js";
import { withLocalCheckout } from "../task-workspace/local-checkout.js";
import {
  functionalPost,
  startFunctionalDiscoveryServer,
  type FunctionalDiscoveryServer,
} from "../test-support/functional-bff-server.js";
import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeOrchestrator } from "./codingRuntimeOrchestrator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { devLaneEnvEnabled } from "./devLanePortableCodingRuntime.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  ACCEPTANCE_CHECK_COMMAND,
  ACCEPTANCE_STALE_SUFFIX,
  createFunctionalTaskWorkspaceOwners,
  provisionFunctionalTaskWorkspace,
  type FunctionalTaskWorkspaceOwners,
  type ScriptState,
} from "./productionOpenCodeBackend.functional/_support.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURES = join(REPOSITORY_ROOT, "tests", "fixtures", "coding-acceptance");
/** The task text a person gives the run (tests/fixtures/coding-acceptance/README.md). */
const ACCEPTANCE_TASK =
  "The tests in this project fail. Find the cause in src/, fix it there and run npm test until it passes. Do not change the tests.";
const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
  "recovery-required",
]);
/** The closed failure code for "no passing check after the final edit", whatever the cause. */
const NOT_VERIFIED = "verification-not-evidenced";

type AcceptanceProject = "no-dependencies" | "with-dependency";
type AcceptanceMode = "governed-assist" | "supervised-coding" | "autonomous-delivery";

interface AcceptanceCase {
  readonly project: AcceptanceProject;
  readonly mode: AcceptanceMode;
  /** Keiko's managed task worktree, or the person's own folder selected as a Local checkout. */
  readonly workspace: "managed-worktree" | "own-folder";
  readonly variant: "fixed" | "wrong";
  /** Whether the run's folder holds the project's dependencies before the run starts. */
  readonly dependencies: "none-needed" | "installed" | "missing";
  /**
   * The run's check after its edit: rerun (`verify`), never rerun (`skip-check`), rerun and then
   * edit again (`stale-check`), or asked for and denied by the person (`denied`).
   */
  readonly check: "verify" | "skip-check" | "stale-check" | "denied";
  readonly expected: "succeeded" | "not-succeeded";
}

/** The confinement the run's runtime process was spawned with, as its Activity Log line says. */
interface ConfinementFacts {
  readonly backend: unknown;
  readonly profile: unknown;
  readonly egressDisposition: unknown;
  readonly workspaceAccess: unknown;
}

/** What one case observed, body-free: closed values and counts only. */
interface AcceptanceObservation {
  readonly state: string | undefined;
  readonly settledState: unknown;
  readonly failureCode: unknown;
  readonly verificationBlockedReason: unknown;
  readonly approvalCount: number;
  readonly denialCount: number;
  readonly testerCheckExitCode: number;
  readonly testFilesUnchanged: boolean;
  readonly editLanded: boolean;
  readonly confinement: readonly ConfinementFacts[];
  readonly verificationSummaries: readonly string[];
  readonly durationMs: number;
}

type EvidenceEntry =
  | { readonly acceptanceCase: AcceptanceCase; readonly observed: AcceptanceObservation }
  | { readonly acceptanceCase: AcceptanceCase; readonly harnessError: true };

const TARGETS: Readonly<Record<AcceptanceProject, string>> = {
  "no-dependencies": "src/invoice.js",
  "with-dependency": "src/release.js",
};

const roots: string[] = [];
const disposers: (() => Promise<void> | void)[] = [];
const evidence: EvidenceEntry[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  const file = process.env.KEIKO_ACCEPTANCE_EVIDENCE_FILE;
  if (file === undefined || file === "" || evidence.length === 0) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(acceptanceEvidence(), null, 2)}\n`, { mode: 0o600 });
});

function acceptanceEnabled(): boolean {
  return (
    process.platform === "darwin" &&
    devLaneEnvEnabled(process.env.KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL)
  );
}

function verified(
  project: AcceptanceProject,
  mode: AcceptanceMode,
  workspace: AcceptanceCase["workspace"] = "managed-worktree",
): AcceptanceCase {
  return {
    project,
    mode,
    workspace,
    variant: "fixed",
    dependencies: project === "no-dependencies" ? "none-needed" : "installed",
    check: "verify",
    expected: "succeeded",
  };
}

function unverified(
  mode: AcceptanceMode,
  variant: AcceptanceCase["variant"],
  check: AcceptanceCase["check"],
): AcceptanceCase {
  return {
    project: "no-dependencies",
    mode,
    workspace: "managed-worktree",
    variant,
    dependencies: "none-needed",
    check,
    expected: "not-succeeded",
  };
}

describe.skipIf(!acceptanceEnabled())(
  "Coding acceptance task on macOS without a container runtime (#4492)",
  () => {
    it.each(["supervised-coding", "autonomous-delivery", "governed-assist"] as const)(
      "repairs the defect and verifies it with the project's own tests in %s",
      async (mode) => {
        const observed = await runAcceptanceCase(verified("no-dependencies", mode));
        expectSucceeded(observed, mode);
        // Ask for approval asks before each command and before the edit: the failing check, the
        // edit, the passing check. The other modes ask for none of this workspace-contained work.
        expect(observed.approvalCount).toBe(mode === "governed-assist" ? 3 : 0);
        expect(observed.denialCount).toBe(0);
      },
      240_000,
    );

    it("never reports success for an edit that leaves the tests red", async () => {
      const observed = await runAcceptanceCase(unverified("supervised-coding", "wrong", "verify"));
      expectNotVerified(observed, { testsPassOutsideKeiko: false });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:failed"]);
    }, 240_000);

    // The other three never-a-pass cases use the right fix, so the project's tests pass when the
    // tester runs them; the outcome must still follow what the run itself verified.
    it("never reports success when the run skips its check after the edit", async () => {
      const observed = await runAcceptanceCase(
        unverified("supervised-coding", "fixed", "skip-check"),
      );
      expectNotVerified(observed, { testsPassOutsideKeiko: true });
      expect(observed.verificationSummaries).toEqual(["test:failed"]);
    }, 240_000);

    it("never counts a check that passed before the final edit", async () => {
      const observed = await runAcceptanceCase(
        unverified("autonomous-delivery", "fixed", "stale-check"),
      );
      expectNotVerified(observed, { testsPassOutsideKeiko: true });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:passed"]);
    }, 240_000);

    it("never reports success when the person denies the check after the edit", async () => {
      const observed = await runAcceptanceCase(unverified("governed-assist", "fixed", "denied"));
      expectNotVerified(observed, { testsPassOutsideKeiko: true });
      expect(observed.verificationSummaries).toEqual(["test:failed"]);
      expect(observed.verificationBlockedReason).toBe("verification-command-denied");
      expect([observed.approvalCount, observed.denialCount]).toEqual([2, 1]);
    }, 240_000);

    it("verifies a project whose dependencies are installed in the person's own folder", async () => {
      const observed = await runAcceptanceCase(
        verified("with-dependency", "supervised-coding", "own-folder"),
      );
      expectSucceeded(observed, "supervised-coding");
    }, 240_000);

    // Baseline until #4522: a managed task worktree is a fresh checkout without `node_modules`, and
    // below Full access the run's shell has no registry, so its tests cannot load the dependency.
    // The run must say so honestly rather than succeed; #4522 turns this case into a success.
    it("does not report success while a managed worktree lacks the project's dependencies", async () => {
      const observed = await runAcceptanceCase({
        ...verified("with-dependency", "supervised-coding"),
        dependencies: "missing",
        expected: "not-succeeded",
      });
      expectNotVerified(observed, { testsPassOutsideKeiko: false });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:failed"]);
    }, 240_000);
  },
);

function expectSucceeded(observed: AcceptanceObservation, mode: AcceptanceMode): void {
  const context = JSON.stringify(observed);
  expect(observed.state, context).toBe("succeeded");
  expect(observed.settledState, context).toBe("succeeded");
  expect(observed.editLanded, context).toBe(true);
  expect(observed.testerCheckExitCode, context).toBe(0);
  expect(observed.testFilesUnchanged, context).toBe(true);
  expect(observed.verificationSummaries.at(-1), context).toBe("test:passed");
  expectNativeConfinement(observed, mode);
}

function expectNotVerified(
  observed: AcceptanceObservation,
  expected: { readonly testsPassOutsideKeiko: boolean },
): void {
  const context = JSON.stringify(observed);
  expect(observed.state, context).toBe("failed");
  expect(observed.settledState, context).toBe("failed");
  expect(observed.failureCode, context).toBe(NOT_VERIFIED);
  expect(observed.editLanded, context).toBe(true);
  expect(observed.testFilesUnchanged, context).toBe(true);
  if (expected.testsPassOutsideKeiko) expect(observed.testerCheckExitCode, context).toBe(0);
  else expect(observed.testerCheckExitCode, context).toBeGreaterThan(0);
}

/**
 * The run's runtime process, whose shell ran `npm test`, was spawned inside Seatbelt with the
 * native profile, read-write access to its workspace and the network rule of the run's mode:
 * loopback only below Full access. Seatbelt confinement is inherited by every child process.
 */
function expectNativeConfinement(observed: AcceptanceObservation, mode: AcceptanceMode): void {
  expect(observed.confinement.length, JSON.stringify(observed)).toBeGreaterThan(0);
  for (const spawned of observed.confinement) {
    expect(spawned).toEqual({
      backend: "seatbelt",
      profile: "keiko-native",
      egressDisposition: mode === "autonomous-delivery" ? "inherited" : "loopback-only",
      workspaceAccess: "read-write",
    });
  }
}

interface PreparedAcceptanceCase {
  readonly root: string;
  readonly owners: FunctionalTaskWorkspaceOwners;
  /** The folder the run works in, which the tester checks afterwards. */
  readonly runRoot: string;
  readonly lifecycle: WorkspaceLifecycleService;
  readonly store?: ReturnType<typeof createInMemoryUiStore>;
  readonly original: string;
  readonly replacement: string;
}

async function runAcceptanceCase(acceptanceCase: AcceptanceCase): Promise<AcceptanceObservation> {
  try {
    const observed = await observeAcceptanceCase(acceptanceCase);
    evidence.push({ acceptanceCase, observed });
    return observed;
  } catch (error) {
    // The case did not complete; its record says so without the error's text.
    evidence.push({ acceptanceCase, harnessError: true });
    throw error;
  }
}

async function observeAcceptanceCase(
  acceptanceCase: AcceptanceCase,
): Promise<AcceptanceObservation> {
  const prepared = await prepareAcceptanceCase(acceptanceCase);
  const target = join(prepared.runRoot, TARGETS[acceptanceCase.project]);
  // The precondition: the project's own tests fail before the run.
  expect(testerCheck(prepared.runRoot)).toBeGreaterThan(0);
  const testsBefore = testFilesDigest(prepared.runRoot);
  const script = acceptanceScript(acceptanceCase, prepared);
  const log = recordActivityLog();
  const served = await serveAcceptance(prepared, script);
  const startedAt = Date.now();
  const runId = await startAcceptanceRun(served, acceptanceCase);
  const editDone = (): boolean => readFileSync(target, "utf8") !== prepared.original;
  const asks = await settleAnsweringEveryAsk(served.orchestrator, runId, () =>
    acceptanceCase.check === "denied" && editDone() ? "denied" : "approved",
  );
  const finalContent =
    acceptanceCase.check === "stale-check"
      ? `${prepared.replacement}${ACCEPTANCE_STALE_SUFFIX}`
      : prepared.replacement;
  return {
    ...settledFacts(log, runId),
    state: served.orchestrator.getSnapshot(runId)?.state,
    approvalCount: asks.approved,
    denialCount: asks.denied,
    testerCheckExitCode: testerCheck(prepared.runRoot),
    testFilesUnchanged: testFilesDigest(prepared.runRoot) === testsBefore,
    editLanded: readFileSync(target, "utf8") === finalContent,
    durationMs: Date.now() - startedAt,
  };
}

function acceptanceScript(
  acceptanceCase: AcceptanceCase,
  prepared: PreparedAcceptanceCase,
): ScriptState {
  return {
    mode: "acceptance",
    calls: 0,
    old: prepared.original,
    next: prepared.replacement,
    acceptanceTarget: TARGETS[acceptanceCase.project],
    acceptancePlan:
      acceptanceCase.check === "skip-check" || acceptanceCase.check === "stale-check"
        ? acceptanceCase.check
        : "verify",
  };
}

async function prepareAcceptanceCase(
  acceptanceCase: AcceptanceCase,
): Promise<PreparedAcceptanceCase> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-acceptance-")));
  roots.push(root);
  const repository = join(root, "repository");
  cpSync(join(FIXTURES, acceptanceCase.project), repository, { recursive: true });
  commitFixture(repository);
  const owners = createFunctionalTaskWorkspaceOwners(
    join(root, "bff-state", "ui-db", "task-workspaces"),
    createInMemoryEvidenceStore(),
  );
  const worktree = await provisionFunctionalTaskWorkspace(owners, repository, "task-4492");
  const own = acceptanceCase.workspace === "own-folder";
  const selected = own
    ? selectOwnFolder(owners, repository)
    : { lifecycle: owners.lifecycle, store: undefined };
  const runRoot = own ? repository : worktree;
  if (acceptanceCase.dependencies === "installed") installSemver(runRoot);
  const target = TARGETS[acceptanceCase.project];
  return {
    root,
    owners,
    runRoot,
    lifecycle: selected.lifecycle,
    ...(selected.store === undefined ? {} : { store: selected.store }),
    original: readFileSync(join(runRoot, target), "utf8"),
    replacement: readFileSync(variantFile(acceptanceCase), "utf8"),
  };
}

function variantFile(acceptanceCase: AcceptanceCase): string {
  const target = TARGETS[acceptanceCase.project];
  const name = target.replace(/\.js$/u, `.${acceptanceCase.variant}.js`);
  return join(FIXTURES, "variants", acceptanceCase.project, name);
}

function commitFixture(repository: string): void {
  git(repository, ["init", "-q", "-b", "main"]);
  git(repository, ["config", "user.email", "acceptance@keiko.example"]);
  git(repository, ["config", "user.name", "Keiko Acceptance"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  // The scripted edit names the file's exact bytes; a host-wide `core.autocrlf=true` would check
  // the managed worktree out with CRLF and the runtime would rightly refuse the edit as stale.
  git(repository, ["config", "core.autocrlf", "false"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-q", "-m", "acceptance fixture"]);
}

/** The person's own folder, selected the way the Workbench selects a Local checkout (#3907). */
function selectOwnFolder(
  owners: FunctionalTaskWorkspaceOwners,
  repository: string,
): {
  readonly lifecycle: WorkspaceLifecycleService;
  readonly store: ReturnType<typeof createInMemoryUiStore>;
} {
  const store = createInMemoryUiStore();
  store.createProject(repository, "acceptance");
  const lifecycle = withLocalCheckout(
    owners.lifecycle,
    owners.activePointerStore,
    store,
    owners.instances,
    { evidenceStore: createInMemoryEvidenceStore(), redactString: (value) => value, now: Date.now },
  );
  lifecycle.selectLocal({ root: repository, branch: "main", requestedBy: "acceptance" });
  return { lifecycle, store };
}

/**
 * The dependency as `npm install` would leave it, taken from this checkout's own lockfile-pinned
 * copy so the test reaches no registry. `semver` has no dependencies of its own.
 */
function installSemver(folder: string): void {
  cpSync(join(REPOSITORY_ROOT, "node_modules", "semver"), join(folder, "node_modules", "semver"), {
    recursive: true,
  });
}

async function serveAcceptance(
  prepared: PreparedAcceptanceCase,
  script: ScriptState,
): Promise<FunctionalDiscoveryServer & { readonly orchestrator: CodingRuntimeOrchestrator }> {
  const served = await startFunctionalDiscoveryServer({
    stateRoot: join(prepared.root, "bff-state"),
    workspaceLifecycle: prepared.lifecycle,
    ...(prepared.store === undefined
      ? {}
      : {
          store: prepared.store,
          codingRuntimeSnapshotStore: createCodingRuntimeSnapshotStore(prepared.owners.db),
        }),
    workspaceProvisioning: prepared.owners.provisioning,
    script,
    staticRoot: prepared.root,
  });
  disposers.push(served.close);
  const orchestrator = served.deps.codingRuntimeOrchestrator;
  if (orchestrator === undefined) throw new Error("acceptance-control-plane-missing");
  return { ...served, orchestrator };
}

async function startAcceptanceRun(
  served: FunctionalDiscoveryServer,
  acceptanceCase: AcceptanceCase,
): Promise<string> {
  const started = await functionalPost(served.baseUrl, "/api/coding-workbench/runtime/runs", {
    requestId: `acceptance-${acceptanceCase.project}-${acceptanceCase.mode}`,
    taskIntent: ACCEPTANCE_TASK,
    requestedMode: acceptanceCase.mode,
  });
  const text = await started.clone().text();
  expect(started.status, text).toBe(200);
  const run = (await started.json()) as { readonly runId: string; readonly state: string };
  expect(run.state, text).toBe("running");
  return run.runId;
}

/** Waits for the run to settle, answering every ask the way the person in front of it would. */
async function settleAnsweringEveryAsk(
  orchestrator: CodingRuntimeOrchestrator,
  runId: string,
  decide: () => "approved" | "denied",
): Promise<{ readonly approved: number; readonly denied: number }> {
  const answered = { approved: 0, denied: 0 };
  await vi.waitFor(
    async () => {
      const snapshot = orchestrator.getSnapshot(runId);
      const pending = snapshot?.pendingPermission;
      if (snapshot?.state === "awaiting-approval" && pending !== undefined) {
        const decision = decide();
        answered[decision] += 1;
        await orchestrator.decideApproval(runId, {
          requestId: pending.requestId,
          decision,
          expectedRevision: snapshot.revision,
        });
      }
      expect(TERMINAL_STATES.has(orchestrator.getSnapshot(runId)?.state ?? "idle")).toBe(true);
    },
    { timeout: 200_000, interval: 200 },
  );
  return answered;
}

/** The tester's own check, outside Keiko, in the folder the run worked in. */
function testerCheck(folder: string): number {
  const [program = "npm", ...args] = ACCEPTANCE_CHECK_COMMAND.split(" ");
  const result = spawnSync(program, args, {
    cwd: folder,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", npm_config_offline: "true" },
    timeout: 60_000,
  });
  // A check that could not run (no `npm`, a timeout, a signal) has no exit code; it is never a
  // red result and never a green one.
  if (typeof result.status !== "number") {
    throw new Error(`acceptance-tester-check-did-not-run:${String(result.signal)}`);
  }
  return result.status;
}

function testFilesDigest(folder: string): string {
  const directory = join(folder, "test");
  const hash = createHash("sha256");
  for (const name of readdirSync(directory).sort()) {
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(join(directory, name)))
      .update("\0");
  }
  return hash.digest("hex");
}

function settledFacts(
  log: BufferedServerLogSink,
  runId: string,
): Pick<
  AcceptanceObservation,
  | "settledState"
  | "failureCode"
  | "verificationBlockedReason"
  | "confinement"
  | "verificationSummaries"
> {
  const settled = log.events.find(
    (event) => event.op === "coding-runtime.run.settled" && event.extra?.runId === runId,
  );
  return {
    settledState: settled?.extra?.state,
    failureCode: settled?.extra?.failureCode,
    verificationBlockedReason: settled?.extra?.verificationBlockedReason,
    confinement: log.events
      .filter(
        (event) => event.op === "runtime.confinement.spawned" && event.correlationId === runId,
      )
      .map((event) => ({
        backend: event.extra?.backend,
        profile: event.extra?.profile,
        egressDisposition: event.extra?.egressDisposition,
        workspaceAccess: event.extra?.workspaceAccess,
      })),
    verificationSummaries: log.events.flatMap((event) =>
      event.op === "coding-runtime.verification-summarized" && event.extra?.runId === runId
        ? [`${String(event.extra.verifierId)}:${String(event.extra.verificationStatus)}`]
        : [],
    ),
  };
}

function recordActivityLog(): BufferedServerLogSink {
  const sink = createBufferedServerLogSink();
  setServerLogger(createServerLogger({ sink, level: "info" }));
  disposers.push(() => {
    resetServerLogger();
  });
  return sink;
}

function acceptanceEvidence(): Record<string, unknown> {
  const administrator = groups().includes("admin");
  const containerRuntime = {
    dockerOnPath: onPath("docker"),
    podmanOnPath: onPath("podman"),
    dockerSocketPresent: [
      join(homedir(), ".docker", "run", "docker.sock"),
      "/var/run/docker.sock",
    ].some((socket) => existsSync(socket)),
  };
  // The promise is for a standard user on a machine without a container runtime; evidence taken
  // anywhere else describes the product, but it does not certify that promise.
  const unmetPreconditions = [
    ...(administrator ? ["administrator"] : []),
    ...(Object.values(containerRuntime).some(Boolean) ? ["container-runtime-present"] : []),
  ];
  return {
    schemaVersion: 1,
    issue: 4492,
    platform: process.platform,
    arch: process.arch,
    darwinRelease: release(),
    node: process.versions.node,
    opencode: OPENCODE_PINNED_VERSION,
    userClass: administrator ? "administrator" : "standard",
    containerRuntime,
    certifiesPromise: unmetPreconditions.length === 0,
    unmetPreconditions,
    cases: evidence,
  };
}

function groups(): readonly string[] {
  return execFileSync("/usr/bin/id", ["-Gn"], { encoding: "utf8" }).trim().split(/\s+/u);
}

function onPath(program: string): boolean {
  return spawnSync("/usr/bin/which", [program], { encoding: "utf8" }).status === 0;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}
