// #4492 (epic #4491): the acceptance task a person gives a Coding run, worked end to end on macOS
// through production composition only. A project's tests fail; the run reads the file, repairs it
// with the runtime's own `edit` and runs `npm test` in its own shell. That shell is a child of the
// runtime process Keiko spawned inside the Seatbelt boundary, and no container runtime is
// involved. The tester then checks the end state outside Keiko: the run's outcome, the project's
// own `npm test`, the untouched files outside `src/`, the number of checks the project itself
// counted and the Activity Log. The model is scripted (`test-support/functional-acceptance-model`),
// so this proves the product's part of the promise, not a model's skill; a real-model run of the
// same task closes the acceptance criteria. Proving each boundary statement from the model's own
// shell belongs to #4521.
//
// A third project (`maven-internal-repository`) has a Maven parent POM that only an internal
// repository serves, behind a login (#4492): the repository is played on loopback by
// `test-support/functional-maven-repository` and needs `npm run provision:acceptance-maven` once.
// The person's `settings.xml` names it as a mirror with the login in `<servers>`; Keiko admits only
// a sanitized copy of that file to a run (`nativeBuildSettings`), so these cases measure whether a
// run can build such a project at all.
//
// A fourth project (`npm-internal-registry`, #4530) depends on a package that only a registry behind
// a token serves; `test-support/functional-npm-registry` plays that registry on loopback. The
// person's `~/.npmrc` names it with the token; a run reaches it only through Keiko's repository
// credential relay (ADR-0184), in every autonomy mode, and the token never reaches what the run can
// read. The model installs the dependency in its own shell call, then runs the project's tests.
//
// Where `with-dependency` starts without its dependencies (#4522), the run calls Keiko's governed
// verifier, whose dependency installation for the run's own shell (ADR-0043 D17) fetches `semver`
// from the public npm registry through its registry egress proxy, without install scripts. Those
// cases, and only those, reach a registry outside this machine.
//
// Runs where the dev-lane functional suite runs: macOS with `KEIKO_OPENCODE_DEV_LANE_FUNCTIONAL=1`
// and the staged payload (`npm run dev:coding-runtime:stage`). Set `KEIKO_ACCEPTANCE_EVIDENCE_FILE`
// to keep the body-free evidence of every case (platform, user class, container runtime, versions
// and outcomes; no paths, no content), owner-private and outside the checkout.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { connect } from "node:net";
import { homedir, release, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
  functionalChatModelId,
  functionalPost,
  startFunctionalDiscoveryServer,
  type FunctionalDiscoveryServer,
} from "../test-support/functional-bff-server.js";
import type { WorkspaceLifecycleService } from "../task-workspace/types.js";
import type { CodingRuntimeOrchestrator } from "./codingRuntimeOrchestrator.js";
import { createCodingRuntimeSnapshotStore } from "./codingRuntimeSnapshotStore.js";
import { VERIFICATION_CONTINUATION_MAX } from "./codingRuntimeVerificationContinuation.js";
import { devLaneEnvEnabled } from "./devLanePortableCodingRuntime.js";
import { OPENCODE_PINNED_VERSION } from "./opencodeRuntimeVersions.js";
import {
  ACCEPTANCE_CHECK_COMMAND,
  ACCEPTANCE_MAVEN_CHECK_COMMAND,
  ACCEPTANCE_NPM_INSTALL_COMMAND,
  ACCEPTANCE_STALE_SUFFIX,
  acceptanceResponse,
  type AcceptanceGovernedCall,
  type AcceptanceModelScript,
} from "../test-support/functional-acceptance-model.js";
import {
  FUNCTIONAL_MAVEN_PASSWORD,
  FUNCTIONAL_MAVEN_USERNAME,
  mavenSettingsXml,
  startFunctionalMavenRepository,
  withPersonHome,
  writeMavenPersonSettings,
} from "../test-support/functional-maven-repository.js";
import {
  startFunctionalNpmRegistry,
  type FunctionalNpmRegistry,
} from "../test-support/functional-npm-registry.js";
import {
  createCredentialScanner,
  credentialSpellings,
  type CredentialFootprint,
} from "../test-support/credential-leak-scanner.js";
import {
  createFunctionalTaskWorkspaceOwners,
  provisionFunctionalTaskWorkspace,
  type FunctionalTaskWorkspaceOwners,
} from "../test-support/functional-task-workspace.js";
import type { ScriptState } from "./productionOpenCodeBackend.functional/_support.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURES = join(REPOSITORY_ROOT, "tests", "fixtures", "coding-acceptance");
/** The task text a person gives the run (tests/fixtures/coding-acceptance/README.md). */
const NODE_TASK =
  "The tests in this project fail. Find the cause in src/, fix it there and run npm test until it passes. Do not change the tests.";
const MAVEN_TASK =
  "The tests in this project fail. Find the cause in src/main, fix it there and run mvn -B -q test until it passes. Do not change the tests.";
const NPM_TASK =
  "The tests in this project fail. Find the cause in src/, fix it there, install the dependencies with npm install and run npm test until it passes. Do not change the tests.";
/** The internal npm registry's package, scoped on purpose: it takes the scoped tarball path. */
const NPM_REGISTRY_PACKAGE = "@acceptance/ledger";
const NPM_REGISTRY_PACKAGE_SOURCE =
  "module.exports = { formatCents: (cents) => (cents / 100).toFixed(2) };\n";
/** Built at run time: a credential-shaped literal in a new path would be flagged by gitleaks. */
const NPM_REGISTRY_TOKEN = ["npm", "token", "planted", "5521"].join("-");
const TERMINAL_STATES: ReadonlySet<CodingWorkbenchRuntimeStateName> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "taken-over",
  "recovery-required",
]);
/** The closed failure code for "no passing check after the final edit", whatever the cause. */
const NOT_VERIFIED = "verification-not-evidenced";
/**
 * Every `npm test` of a fixture appends one line here before its tests run
 * (`scripts/record-check.js`, ignored by Git): the project's own count of the checks, which the
 * tester compares with the checks the run reported.
 */
const CHECK_RECORD = ".acceptance-checks";
/**
 * What the run may change: the source. Everything else in the project, the installed
 * dependencies included, must stay byte for byte, with its mode and its link targets. Only the
 * project's Git metadata and its check record are left out, both at the project root. A Maven
 * project keeps its tests under `src/test`, so its source is `src/main` alone.
 *
 * A Maven build also writes its own output to `target/`. The project's own ignore file names it, so
 * it is no change to the project: only that ignored build output is left out of the comparison,
 * never a file the person keeps. The run and the tester each create it, and neither can avoid it.
 */
const SOURCE_DIRECTORIES: Readonly<Record<AcceptanceProject, string>> = {
  "no-dependencies": "src",
  "with-dependency": "src",
  "maven-internal-repository": "src/main",
  "npm-internal-registry": "src",
};
const BUILD_OUTPUT: Readonly<Record<AcceptanceProject, readonly string[]>> = {
  "no-dependencies": [],
  "with-dependency": [],
  "maven-internal-repository": ["target"],
  // The run installs the project's dependencies, so they and the lockfile npm writes are its output.
  "npm-internal-registry": ["node_modules", "package-lock.json"],
};

