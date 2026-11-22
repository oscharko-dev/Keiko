// #4492 (epic #4491): the acceptance task a person gives a Coding run, worked end to end on macOS
// through production composition only. A project's tests fail; the run reads the file, repairs it
// with the runtime's own `edit` and runs `npm test` in its own shell, inside the Seatbelt boundary,
// with no container runtime involved. The tester then checks the end state outside Keiko: the run's
// outcome, the project's own `npm test`, the untouched test files and the Activity Log. The model is
// scripted (`acceptance` mode), so this proves the product's part of the promise, not a model's
// skill; a real-model run of the same task closes the acceptance criteria.
//
// Runs where the dev-lane functional suite runs: macOS with `KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1`
// and the staged payload (`npm run dev:coding-runtime:stage`). Set `KEIKO_ACCEPTANCE_EVIDENCE_FILE`
// to keep the body-free evidence of every case (platform, user class, container runtime, versions
// and outcomes; no paths, no content).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { release, tmpdir } from "node:os";
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
  readonly expected: "succeeded" | "not-succeeded";
}

/** What one case observed, body-free: closed values and counts only. */
interface AcceptanceObservation {
  readonly state: string | undefined;
  readonly failureCode: unknown;
  readonly verificationBlockedReason: unknown;
  readonly approvalCount: number;
  readonly testerCheckExitCode: number | null;
  readonly testFilesUnchanged: boolean;
  readonly targetRepaired: boolean;
  readonly confinementBackends: readonly unknown[];
  readonly verificationSummaries: readonly string[];
  readonly durationMs: number;
}

const TARGETS: Readonly<Record<AcceptanceProject, string>> = {
  "no-dependencies": "src/invoice.js",
  "with-dependency": "src/release.js",
};

