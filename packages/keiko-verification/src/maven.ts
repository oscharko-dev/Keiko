// Governed Maven verification (#4492 finding 6). A Maven project has no package.json, so the npm
// planner skips its every kind. Where the verifier runs a step on the host itself, Windows' step
// supervisor (ADR-0043 D20, #4496), the project's own `mvn test` is planned instead: offline,
// because a step has no network; with the run's own writable repository inside the execution root;
// and with the person's own Maven cache chained behind it read-only (Maven 3.9+
// `maven.repo.local.tail`), the same way a macOS native run's shell reads it below Full access
// (ADR-0184). Everywhere else a step runs in a container image without Java, so nothing changes.

import {
  resolveWithinWorkspace,
  type WorkspaceFs,
  type WorkspaceInfo,
} from "@oscharko-dev/keiko-workspace";
import type { VerificationKind, VerificationResourceLimits, VerificationStep } from "./types.js";

/** The run's own Maven repository, relative to the step's working directory (the execution root). */
export const MAVEN_RUN_REPOSITORY = ".keiko-maven-repository";

/** The executable a Maven step names; resolved on `PATH` (`mvn.cmd` on Windows). */
export const MAVEN_EXECUTABLE = "mvn";

/**
 * The variables a Maven step reads besides the default allowlist: where Java and Maven are installed.
 * `MAVEN_OPTS` and `MAVEN_ARGS` are not among them: they would reach the JVM and the build unseen.
 */
export const MAVEN_STEP_ENVIRONMENT: readonly string[] = Object.freeze([
  "JAVA_HOME",
  "MAVEN_HOME",
  "M2_HOME",
]);

/** How the host runs a Maven step: given only where the verifier runs a step on the host. */
export interface MavenStepHost {
  /** The person's own Maven cache, read-only; absent when there is none or it is not usable. */
  readonly cacheRepository?: string | undefined;
}

function isWorkspaceFile(workspace: WorkspaceInfo, fs: WorkspaceFs, name: string): boolean {
  const path = resolveWithinWorkspace(workspace.root, name);
  return fs.exists(path) && fs.stat(path).isFile;
}

/** A Maven project the npm planner has nothing for: a root `pom.xml` and no root `package.json`. */
export function isMavenProject(workspace: WorkspaceInfo, fs: WorkspaceFs): boolean {
  return (
    isWorkspaceFile(workspace, fs, "pom.xml") && !isWorkspaceFile(workspace, fs, "package.json")
  );
}

const TAIL_PREFIX = "-Dmaven.repo.local.tail=";
const DRIVE_FOLDER = /^[A-Za-z]:\\/u;

// An absolute Windows folder Maven reads as one path: it splits the tail at commas, so a cache path
// holding one would chain a second repository.
function isChainableCache(path: string): boolean {
  return DRIVE_FOLDER.test(path) && !path.includes(",") && !path.includes("\u0000");
}

function tailArguments(cacheRepository: string | undefined): readonly string[] {
  if (cacheRepository === undefined || !isChainableCache(cacheRepository)) return [];
  return [`${TAIL_PREFIX}${cacheRepository}`, "-Dmaven.repo.local.tail.ignoreAvailability=true"];
}

/** `mvn -B -o … test`: the arguments VERIFICATION_COMMAND_RULES admits for a Maven step. */
export function mavenTestArguments(host: MavenStepHost): readonly string[] {
  return [
    "-B",
    "-o",
    `-Dmaven.repo.local=${MAVEN_RUN_REPOSITORY}`,
    ...tailArguments(host.cacheRepository),
    "test",
  ];
}

// The cache a step's arguments chain; mavenTestArguments then shows whether the planner chains it.
function plannedCache(args: readonly string[]): string | undefined {
  const tail = args[3];
  return tail?.startsWith(TAIL_PREFIX) === true ? tail.slice(TAIL_PREFIX.length) : undefined;
}

function sameArguments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => right[index] === arg);
}

/**
 * Whether a step is exactly one `planMavenSteps` produces, the orchestrator's shape check: the
 * planned `test` invocation (with or without the planned tail) or a planned skip. A forged plan with
 * any other argument, an attached settings file or another phase is not a Maven step.
 */
export function isPlannedMavenStep(step: VerificationStep): boolean {
  if (step.command !== MAVEN_EXECUTABLE || step.kind === "targeted-test") return false;
  if (step.skipReason !== undefined) return step.scriptName === undefined && step.args.length === 0;
  if (step.kind !== "test" || step.scriptName !== "test") return false;
  const expected = mavenTestArguments({ cacheRepository: plannedCache(step.args) });
  return sameArguments(step.args, expected);
}

/**
 * The Maven project's steps for the requested kinds: its tests run through `mvn test`; Maven has no
 * separate typecheck, lint or build step the verifier could tell apart, so those are skipped.
 */
export function planMavenSteps(
  kinds: readonly VerificationKind[],
  limits: VerificationResourceLimits,
  host: MavenStepHost,
): readonly VerificationStep[] {
  return kinds
    .filter((kind) => kind !== "targeted-test")
    .map((kind): VerificationStep => {
      const base = { kind, command: MAVEN_EXECUTABLE, limits } as const;
      if (kind === "test") {
        return { ...base, scriptName: "test", args: mavenTestArguments(host) };
      }
      return {
        ...base,
        scriptName: undefined,
        args: [],
        skipReason: `no ${kind} step is planned for a Maven project`,
      };
    });
}