type AcceptanceProject =
  "no-dependencies" | "with-dependency" | "maven-internal-repository" | "npm-internal-registry";
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
  /**
   * The login the person's repository settings carry for the internal repository (the Maven
   * `settings.xml`, the npm `.npmrc` token); only those two projects have one. A wrong login lets
   * no build start, so the project counts no check.
   */
  readonly login?: "valid" | "wrong";
  /** #4519: where the run also calls Keiko's governed verifier beside its own shell check. */
  readonly governed?: AcceptanceGovernedCall;
  /**
   * #4519: Docker installed and not running, as the server process sees it: a `docker` client on
   * `PATH` that cannot reach its daemon, and `DOCKER_HOST` naming a socket file nobody serves.
   */
  readonly docker?: "stopped";
  /**
   * #4522: the project's committed lockfile no longer records what its `package.json` declares, as
   * after a manual edit of the manifest; Keiko's installation for the run's shell refuses it.
   */
  readonly lockfile?: "stale";
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
  /** The checks the project counted while the run worked, before the tester's own check. */
  readonly runCheckCount: number;
  /** Every file outside `src/` (the tests, `package.json`, the recorder) is byte-identical. */
  readonly outsideSourceUnchanged: boolean;
  readonly editLanded: boolean;
  readonly confinement: readonly ConfinementFacts[];
  readonly verificationSummaries: readonly string[];
  /** The states of the run's verification continuations, in order. */
  readonly continuations: readonly string[];
  /** The `coding-runtime.native-build-settings.admitted` dispositions of the run, in order. */
  readonly buildSettings: readonly BuildSettingsFacts[];
  /** What the internal repository answered while the run worked, by status code. */
  readonly repositoryRequests: Readonly<Record<string, number>>;
  /** The run's `coding-runtime.repository-relay` lines as `action:outcome:reason`, in order. */
  readonly relayLines: readonly string[];
  /**
   * The run's governed `coding-runtime.verification` lines as `state step…`, in order. A shell
   * check's `native-proof` line belongs to its shell command, not to the governed verifier.
   */
  readonly governedVerifications: readonly string[];
  /**
   * The run's `editor.verification.dependencies` lines as `consumer:state:reason:refused=N`, in
   * order (#4522): who the governed installation was for, how it ended, its closed refusal reason
   * and the destinations its egress proxy refused. Empty when Keiko attempted no installation.
   */
  readonly dependencyBootstraps: readonly string[];
  /** How often the server ran the stopped Docker's client; the `docker: "stopped"` cases only. */
  readonly dockerClientCalls?: number;
  /**
   * Where the person's repository login (#4522) appeared in what the run could read; Maven cases
   * only. It must never reach the run in any spelling; `settingsFilesScanned` keeps the scan from
   * being vacuous.
   */
  readonly credentialFootprint?: CredentialFootprint;
  readonly durationMs: number;
}

/** Closed dispositions of the sanitized build settings a run was admitted with. */
interface BuildSettingsFacts {
  readonly launchMode: unknown;
  readonly mavenSettings: unknown;
  readonly mavenCache: unknown;
  readonly relayMavenBoundCount: unknown;
  readonly relayNpmBoundCount: unknown;
  readonly relayRefusalReasons: unknown;
}

/** One case of the acceptance task and what it must show. */
interface AcceptanceExpectation {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCase: AcceptanceCase;
  readonly check: (observed: AcceptanceObservation) => void;
}

type EvidenceEntry =
  | {
      readonly caseId: string;
      readonly acceptanceCase: AcceptanceCase;
      readonly observed: AcceptanceObservation;
      readonly metExpectation: boolean;
    }
  | {
      readonly caseId: string;
      readonly acceptanceCase: AcceptanceCase;
      readonly harnessError: true;
    };

const TARGETS: Readonly<Record<AcceptanceProject, string>> = {
  "no-dependencies": "src/invoice.js",
  "with-dependency": "src/release.js",
  "maven-internal-repository": "src/main/java/com/example/invoice/Invoice.java",
  "npm-internal-registry": "src/statement.js",
};
const CHECK_COMMANDS: Readonly<Record<AcceptanceProject, string>> = {
  "no-dependencies": ACCEPTANCE_CHECK_COMMAND,
  "with-dependency": ACCEPTANCE_CHECK_COMMAND,
  "maven-internal-repository": ACCEPTANCE_MAVEN_CHECK_COMMAND,
  "npm-internal-registry": ACCEPTANCE_CHECK_COMMAND,
};