const roots: string[] = [];
const disposers: (() => Promise<void> | void)[] = [];
const evidence: { readonly acceptanceCase: AcceptanceCase; observed: AcceptanceObservation }[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  const file = process.env.KEIKO_ACCEPTANCE_EVIDENCE_FILE;
  if (file === undefined || file === "" || evidence.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(acceptanceEvidence(), null, 2)}\n`);
});

function acceptanceEnabled(): boolean {
  return (
    process.platform === "darwin" &&
    devLaneEnvEnabled(process.env.KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL)
  );
}

describe.skipIf(!acceptanceEnabled())(
  "Coding acceptance task on macOS without a container runtime (#4492)",
  () => {
    it.each(["supervised-coding", "autonomous-delivery", "governed-assist"] as const)(
      "repairs the defect and verifies it with the project's own tests in %s",
      async (mode) => {
        const observed = await runAcceptanceCase({
          project: "no-dependencies",
          mode,
          workspace: "managed-worktree",
          variant: "fixed",
          dependencies: "none-needed",
          expected: "succeeded",
        });
        expectSucceeded(observed);
        // Ask for approval asks before the edit and before each command; the other modes ask for
        // none of this routine, workspace-contained work.
        if (mode === "governed-assist") expect(observed.approvalCount).toBeGreaterThan(0);
        else expect(observed.approvalCount).toBe(0);
      },
      240_000,
    );

    it("never reports success for an edit that leaves the tests red", async () => {
      const observed = await runAcceptanceCase({
        project: "no-dependencies",
        mode: "supervised-coding",
        workspace: "managed-worktree",
        variant: "wrong",
        dependencies: "none-needed",
        expected: "not-succeeded",
      });
      expect(observed.targetRepaired).toBe(true);
      expect(observed.state).not.toBe("succeeded");
      expect(observed.testerCheckExitCode).not.toBe(0);
      expect(observed.testFilesUnchanged).toBe(true);
      expect(observed.verificationSummaries).toContain("test:failed");
      expect(observed.verificationSummaries).not.toContain("test:passed");
    }, 240_000);

    it("verifies a project whose dependencies are installed in the person's own folder", async () => {
      const observed = await runAcceptanceCase({
        project: "with-dependency",
        mode: "supervised-coding",
        workspace: "own-folder",
        variant: "fixed",
        dependencies: "installed",
        expected: "succeeded",
      });
      expectSucceeded(observed);
    }, 240_000);

    // Baseline until #4522: a managed task worktree is a fresh checkout without `node_modules`, and
    // below Full access the run's shell has no registry, so its tests cannot load the dependency.
    // The run must say so honestly rather than succeed; #4522 turns this case into a success.
    it("does not report success while a managed worktree lacks the project's dependencies", async () => {
      const observed = await runAcceptanceCase({
        project: "with-dependency",
        mode: "supervised-coding",
        workspace: "managed-worktree",
        variant: "fixed",
        dependencies: "missing",
        expected: "not-succeeded",
      });
      expect(observed.targetRepaired).toBe(true);
      expect(observed.state).not.toBe("succeeded");
      expect(observed.testerCheckExitCode).not.toBe(0);
      expect(observed.testFilesUnchanged).toBe(true);
    }, 240_000);
  },
);

function expectSucceeded(observed: AcceptanceObservation): void {
  const context = JSON.stringify(observed);
  expect(observed.state, context).toBe("succeeded");
  expect(observed.targetRepaired, context).toBe(true);
  expect(observed.testerCheckExitCode, context).toBe(0);
  expect(observed.testFilesUnchanged, context).toBe(true);
  // The run's own tests ran inside the native Seatbelt boundary and are what verified it.
  expect(observed.confinementBackends, context).toContain("seatbelt");
  expect(observed.verificationSummaries.at(-1), context).toBe("test:passed");
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
  const prepared = await prepareAcceptanceCase(acceptanceCase);
  const target = TARGETS[acceptanceCase.project];
  // The precondition: the project's own tests fail before the run.
  expect(testerCheck(prepared.runRoot)).not.toBe(0);
  const testsBefore = testFilesDigest(prepared.runRoot);
  const script: ScriptState = {
    mode: "acceptance",
    calls: 0,
    old: prepared.original,
    next: prepared.replacement,
    acceptanceTarget: target,
  };
  const log = recordActivityLog();
  const served = await serveAcceptance(prepared, script);
  const startedAt = Date.now();
  const runId = await startAcceptanceRun(served, acceptanceCase);
  const approvalCount = await settleApprovingEveryAsk(served.orchestrator, runId);
  const observed: AcceptanceObservation = {
    ...settledFacts(log, runId),
    state: served.orchestrator.getSnapshot(runId)?.state,
    approvalCount,
    testerCheckExitCode: testerCheck(prepared.runRoot),
    testFilesUnchanged: testFilesDigest(prepared.runRoot) === testsBefore,
    targetRepaired: readFileSync(join(prepared.runRoot, target), "utf8") === prepared.replacement,
    durationMs: Date.now() - startedAt,
  };
  evidence.push({ acceptanceCase, observed });
  return observed;
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

/** Waits for the run to settle, approving every ask the way a person in front of it would. */
async function settleApprovingEveryAsk(
  orchestrator: CodingRuntimeOrchestrator,
  runId: string,
): Promise<number> {
  let approvals = 0;
  await vi.waitFor(
    async () => {
      const snapshot = orchestrator.getSnapshot(runId);
      const pending = snapshot?.pendingPermission;
      if (snapshot?.state === "awaiting-approval" && pending !== undefined) {
        approvals += 1;
        await orchestrator.decideApproval(runId, {
          requestId: pending.requestId,
          decision: "approved",
          expectedRevision: snapshot.revision,
        });
      }
      expect(TERMINAL_STATES.has(orchestrator.getSnapshot(runId)?.state ?? "idle")).toBe(true);
    },
    { timeout: 200_000, interval: 200 },
  );
  return approvals;
}

/** The tester's own check, outside Keiko, in the folder the run worked in. */
function testerCheck(folder: string): number | null {
  const [program = "npm", ...args] = ACCEPTANCE_CHECK_COMMAND.split(" ");
  return spawnSync(program, args, {
    cwd: folder,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", npm_config_offline: "true" },
    timeout: 60_000,
  }).status;
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
  "failureCode" | "verificationBlockedReason" | "confinementBackends" | "verificationSummaries"
> {
  const settled = log.events.find(
    (event) => event.op === "coding-runtime.run.settled" && event.extra?.runId === runId,
  );
  return {
    failureCode: settled?.extra?.failureCode,
    verificationBlockedReason: settled?.extra?.verificationBlockedReason,
    confinementBackends: log.events
      .filter((event) => event.op === "runtime.confinement.spawned")
      .map((event) => event.extra?.backend),
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
  return {
    schemaVersion: 1,
    issue: 4492,
    platform: process.platform,
    arch: process.arch,
    darwinRelease: release(),
    node: process.versions.node,
    opencode: OPENCODE_PINNED_VERSION,
    userClass: groups().includes("admin") ? "administrator" : "standard",
    containerRuntime: { docker: onPath("docker"), podman: onPath("podman") },
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
