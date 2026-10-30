// The hardened Git runner for pull request review operations (ADR-0182 D3, Issue #4133).
//
// A review materializes a hostile pull request head in a server-owned worktree. Nothing from that
// head may execute: no hook, no filter driver (Git LFS included), no fsmonitor, no submodule, no
// symbolic link that resolves outside the worktree. This module owns the ONE reviewed set of
// configuration overrides that guarantees it, injected by the runner itself ahead of every caller
// argument, exactly as `NETWORK_CONFIG_ARGS` neutralizes remote-facing configuration for sync.
//
// Callers cannot weaken it: a review runner refuses EVERY caller-supplied `-c`/`--config-env`
// override (stricter than the shared runner, which denies dangerous keys only), and the only
// variable parts of the injected set are validated filter-driver names and a validated byte count.

import {
  CONFIG_ENV_JOINED_PREFIX,
  CONFIG_OVERRIDE_FLAGS,
  createGitProcessRunnerWithFixedArgs,
  NETWORK_CONFIG_ARGS,
  refusedOptionResult,
} from "./runner.js";
import { gitReviewEnv, networkGitReviewEnv } from "./env.js";
import type { GitProcessRunner } from "./types.js";

function nullDevice(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * The reviewed allowlist of configuration every review operation runs with, as `[key, value]`
 * pairs. `core.hooksPath` names the null device rather than a directory: no file can ever exist
 * below it, so no hook can be resolved even if the review root were written to (see ADR-0098).
 */
export const GIT_REVIEW_HARDENING_CONFIG: readonly (readonly [string, string])[] = Object.freeze([
  Object.freeze(["core.hooksPath", nullDevice()] as const),
  Object.freeze(["core.fsmonitor", "false"] as const),
  Object.freeze(["core.symlinks", "false"] as const),
  Object.freeze(["core.protectNTFS", "true"] as const),
  Object.freeze(["core.protectHFS", "true"] as const),
  Object.freeze(["core.sparseCheckout", "false"] as const),
  Object.freeze(["core.editor", "true"] as const),
  Object.freeze(["core.pager", "cat"] as const),
  Object.freeze(["submodule.recurse", "false"] as const),
  Object.freeze(["fetch.recurseSubmodules", "false"] as const),
  Object.freeze(["protocol.file.allow", "never"] as const),
  Object.freeze(["protocol.ext.allow", "never"] as const),
  Object.freeze(["gc.auto", "0"] as const),
  Object.freeze(["maintenance.auto", "false"] as const),
]);

/** Driver names Keiko neutralizes on every review operation, whether or not they are configured. */
const ALWAYS_NEUTRALIZED_FILTER_DRIVERS: readonly string[] = ["lfs"];
const FILTER_DRIVER_KEYS: readonly string[] = ["smudge", "clean", "process"];

// A filter driver name becomes part of a `-c filter.<name>.<key>=` token. A name containing `=`
// would move the key/value boundary and turn a neutralization into an assignment, so only a
// conservative alphabet is accepted; whitespace, control characters and `=` are impossible.
const SAFE_FILTER_DRIVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isSafeGitFilterDriverName(value: string): boolean {
  return SAFE_FILTER_DRIVER_NAME.test(value) && !value.includes("..");
}

const MAX_FILTER_DRIVERS = 64;
const MAX_BIG_FILE_THRESHOLD_BYTES = 512 * 1024 * 1024;

export interface GitReviewRunnerOptions {
  /** Filter driver names named by the head's attributes or the repository's configuration. */
  readonly filterDrivers?: readonly string[] | undefined;
  /**
   * Blobs above this size are treated as binary by the diff machinery without being loaded, so a
   * binary scan never reads a giant blob. Mirrors the review worktree's blob limit.
   */
  readonly bigFileThresholdBytes?: number | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

function configPairArgs(pairs: readonly (readonly [string, string])[]): readonly string[] {
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

function hardeningConfig(platform: NodeJS.Platform): readonly (readonly [string, string])[] {
  return GIT_REVIEW_HARDENING_CONFIG.map(([key, value]) =>
    key === "core.hooksPath" ? ([key, nullDevice(platform)] as const) : ([key, value] as const),
  );
}

function uniqueDrivers(drivers: readonly string[]): readonly string[] {
  const all = [...ALWAYS_NEUTRALIZED_FILTER_DRIVERS, ...drivers];
  if (all.length > MAX_FILTER_DRIVERS + ALWAYS_NEUTRALIZED_FILTER_DRIVERS.length) {
    throw new RangeError("too many filter drivers to neutralize");
  }
  for (const driver of all) {
    if (!isSafeGitFilterDriverName(driver)) throw new RangeError("unsafe filter driver name");
  }
  return [...new Set(all)];
}

/**
 * The `-c` arguments that neutralize every listed filter driver: empty `smudge`, `clean` and
 * `process` commands make Git apply no filter, and `required=false` keeps a required driver from
 * failing the checkout once it has no command. Throws `RangeError` for an unsafe name: the caller
 * must refuse the operation rather than run with an unneutralized driver.
 */
export function gitReviewFilterNeutralizationArgs(drivers: readonly string[]): readonly string[] {
  return uniqueDrivers(drivers).flatMap((driver) => [
    ...FILTER_DRIVER_KEYS.flatMap((key) => ["-c", `filter.${driver}.${key}=`]),
    "-c",
    `filter.${driver}.required=false`,
  ]);
}

function bigFileThresholdArgs(bytes: number | undefined): readonly string[] {
  if (bytes === undefined) return [];
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_BIG_FILE_THRESHOLD_BYTES) {
    throw new RangeError("invalid big file threshold");
  }
  return ["-c", `core.bigFileThreshold=${String(bytes)}`];
}

/** The complete fixed argument prefix a local review runner injects. Exported for tests. */
export function gitReviewFixedArgs(options: GitReviewRunnerOptions = {}): readonly string[] {
  const platform = options.platform ?? process.platform;
  return [
    ...configPairArgs(hardeningConfig(platform)),
    ...gitReviewFilterNeutralizationArgs(options.filterDrivers ?? []),
    ...bigFileThresholdArgs(options.bigFileThresholdBytes),
  ];
}

function callerConfigOverride(args: readonly string[]): string | undefined {
  return args.find(
    (arg) =>
      CONFIG_OVERRIDE_FLAGS.has(arg) ||
      arg.startsWith(CONFIG_ENV_JOINED_PREFIX) ||
      (arg.startsWith("-c") && arg.length > 2),
  );
}

function refusingCallerConfiguration(inner: GitProcessRunner): GitProcessRunner {
  return (args, options) => {
    const override = callerConfigOverride(args);
    if (override !== undefined) {
      return Promise.resolve(refusedOptionResult(override, "config-override"));
    }
    return inner(args, options);
  };
}

/**
 * A runner for local review operations (worktree, checkout, tree and object reads, private refs).
 * Throws `RangeError` when a filter driver name or the threshold is unsafe.
 */
export function createGitReviewProcessRunner(
  options: GitReviewRunnerOptions = {},
): GitProcessRunner {
  const fixedArgs = gitReviewFixedArgs(options);
  return refusingCallerConfiguration(
    createGitProcessRunnerWithFixedArgs(() => gitReviewEnv(), fixedArgs),
  );
}

/**
 * The runner for the pull request fetch: the sync runner's credential-capable environment and
 * network neutralization, plus the review hardening set.
 */
export function createGitReviewNetworkProcessRunner(): GitProcessRunner {
  const fixedArgs = [...NETWORK_CONFIG_ARGS, ...gitReviewFixedArgs()];
  return refusingCallerConfiguration(
    createGitProcessRunnerWithFixedArgs(() => networkGitReviewEnv(), fixedArgs),
  );
}