const roots: string[] = [];
const disposers: (() => Promise<void> | void)[] = [];
const evidence: EvidenceEntry[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Where the evidence goes, validated before any case runs so a bad target fails first. */
let evidenceTarget: string | undefined;

beforeAll(() => {
  const file = process.env.KEIKO_ACCEPTANCE_EVIDENCE_FILE;
  if (file === undefined || file === "") return;
  evidenceTarget = ownerPrivateEvidenceTarget(file);
});

afterAll(() => {
  if (evidenceTarget === undefined || evidence.length === 0) return;
  writeOwnerPrivate(evidenceTarget, `${JSON.stringify(acceptanceEvidence(), null, 2)}\n`);
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
    dependencies: dependenciesOf(project),
    check: "verify",
    expected: "succeeded",
    ...(hasRepositoryLogin(project) ? { login: "valid" as const } : {}),
  };
}

function dependenciesOf(project: AcceptanceProject): AcceptanceCase["dependencies"] {
  if (project === "with-dependency") return "installed";
  return project === "npm-internal-registry" ? "missing" : "none-needed";
}

function hasRepositoryLogin(project: AcceptanceProject): boolean {
  return project === "maven-internal-repository" || project === "npm-internal-registry";
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

const VERIFIED_MODES = ["supervised-coding", "autonomous-delivery", "governed-assist"] as const;

/** The `coding-runtime.verification` line of a governed test verifier refused for want of isolation. */
const ISOLATION_REFUSED = "not-run test:isolation-unavailable";

const ACCEPTANCE_CASES: readonly AcceptanceExpectation[] = [
  ...VERIFIED_MODES.map((mode): AcceptanceExpectation => ({
    id: `verify-${mode}`,
    title: `repairs the defect and verifies it with the project's own tests in ${mode}`,
    acceptanceCase: verified("no-dependencies", mode),
    check: (observed): void => {
      expectVerifiedInMode(observed, mode);
    },
  })),
  {
    id: "wrong-fix",
    title: "never reports success for an edit that leaves the tests red",
    acceptanceCase: unverified("supervised-coding", "wrong", "verify"),
    check: (observed): void => {
      expectNotVerified(observed, "supervised-coding", { testsPassOutsideKeiko: false });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:failed"]);
    },
  },
  // The other three never-a-pass cases use the right fix, so the project's tests pass when the
  // tester runs them; the outcome must still follow what the run itself verified.
  {
    id: "skip-check",
    title: "never reports success when the run skips its check after the edit",
    acceptanceCase: unverified("supervised-coding", "fixed", "skip-check"),
    check: (observed): void => {
      expectNotVerified(observed, "supervised-coding", { testsPassOutsideKeiko: true });
      expect(observed.verificationSummaries).toEqual(["test:failed"]);
    },
  },
  {
    id: "stale-check",
    title: "never counts a check that passed before the final edit",
    acceptanceCase: unverified("autonomous-delivery", "fixed", "stale-check"),
    check: (observed): void => {
      expectNotVerified(observed, "autonomous-delivery", { testsPassOutsideKeiko: true });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:passed"]);
    },
  },
  {
    id: "denied-check",
    title: "never reports success when the person denies the check after the edit",
    acceptanceCase: unverified("governed-assist", "fixed", "denied"),
    check: (observed): void => {
      expectNotVerified(observed, "governed-assist", {
        testsPassOutsideKeiko: true,
        continued: false,
      });
      expect(observed.verificationSummaries).toEqual(["test:failed"]);
      expect(observed.verificationBlockedReason).toBe("verification-command-denied");
      expect([observed.approvalCount, observed.denialCount]).toEqual([2, 1]);
    },
  },
  // #4519: the person's own folder, where the dependencies are already installed, in every mode;
  // with the managed-worktree cases above, both work locations are covered in all three.
  ...VERIFIED_MODES.map((mode): AcceptanceExpectation => ({
    id: `dependency-own-folder-${mode}`,
    title: `verifies a project whose dependencies are installed in the person's own folder in ${mode}`,
    acceptanceCase: verified("with-dependency", mode, "own-folder"),
    check: (observed): void => {
      expectVerifiedInMode(observed, mode);
    },
  })),
  // #4522: a managed task worktree is a fresh checkout without `node_modules`, and below Full
  // access the run's shell reaches no public registry. The run asks Keiko's governed verifier,
  // which installs the declared dependencies for that shell on this host (ADR-0043 D17) and still
  // runs none of the project's commands; the shell then runs the check. In every mode, in both
  // work locations; each of these cases ended not verified before the change.
  ...VERIFIED_MODES.flatMap((mode) =>
    (["managed-worktree", "own-folder"] as const).map((workspace): AcceptanceExpectation => ({
      id: `dependency-installed-by-keiko-${workspace}-${mode}`,
      title: `verifies a project after Keiko installed its missing dependencies in the ${workspace} in ${mode}`,
      acceptanceCase: {
        ...verified("with-dependency", mode, workspace),
        dependencies: "missing",
        governed: "before-edit",
      },
      check: (observed): void => {
        expectVerifiedInMode(observed, mode, 1);
        expect(observed.governedVerifications).toEqual([ISOLATION_REFUSED]);
        expect(observed.dependencyBootstraps).toEqual(["host-shell:installed:-:refused=0"]);
      },
    })),
  ),
  // #4519 on the install path: Keiko attempts the installation for the run's shell and refuses it
  // (here: a lockfile that no longer records the manifest). The run hears why, its check stays red
  // and it must end not verified, never succeeded.
  {
    id: "dependency-install-refused",
    title:
      "does not report success when Keiko refuses to install a managed worktree's dependencies",
    acceptanceCase: {
      ...verified("with-dependency", "supervised-coding"),
      dependencies: "missing",
      governed: "before-edit",
      lockfile: "stale",
      expected: "not-succeeded",
    },
    check: (observed): void => {
      // The governed call failed on its refused installation and ran no check of the project, so
      // the project counts only the two shell checks.
      expectNotVerified(observed, "supervised-coding", {
        testsPassOutsideKeiko: false,
        projectCheckCount: 2,
      });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:failed", "test:failed"]);
      expect(observed.governedVerifications).toEqual([]);
      expect(observed.dependencyBootstraps).toEqual([
        "host-shell:refused:lockfile-mismatch:refused=-",
      ]);
    },
  },
  // The control: a run that never asks Keiko still cannot load the dependency below Full access,
  // so its tests stay red and it must say so honestly rather than succeed.
  {
    id: "dependency-missing-worktree",
    title: "does not report success while a managed worktree lacks the project's dependencies",
    acceptanceCase: {
      ...verified("with-dependency", "supervised-coding"),
      dependencies: "missing",
      expected: "not-succeeded",
    },
    check: (observed): void => {
      expectNotVerified(observed, "supervised-coding", { testsPassOutsideKeiko: false });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:failed"]);
      expect(observed.dependencyBootstraps).toEqual([]);
    },
  },
  // #4519: Keiko's governed verifier needs an enforcing isolation backend, which a Mac without a
  // running container runtime does not have, so it runs none of the project's commands. In the
  // native profile that refusal does not block the run: its own shell check is the verification.
  {
    id: "governed-refused-then-shell",
    title: "verifies through its shell check after the governed verifier is refused for isolation",
    acceptanceCase: { ...verified("no-dependencies", "supervised-coding"), governed: "after-edit" },
    check: (observed): void => {
      expectVerifiedInMode(observed, "supervised-coding");
      expect(observed.governedVerifications).toEqual([ISOLATION_REFUSED]);
    },
  },
  {
    id: "shell-failed-then-governed-refused",
    title:
      "never reports success for a failing shell check followed by a refused governed verifier",
    acceptanceCase: {
      ...unverified("supervised-coding", "wrong", "verify"),
      governed: "after-check",
    },
    check: (observed): void => {
      // The refusal leaves the failing shell check the run's last word: Keiko still sends the
      // model back to repair it and never settles the run as blocked by the refused verifier.
      expectNotVerified(observed, "supervised-coding", { testsPassOutsideKeiko: false });
      expect(observed.governedVerifications).toEqual([ISOLATION_REFUSED]);
      expect(observed.verificationBlockedReason).toBeUndefined();
    },
  },
  {
    id: "docker-stopped",
    title: "verifies through its shell check while Docker is installed and not running",
    acceptanceCase: {
      ...verified("no-dependencies", "supervised-coding"),
      governed: "after-edit",
      docker: "stopped",
    },
    check: (observed): void => {
      expectVerifiedInMode(observed, "supervised-coding");
      expect(observed.governedVerifications).toEqual([ISOLATION_REFUSED]);
      // The leftover socket answers no connection, so Keiko never hands a step to the stopped
      // engine's client: a step it ran there would fail as if the project's own check had failed.
      expect(observed.dockerClientCalls).toBe(0);
    },
  },
  // #4519: a governed verifier that attempted no installation must not tell the run that one
  // failed. Since #4522 it installs for the run's shell wherever the dependencies are missing, so
  // the case where it attempts none is a folder whose tree Keiko did not install: it leaves that
  // tree alone, says so on its own line (nothing installed), and the run hears only the isolation
  // refusal.
  {
    id: "dependency-foreign-tree-left-alone",
    title: "leaves a tree Keiko did not install alone and reports no failed installation",
    acceptanceCase: { ...verified("with-dependency", "supervised-coding"), governed: "after-edit" },
    check: (observed): void => {
      expectVerifiedInMode(observed, "supervised-coding");
      expect(observed.governedVerifications).toEqual([ISOLATION_REFUSED]);
      expect(observed.dependencyBootstraps).toEqual(["host-shell:none:-:refused=-"]);
    },
  },
  // #4492: a Maven project whose parent POM only an internal repository serves, behind a login the
  // person keeps in their own `settings.xml`. A run must build it in every mode like any other
  // project. Keiko's sanitized run settings drop `<servers>`: below Full access Maven runs offline,
  // at Full access it has no login and the repository answers 401.
  ...VERIFIED_MODES.map((mode): AcceptanceExpectation => ({
    id: `maven-${mode}`,
    title: `repairs a maven project whose parent POM needs the internal repository's login in ${mode}`,
    acceptanceCase: verified("maven-internal-repository", mode),
    check: (observed): void => {
      expectVerifiedInMode(observed, mode);
      expectLoginNeverReachedTheRun(observed);
    },
  })),
  // The negative control of the login: a wrong password must never become a pass. It runs at Full
  // access, the one mode where the build goes online, so the repository is asked and answers 401
  // (below Full access Maven is offline and would never ask). The build cannot start, so the
  // project counts no check; the tester's own login is right, so its build passes.
  {
    id: "maven-wrong-password",
    title: "never reports success for a maven project when the person's login is wrong",
    acceptanceCase: {
      ...verified("maven-internal-repository", "autonomous-delivery"),
      login: "wrong",
      expected: "not-succeeded",
    },
    check: (observed): void => {
      expectNotVerified(observed, "autonomous-delivery", {
        testsPassOutsideKeiko: true,
        projectCheckCount: 0,
      });
      expect(observed.verificationSummaries).toEqual(["test:failed", "test:failed"]);
      // The login was actually tried: the repository answered the run, and never with a 200.
      expect(observed.repositoryRequests["401"] ?? 0, JSON.stringify(observed)).toBeGreaterThan(0);
      expect(observed.repositoryRequests["200"], JSON.stringify(observed)).toBeUndefined();
      expectLoginNeverReachedTheRun(observed);
    },
  },
  // #4530: an npm project whose dependency only an internal registry serves, behind a token the
  // person keeps in their own `.npmrc`. Keiko binds that registry to its repository credential
  // relay, so the run's `npm install` reaches it in every mode with a capability and never the
  // token. Below Full access npm's offline setting must not stop that install.
  ...VERIFIED_MODES.map((mode): AcceptanceExpectation => ({
    id: `npm-${mode}`,
    title: `repairs an npm project whose dependency needs the internal registry's token in ${mode}`,
    acceptanceCase: verified("npm-internal-registry", mode),
    check: (observed): void => {
      expectVerifiedInMode(observed, mode);
      expect(observed.verificationSummaries, JSON.stringify(observed)).toEqual(["test:passed"]);
      // The registry answered the run's install and never refused it.
      expect(observed.repositoryRequests["200"] ?? 0, JSON.stringify(observed)).toBeGreaterThan(0);
      expect(observed.repositoryRequests["401"], JSON.stringify(observed)).toBeUndefined();
      expectLoginNeverReachedTheRun(observed);
    },
  })),
  // The negative control of the token: a wrong token must never become a pass. The registry is
  // asked through the relay and answers 401 to every request; the install fails, so the project
  // has no dependency, its check fails and the tester's own check fails too.
  {
    id: "npm-wrong-token",
    title: "never reports success for an npm project when the person's token is wrong",
    acceptanceCase: {
      ...verified("npm-internal-registry", "supervised-coding"),
      login: "wrong",
      expected: "not-succeeded",
    },
    check: (observed): void => {
      expectNotVerified(observed, "supervised-coding", { testsPassOutsideKeiko: false });
      expect(observed.verificationSummaries).toEqual(["test:failed"]);
      expect(observed.repositoryRequests["401"] ?? 0, JSON.stringify(observed)).toBeGreaterThan(0);
      expect(observed.repositoryRequests["200"], JSON.stringify(observed)).toBeUndefined();
      expectLoginNeverReachedTheRun(observed);
    },
  },
];

describe.skipIf(!acceptanceEnabled())(
  "Coding acceptance task on macOS without a container runtime (#4492)",
  () => {
    for (const expectation of ACCEPTANCE_CASES) {
      it(
        expectation.title,
        async () => {
          await runAcceptanceCase(expectation);
        },
        240_000,
      );
    }
  },
);

/** The scan saw the run's own settings, and found the person's login in none of what it read. */
function expectLoginNeverReachedTheRun(observed: AcceptanceObservation): void {
  const context = JSON.stringify(observed.credentialFootprint);
  expect(observed.credentialFootprint?.settingsFilesScanned, context).toBeGreaterThan(0);
  expect(observed.credentialFootprint?.leakedFileCount, context).toBe(0);
  expect(observed.credentialFootprint?.leakedLogLineCount, context).toBe(0);
}

function expectVerifiedInMode(
  observed: AcceptanceObservation,
  mode: AcceptanceMode,
  governedCalls = 0,
): void {
  expectSucceeded(observed, mode);
  // Ask for approval asks before each command and before the edit: the failing check, the
  // edit, the passing check, and each governed verifier call. The other modes ask for none of
  // this workspace-contained work.
  expect(observed.approvalCount).toBe(mode === "governed-assist" ? 3 + governedCalls : 0);
  expect(observed.denialCount).toBe(0);
}

function expectSucceeded(observed: AcceptanceObservation, mode: AcceptanceMode): void {
  const context = JSON.stringify(observed);
  expect(observed.state, context).toBe("succeeded");
  expect(observed.settledState, context).toBe("succeeded");
  expect(observed.editLanded, context).toBe(true);
  expect(observed.testerCheckExitCode, context).toBe(0);
  expect(observed.verificationSummaries.at(-1), context).toBe("test:passed");
  // A run that verified its edit needs no nudge to do so.
  expect(observed.continuations, context).toEqual([]);
  expectEveryCase(observed, mode);
}

function expectNotVerified(
  observed: AcceptanceObservation,
  mode: AcceptanceMode,
  expected: {
    readonly testsPassOutsideKeiko: boolean;
    readonly continued?: boolean;
    readonly projectCheckCount?: number;
  },
): void {
  const context = JSON.stringify(observed);
  expect(observed.state, context).toBe("failed");
  expect(observed.settledState, context).toBe("failed");
  expect(observed.failureCode, context).toBe(NOT_VERIFIED);
  expect(observed.editLanded, context).toBe(true);
  if (expected.testsPassOutsideKeiko) expect(observed.testerCheckExitCode, context).toBe(0);
  else expect(observed.testerCheckExitCode, context).toBeGreaterThan(0);
  // Before it gives up, the product sends the model back to verify, up to its bound; a check the
  // person denied blocks that continuation. Either way the run ends not evidenced.
  expect(VERIFICATION_CONTINUATION_MAX).toBeGreaterThan(0);
  const continued = expected.continued === false ? 0 : VERIFICATION_CONTINUATION_MAX;
  expect(observed.continuations, context).toEqual([
    ...Array.from({ length: continued }, () => "continued"),
    "not-evidenced",
  ]);
  expectEveryCase(observed, mode, expected.projectCheckCount);
}

/**
 * What holds in every case, whatever its outcome: the run changed nothing outside its source,
 * every check it reported is one the project itself counted, and its runtime ran inside the
 * boundary. A build that could not start (no login) is the one case where the project counts
 * fewer checks than the run reported: `projectCheckCount` names that number. A governed check the
 * host refused ran nothing, so its summary is no check the project could count.
 */
function expectEveryCase(
  observed: AcceptanceObservation,
  mode: AcceptanceMode,
  projectCheckCount?: number,
): void {
  const context = JSON.stringify(observed);
  const refusedGoverned = observed.governedVerifications.filter((line) =>
    line.startsWith("not-run "),
  ).length;
  expect(observed.outsideSourceUnchanged, context).toBe(true);
  expect(observed.runCheckCount, context).toBe(
    projectCheckCount ?? observed.verificationSummaries.length - refusedGoverned,
  );
  expectNativeConfinement(observed, mode);
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

/** The internal repository and the two homes a Maven or npm case needs, besides the run's own. */
interface RepositorySurroundings {
  /** The requests the repository answered so far, by status code. */
  readonly statusCounts: () => Readonly<Record<string, number>>;
  /** The home whose `.m2/settings.xml` or `.npmrc` is the person's: the run's build settings read it. */
  readonly personHome: string;
  /** The tester's own home, whose Maven settings always carry the right login. */
  readonly testerHome: string;
}

interface PreparedAcceptanceCase {
  readonly root: string;
  readonly surroundings?: RepositorySurroundings;
  readonly owners: FunctionalTaskWorkspaceOwners;
  /** The folder the run works in, which the tester checks afterwards. */
  readonly runRoot: string;
  readonly lifecycle: WorkspaceLifecycleService;
  readonly store?: ReturnType<typeof createInMemoryUiStore>;
  readonly original: string;
  readonly replacement: string;
}

async function runAcceptanceCase(expectation: AcceptanceExpectation): Promise<void> {
  const { id: caseId, acceptanceCase } = expectation;
  let observed: AcceptanceObservation;
  try {
    observed = await observeAcceptanceCase(acceptanceCase);
  } catch (error) {
    // The case did not complete; its record says so without the error's text.
    evidence.push({ caseId, acceptanceCase, harnessError: true });
    throw error;
  }
  try {
    expectation.check(observed);
  } catch (error) {
    evidence.push({ caseId, acceptanceCase, observed, metExpectation: false });
    throw error;
  }
  evidence.push({ caseId, acceptanceCase, observed, metExpectation: true });
}

async function observeAcceptanceCase(
  acceptanceCase: AcceptanceCase,
): Promise<AcceptanceObservation> {
  const prepared = await prepareAcceptanceCase(acceptanceCase);
  const target = join(prepared.runRoot, TARGETS[acceptanceCase.project]);
  // The precondition: the project's own tests fail before the run.
  expect(await testerCheck(acceptanceCase, prepared)).toBeGreaterThan(0);
  // ... and it fails because the project's tests ran and failed, not because the build died first.
  expect(recordedChecks(prepared.runRoot)).toBe(1);
  const checksBefore = recordedChecks(prepared.runRoot);
  const outsideSourceBefore = outsideSourceDigest(acceptanceCase, prepared.runRoot);
  const requestsBefore = prepared.surroundings?.statusCounts() ?? {};
  const script = acceptanceScript(acceptanceCase, prepared);
  const log = recordActivityLog();
  const footprint = credentialScanner(prepared, acceptanceCase);
  const startedAt = Date.now();
  // The run's build settings read the home of the process that composes the server, so a Maven
  // case holds the person's home around the run alone and puts the real one back afterwards.
  const run = await aroundRun(prepared, acceptanceCase, async () => {
    const served = await serveAcceptance(prepared, script);
    const runId = await startAcceptanceRun(served, acceptanceCase);
    const editDone = (): boolean => readFileSync(target, "utf8") !== prepared.original;
    const asks = await settleAnsweringEveryAsk(
      served.orchestrator,
      runId,
      () => (acceptanceCase.check === "denied" && editDone() ? "denied" : "approved"),
      footprint.scan,
    );
    footprint.scan();
    return { runId, asks, state: served.orchestrator.getSnapshot(runId)?.state };
  });
  const { runId, asks } = run;
  const requestsAfter = prepared.surroundings?.statusCounts() ?? {};
  const finalContent =
    acceptanceCase.check === "stale-check"
      ? `${prepared.replacement}${ACCEPTANCE_STALE_SUFFIX}`
      : prepared.replacement;
  // Counted before the tester's own check, which the recorder counts too.
  const runCheckCount = recordedChecks(prepared.runRoot) - checksBefore;
  return {
    ...settledFacts(log, runId),
    state: run.state,
    approvalCount: asks.approved,
    denialCount: asks.denied,
    runCheckCount,
    repositoryRequests: requestDifference(requestsBefore, requestsAfter),
    ...(prepared.surroundings === undefined ? {} : { credentialFootprint: footprint.result(log) }),
    testerCheckExitCode: await testerCheck(acceptanceCase, prepared),
    outsideSourceUnchanged:
      outsideSourceDigest(acceptanceCase, prepared.runRoot) === outsideSourceBefore,
    editLanded: readFileSync(target, "utf8") === finalContent,
    ...(acceptanceCase.docker === undefined
      ? {}
      : { dockerClientCalls: dockerClientCalls(prepared.root) }),
    durationMs: Date.now() - startedAt,
  };
}

/** Homes the login is written to on purpose: the person's, and the tester's own. */
const CREDENTIAL_HOMES = new Set(["person-home", "tester-home"]);

/**
 * Looks for the person's login in everything the run can read: the case's state and the task
 * workspace (both below the case's root, which the run's private home and state root are part of),
 * sampled while the run lives because its state root is removed when it ends. The spellings it
 * knows, and the proof that it reports each of them, are `credential-leak-scanner.test.ts`.
 */
function credentialScanner(
  prepared: PreparedAcceptanceCase,
  acceptanceCase: AcceptanceCase,
): {
  readonly scan: () => void;
  readonly result: (log: BufferedServerLogSink) => CredentialFootprint;
} {
  const npm = acceptanceCase.project === "npm-internal-registry";
  const scanner = createCredentialScanner({
    root: prepared.root,
    spellings: loginSpellings(acceptanceCase),
    skipDirectories: CREDENTIAL_HOMES,
    // The run's own copy of the person's settings: Maven's, or the npm user config the relay binds.
    settingsSuffix: npm ? join("config", "npm-user-config") : join(".m2", "settings.xml"),
  });
  return {
    scan: (): void => {
      if (prepared.surroundings !== undefined) scanner.scan();
    },
    result: (log) => scanner.result(log.events),
  };
}

/** The secret the person's own settings hold for the case, in every spelling a leak could take. */
function loginSpellings(acceptanceCase: AcceptanceCase): readonly string[] {
  if (acceptanceCase.login === undefined) return [];
  const wrong = acceptanceCase.login === "wrong";
  if (acceptanceCase.project === "npm-internal-registry") {
    return credentialSpellings(wrong ? `${NPM_REGISTRY_TOKEN}-wrong` : NPM_REGISTRY_TOKEN);
  }
  const password = wrong ? `${FUNCTIONAL_MAVEN_PASSWORD}-wrong` : FUNCTIONAL_MAVEN_PASSWORD;
  return credentialSpellings(password, FUNCTIONAL_MAVEN_USERNAME);
}

/** What a case holds around its run alone: the person's home, a stopped Docker installation. */
function aroundRun<T>(
  prepared: PreparedAcceptanceCase,
  acceptanceCase: AcceptanceCase,
  work: () => Promise<T>,
): Promise<T> {
  const inHome = (): Promise<T> => withPersonHomeOf(prepared, work);
  return acceptanceCase.docker === "stopped" ? withStoppedDocker(prepared.root, inHome) : inHome();
}

const DOCKER_CALLS_FILE = "docker-calls";

/**
 * Docker installed and not running, as the server process sees it for the length of one run: its
 * client first on `PATH`, answering as the real client does when no daemon serves its socket, and
 * `DOCKER_HOST` naming a socket file left behind by a process that is gone. Short names: a Unix
 * socket path has at most 104 bytes on macOS.
 */
async function withStoppedDocker<T>(root: string, work: () => Promise<T>): Promise<T> {
  const bin = join(root, "docker-bin");
  const socket = join(root, "d.sock");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/bin/sh",
      `echo call >> '${join(root, DOCKER_CALLS_FILE)}'`,
      `echo 'Cannot connect to the Docker daemon at unix://${socket}. Is the docker daemon running?' >&2`,
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  leaveStaleSocket(socket);
  await expectConnectionRefused(socket);
  const saved = { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST };
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
  process.env.DOCKER_HOST = `unix://${socket}`;
  try {
    return await work();
  } finally {
    restoreEnv("PATH", saved.PATH);
    restoreEnv("DOCKER_HOST", saved.DOCKER_HOST);
  }
}

/** A socket file whose process exited without closing it: the file stays, nobody serves it. */
function leaveStaleSocket(socket: string): void {
  const listener =
    "require('node:net').createServer().listen(process.argv.at(-1), () => process.exit(0));";
  const result = spawnSync(process.execPath, ["-e", listener, socket], { timeout: 10_000 });
  if (result.status !== 0 || !lstatSync(socket).isSocket()) {
    throw new Error("acceptance-precondition-stale-socket");
  }
}

function expectConnectionRefused(socket: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const client = connect(socket);
    client.once("connect", () => {
      client.destroy();
      reject(new Error("acceptance-precondition-socket-served"));
    });
    client.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolvePromise();
      else reject(error);
    });
  });
}

function restoreEnv(name: "PATH" | "DOCKER_HOST", value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function dockerClientCalls(root: string): number {
  const file = join(root, DOCKER_CALLS_FILE);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

function withPersonHomeOf<T>(prepared: PreparedAcceptanceCase, work: () => Promise<T>): Promise<T> {
  return prepared.surroundings === undefined
    ? work()
    : withPersonHome(prepared.surroundings.personHome, work);
}

/** The requests the repository answered between two readings of its counters, by status. */
function requestDifference(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.entries(after)
      .map(([status, count]): [string, number] => [status, count - (before[status] ?? 0)])
      .filter(([, count]) => count > 0),
  );
}

function acceptanceScript(
  acceptanceCase: AcceptanceCase,
  prepared: PreparedAcceptanceCase,
): AcceptanceModelScript {
  return {
    modelId: functionalChatModelId(),
    target: TARGETS[acceptanceCase.project],
    checkCommand: CHECK_COMMANDS[acceptanceCase.project],
    old: prepared.original,
    next: prepared.replacement,
    plan:
      acceptanceCase.check === "skip-check" || acceptanceCase.check === "stale-check"
        ? acceptanceCase.check
        : "verify",
    ...(acceptanceCase.project === "npm-internal-registry"
      ? { installCommand: ACCEPTANCE_NPM_INSTALL_COMMAND }
      : {}),
    ...(acceptanceCase.governed === undefined
      ? {}
      : { governedVerification: acceptanceCase.governed }),
  };
}

/**
 * The functional script the composition requires. The acceptance model answers every
 * coding-sidecar call in its place, so this script is never asked.
 */
const UNUSED_FUNCTIONAL_SCRIPT: ScriptState = { mode: "productive", calls: 0, old: "", next: "" };

async function prepareAcceptanceCase(
  acceptanceCase: AcceptanceCase,
): Promise<PreparedAcceptanceCase> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-acceptance-")));
  roots.push(root);
  const repository = join(root, "repository");
  cpSync(join(FIXTURES, acceptanceCase.project), repository, { recursive: true });
  if (acceptanceCase.lockfile === "stale") writeStaleLockfile(repository);
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
  // A case without its dependencies must start without them, or a pass could come from a leftover
  // install instead of the run's own (#4530 item 5).
  if (acceptanceCase.dependencies === "missing" && existsSync(join(runRoot, "node_modules")))
    throw new Error("acceptance-precondition-node-modules-present");
  const target = TARGETS[acceptanceCase.project];
  const surroundings = await prepareRepositorySurroundings(root, acceptanceCase);
  return {
    root,
    ...(surroundings === undefined ? {} : { surroundings }),
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
  const name = target.replace(/\.(js|java)$/u, `.${acceptanceCase.variant}.$1`);
  return join(FIXTURES, "variants", acceptanceCase.project, name);
}

/**
 * The internal repository and the homes of a Maven case: the person's `settings.xml` names the
 * repository as a mirror with its login in `<servers>` (a wrong password for the wrong-login case),
 * and the tester's own home always carries the right login.
 */
async function prepareRepositorySurroundings(
  root: string,
  acceptanceCase: AcceptanceCase,
): Promise<RepositorySurroundings | undefined> {
  if (acceptanceCase.login === undefined) return undefined;
  if (acceptanceCase.project === "npm-internal-registry") {
    return prepareNpmSurroundings(root, acceptanceCase.login);
  }
  const repository = await startFunctionalMavenRepository();
  disposers.push(repository.close);
  const personHome = join(root, "person-home");
  const testerHome = join(root, "tester-home");
  const right = mavenSettingsXml({ url: repository.url });
  const person =
    acceptanceCase.login === "valid"
      ? right
      : mavenSettingsXml({ url: repository.url, password: `${FUNCTIONAL_MAVEN_PASSWORD}-wrong` });
  writeMavenPersonSettings(personHome, person);
  writeMavenPersonSettings(testerHome, right);
  return { statusCounts: repository.statusCounts, personHome, testerHome };
}

/**
 * The internal npm registry, and the person's `~/.npmrc` that names it for its scope with the token
 * (a wrong token for the wrong-login case). The tester's check needs no registry: the run installed
 * the dependency, or the check must fail.
 */
async function prepareNpmSurroundings(
  root: string,
  login: "valid" | "wrong",
): Promise<RepositorySurroundings> {
  const registry: FunctionalNpmRegistry = await startFunctionalNpmRegistry({
    packageName: NPM_REGISTRY_PACKAGE,
    token: NPM_REGISTRY_TOKEN,
    moduleSource: NPM_REGISTRY_PACKAGE_SOURCE,
  });
  disposers.push(registry.close);
  const personHome = join(root, "person-home");
  const testerHome = join(root, "tester-home");
  const token = login === "valid" ? NPM_REGISTRY_TOKEN : `${NPM_REGISTRY_TOKEN}-wrong`;
  const scope = NPM_REGISTRY_PACKAGE.split("/", 1)[0] ?? "";
  mkdirSync(personHome, { recursive: true });
  writeFileSync(
    join(personHome, ".npmrc"),
    `${scope}:registry=${registry.url}/\n//${new URL(registry.url).host}/:_authToken=${token}\n`,
    { mode: 0o600 },
  );
  return { statusCounts: registry.statusCounts, personHome, testerHome };
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
// The person's own install, as npm leaves it: the package and npm's hidden lockfile, which npm
// writes last and by which Keiko tells an installed tree from an empty or partial folder (#4522).
function installSemver(folder: string): void {
  const source = join(REPOSITORY_ROOT, "node_modules", "semver");
  cpSync(source, join(folder, "node_modules", "semver"), { recursive: true });
  const { version } = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
    readonly version: string;
  };
  writeFileSync(
    join(folder, "node_modules", ".package-lock.json"),
    `${JSON.stringify(
      {
        name: "keiko-acceptance-release",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "node_modules/semver": {
            version,
            resolved: `https://registry.npmjs.org/semver/-/semver-${version}.tgz`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

// A lockfile whose root entry records none of the dependencies the manifest declares.
function writeStaleLockfile(repository: string): void {
  writeFileSync(
    join(repository, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "keiko-acceptance-release",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "keiko-acceptance-release", version: "1.0.0" } },
      },
      null,
      2,
    )}\n`,
  );
}

async function serveAcceptance(
  prepared: PreparedAcceptanceCase,
  script: AcceptanceModelScript,
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
    script: UNUSED_FUNCTIONAL_SCRIPT,
    respond: (request) => acceptanceResponse(script, request),
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
    requestId: `acceptance-${acceptanceCase.project}-${acceptanceCase.mode}-${String(acceptanceCase.login)}`,
    taskIntent: taskOf(acceptanceCase.project),
    requestedMode: acceptanceCase.mode,
  });
  const text = await started.clone().text();
  expect(started.status, text).toBe(200);
  const run = (await started.json()) as { readonly runId: string; readonly state: string };
  expect(run.state, text).toBe("running");
  return run.runId;
}

function taskOf(project: AcceptanceProject): string {
  if (project === "maven-internal-repository") return MAVEN_TASK;
  return project === "npm-internal-registry" ? NPM_TASK : NODE_TASK;
}

/** Waits for the run to settle, answering every ask the way the person in front of it would. */
async function settleAnsweringEveryAsk(
  orchestrator: CodingRuntimeOrchestrator,
  runId: string,
  decide: () => "approved" | "denied",
  onPoll: () => void = () => undefined,
): Promise<{ readonly approved: number; readonly denied: number }> {
  const answered = { approved: 0, denied: 0 };
  await vi.waitFor(
    async () => {
      onPoll();
      const snapshot = orchestrator.getSnapshot(runId);
      const pending = snapshot?.pendingPermission;
      if (snapshot?.state === "awaiting-approval" && pending !== undefined) {
        const decision = decide();
        const result = await orchestrator.decideApproval(runId, {
          requestId: pending.requestId,
          decision,
          expectedRevision: snapshot.revision,
        });
        // A decision the orchestrator refused (a newer revision) is not an answer; the next
        // poll answers the ask again.
        if (result.ok) answered[decision] += 1;
      }
      expect(TERMINAL_STATES.has(orchestrator.getSnapshot(runId)?.state ?? "idle")).toBe(true);
    },
    { timeout: 200_000, interval: 200 },
  );
  return answered;
}

/**
 * The tester's own check, outside Keiko, in the folder the run worked in. A Maven check runs with
 * a home of its own whose `settings.xml` carries the right login, whatever the person's file says.
 */
async function testerCheck(
  acceptanceCase: AcceptanceCase,
  prepared: PreparedAcceptanceCase,
): Promise<number> {
  const [program = "npm", ...args] = CHECK_COMMANDS[acceptanceCase.project].split(" ");
  // Asynchronous on purpose: the internal repository answers from this very process, which a
  // synchronous spawn would block while Maven waits for it.
  const outcome = await new Promise<{ status: number | null; signal: string | null }>(
    (settled, failed) => {
      const child = spawn(program, args, {
        cwd: prepared.runRoot,
        env: testerEnvironment(acceptanceCase.project, prepared),
        stdio: "ignore",
        timeout: acceptanceCase.project === "maven-internal-repository" ? 180_000 : 60_000,
      });
      child.once("error", failed);
      child.once("close", (status, signal) => {
        settled({ status, signal });
      });
    },
  );
  // A check that could not run (no `npm`, no `mvn`, a timeout, a signal) has no exit code; it is
  // never a red result and never a green one.
  if (typeof outcome.status !== "number") {
    throw new TypeError(`acceptance-tester-check-did-not-run:${String(outcome.signal)}`);
  }
  return outcome.status;
}

function testerEnvironment(
  project: AcceptanceProject,
  prepared: PreparedAcceptanceCase,
): Record<string, string> {
  if (prepared.surroundings === undefined || project !== "maven-internal-repository") {
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      npm_config_offline: "true",
    };
  }
  // Java takes `user.home` from the account, not from `HOME`: Maven finds the tester's settings
  // and local repository only when the property is set as well.
  return {
    PATH: process.env.PATH ?? "",
    HOME: prepared.surroundings.testerHome,
    MAVEN_OPTS: `-Duser.home=${prepared.surroundings.testerHome}`,
    ...(process.env.JAVA_HOME === undefined ? {} : { JAVA_HOME: process.env.JAVA_HOME }),
  };
}

/** The checks the project's recorder counted in `folder` so far. */
function recordedChecks(folder: string): number {
  const record = join(folder, CHECK_RECORD);
  if (!existsSync(record)) return 0;
  return readFileSync(record, "utf8")
    .split("\n")
    .filter((line) => line !== "").length;
}

/**
 * A digest of every entry outside `src/`, in a stable order: its relative path, its kind and
 * mode, and its bytes or, for a symbolic link, its target.
 */
function outsideSourceDigest(acceptanceCase: AcceptanceCase, folder: string): string {
  const hash = createHash("sha256");
  const { project } = acceptanceCase;
  const source = SOURCE_DIRECTORIES[project];
  const ignored: ReadonlySet<string> = new Set([
    ".git",
    CHECK_RECORD,
    ...BUILD_OUTPUT[project],
    ...installOutput(acceptanceCase),
  ]);
  const visit = (directory: string, prefix: string): void => {
    const names = readdirSync(directory).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (path === source || (prefix === "" && ignored.has(name))) continue;
      const full = join(directory, name);
      const entry = lstatSync(full);
      hash.update(`${path}\0${String(entry.mode)}\0`);
      if (entry.isDirectory()) visit(full, path);
      else hash.update(entry.isSymbolicLink() ? readlinkSync(full) : readFileSync(full));
      hash.update("\0");
    }
  };
  visit(folder, "");
  return hash.digest("hex");
}

/**
 * What Keiko's governed installation may add to a `with-dependency` folder that starts without its
 * dependencies (#4522): the installed tree, which the project's own ignore file names. A lockfile
 * is not on this list: that installation writes none (`--no-save`), so a new `package-lock.json`
 * fails the comparison.
 */
function installOutput(acceptanceCase: AcceptanceCase): readonly string[] {
  return acceptanceCase.project === "with-dependency" && acceptanceCase.dependencies === "missing"
    ? ["node_modules"]
    : [];
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
  | "continuations"
  | "buildSettings"
  | "relayLines"
  | "governedVerifications"
  | "dependencyBootstraps"
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
    continuations: log.events.flatMap((event) =>
      event.op === "coding-runtime.run.verification-continuation" && event.extra?.runId === runId
        ? [String(event.extra.state)]
        : [],
    ),
    buildSettings: log.events.flatMap((event) =>
      event.op === "coding-runtime.native-build-settings.admitted" && event.extra?.runId === runId
        ? [
            {
              launchMode: event.extra.launchMode,
              mavenSettings: event.extra.mavenSettings,
              mavenCache: event.extra.mavenCache,
              relayMavenBoundCount: event.extra.relayMavenBoundCount,
              relayNpmBoundCount: event.extra.relayNpmBoundCount,
              relayRefusalReasons: event.extra.relayRefusalReasons,
            },
          ]
        : [],
    ),
    governedVerifications: log.events.flatMap((event) =>
      event.op === "coding-runtime.verification" && event.extra?.state !== "native-proof"
        ? [[event.extra?.state, ...stepList(event.extra?.steps)].map(String).join(" ")]
        : [],
    ),
    // The governed installation's own line, under the run's correlation: it is in the run's
    // timeline, whatever the verifier's steps then did.
    dependencyBootstraps: log.events.flatMap((event) =>
      event.op === "editor.verification.dependencies" && event.correlationId === runId
        ? [
            [
              event.extra?.consumer ?? "-",
              event.extra?.state,
              event.extra?.refusalReason ?? "-",
              `refused=${typeof event.extra?.egressRefused === "number" ? String(event.extra.egressRefused) : "-"}`,
            ]
              .map(String)
              .join(":"),
          ]
        : [],
    ),
    // Whether a build reached the relay at all, and how each request ended: closed values only.
    // A request line carries its request's correlation, so every relay line of the case counts.
    relayLines: log.events.flatMap((event) =>
      event.op === "coding-runtime.repository-relay"
        ? [
            [event.extra?.action, event.extra?.outcome, event.extra?.reason ?? "-"]
              .map(String)
              .join(":"),
          ]
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

function stepList(steps: unknown): readonly unknown[] {
  return Array.isArray(steps) ? steps : [];
}

function acceptanceEvidence(): Record<string, unknown> {
  const administrator = process.getuid?.() === 0 || groups().includes("admin");
  const containerRuntime = containerRuntimeFacts();
  // The promise is for a standard user on a machine without a container runtime; evidence taken
  // anywhere else describes the product, but it does not certify that promise.
  const unmetPreconditions = [
    ...(administrator ? ["administrator"] : []),
    ...(Object.values(containerRuntime).some(Boolean) ? ["container-runtime-present"] : []),
  ];
  // Nor does a partial run (a filtered or interrupted suite) or one with a case that failed.
  const recorded = new Set(evidence.map((entry) => entry.caseId));
  const caseSetComplete =
    evidence.length === ACCEPTANCE_CASES.length &&
    ACCEPTANCE_CASES.every((expectation) => recorded.has(expectation.id));
  const everyCaseMetExpectation = evidence.every(
    (entry) => "metExpectation" in entry && entry.metExpectation,
  );
  return {
    schemaVersion: 4,
    issue: 4492,
    platform: process.platform,
    arch: process.arch,
    darwinRelease: release(),
    node: process.versions.node,
    opencode: OPENCODE_PINNED_VERSION,
    userClass: administrator ? "administrator" : "standard",
    containerRuntime,
    caseSetComplete,
    everyCaseMetExpectation,
    certifiesPromise: unmetPreconditions.length === 0 && caseSetComplete && everyCaseMetExpectation,
    unmetPreconditions,
    cases: evidence,
  };
}

/**
 * Signs that a container runtime is installed, conservatively: a client on `PATH`, a configured
 * `DOCKER_HOST`, a Docker socket, the state directory of Colima, OrbStack, Lima, Rancher Desktop
 * or a Podman machine, or the application bundle of Docker Desktop, OrbStack, Podman Desktop or
 * Rancher Desktop. Presence counts, whether or not the runtime is running.
 */
function containerRuntimeFacts(): Readonly<Record<string, boolean>> {
  const home = homedir();
  const sockets = [
    "/var/run/docker.sock",
    join(home, ".docker", "run", "docker.sock"),
    join(home, ".orbstack", "run", "docker.sock"),
  ];
  const applications = ["Docker", "OrbStack", "Podman Desktop", "Rancher Desktop"].flatMap(
    (name) => [join("/Applications", `${name}.app`), join(home, "Applications", `${name}.app`)],
  );
  return {
    dockerOnPath: onPath("docker"),
    podmanOnPath: onPath("podman"),
    otherClientOnPath: ["nerdctl", "colima", "orb", "limactl"].some((program) => onPath(program)),
    dockerHostConfigured: (process.env.DOCKER_HOST ?? "") !== "",
    dockerSocketPresent: sockets.some((socket) => existsSync(socket)),
    runtimeStatePresent: [
      join(home, ".colima"),
      join(home, ".orbstack"),
      join(home, ".lima"),
      join(home, ".rd"),
      join(home, ".local", "share", "containers", "podman", "machine"),
    ].some((path) => existsSync(path)),
    applicationPresent: applications.some((path) => existsSync(path)),
  };
}

/**
 * The evidence file's absolute path, refused when it lies inside this checkout. Symbolic links in
 * the existing part of the path are resolved first, so a link into the checkout is refused too.
 */
function ownerPrivateEvidenceTarget(file: string): string {
  const requested = resolve(file);
  let existing = requested;
  const missing: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(basename(existing));
    existing = dirname(existing);
  }
  const target = join(realpathSync(existing), ...missing);
  const fromCheckout = relative(realpathSync(REPOSITORY_ROOT), target);
  const outside =
    fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout);
  if (!outside) throw new Error("acceptance-evidence-inside-checkout");
  return target;
}

/**
 * Writes the evidence file owner-private: never through a symbolic link, into a directory only
 * its owner can enter, with mode 0600 whatever existed before.
 */
function writeOwnerPrivate(target: string, content: string): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("acceptance-evidence-directory-not-owner-private");
  }
  const descriptor = openSync(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
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
