// Provision the Maven cache of the Coding acceptance task's internal-repository project (#4492).
//
// The project `tests/fixtures/coding-acceptance/maven-internal-repository` has a parent POM that
// only an internal repository serves, behind a login. The acceptance test plays that repository
// on loopback (`packages/keiko-server/src/test-support/functional-maven-repository.ts`): it serves
// the private parent POM from `tests/fixtures/coding-acceptance/maven-repository` and everything
// else Maven needs from the cache this script builds, so the test itself reaches no network.
//
// Run it once per checkout, with network access:
//
//   npm run provision:acceptance-maven              build the cache, then verify it against the lock
//   npm run provision:acceptance-maven -- --write-lock   build the cache and rewrite the lock
//   npm run provision:acceptance-maven -- --verify       only verify an existing cache
//
// The cache lives in the ignored `.acceptance-maven/repository`. It is built by a real
// `mvn -B test` of the fixed project with an empty settings file and a temporary HOME: the real
// `~/.m2` is never read or written. The private artifacts (`com/example/acceptance`) are deleted
// from the cache afterwards, so they exist only behind the login. The committed lock
// (`tests/fixtures/coding-acceptance/maven-cache.lock.json`) pins the path and SHA-256 of every
// `.pom` and `.jar` in the cache; the test-support server refuses a cache that does not match it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { env } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO_ROOT, "tests", "fixtures", "coding-acceptance");
export const CACHE_DIRECTORY = join(REPO_ROOT, ".acceptance-maven", "repository");
export const LOCK_FILE = join(FIXTURES, "maven-cache.lock.json");
const PRIVATE_REPOSITORY = join(FIXTURES, "maven-repository");
const PRIVATE_GROUP_PATH = join("com", "example", "acceptance");
const PROJECT = join(FIXTURES, "maven-internal-repository");
const FIXED_VARIANT = join(
  FIXTURES,
  "variants",
  "maven-internal-repository",
  "src",
  "main",
  "java",
  "com",
  "example",
  "invoice",
  "Invoice.fixed.java",
);
const FIXED_TARGET = join("src", "main", "java", "com", "example", "invoice", "Invoice.java");
const LOCK_SCHEMA_VERSION = 1;
const BUILD_TIMEOUT_MS = 600_000;

/** A refusal of this script. It is thrown, never exited on, so cleanup in `finally` runs. */
export class ProvisionError extends Error {}

export function fail(message) {
  throw new ProvisionError(message);
}

// Code-unit order, not locale order: the lock records this order and must read the same everywhere.
function compareCodeUnits(left, right) {
  return Number(left > right) - Number(left < right);
}

/** Every `.pom` and `.jar` below `directory`, as sorted forward-slash relative paths. */
export function cachedArtifacts(directory) {
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(pom|jar)$/u.test(entry.name)) {
        found.push(relative(directory, full).split(sep).join("/"));
      }
    }
  };
  if (existsSync(directory)) visit(directory);
  return found.sort(compareCodeUnits);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The lock a cache directory yields: the path and SHA-256 of every `.pom` and `.jar`. */
export function lockFor(directory) {
  const files = {};
  for (const path of cachedArtifacts(directory)) files[path] = sha256(join(directory, path));
  return { schemaVersion: LOCK_SCHEMA_VERSION, files };
}

/** The differences between a cache and its committed lock; empty when they match. */
export function lockMismatches(directory, lock) {
  const actual = lockFor(directory).files;
  const expected = lock.files ?? {};
  const mismatches = [];
  for (const [path, digest] of Object.entries(expected)) {
    if (actual[path] === undefined) mismatches.push(`missing: ${path}`);
    else if (actual[path] !== digest) mismatches.push(`digest differs: ${path}`);
  }
  for (const path of Object.keys(actual)) {
    if (expected[path] === undefined) mismatches.push(`not in the lock: ${path}`);
  }
  return mismatches;
}

function readLock(lockFile) {
  if (!existsSync(lockFile)) return undefined;
  return JSON.parse(readFileSync(lockFile, "utf8"));
}

/** Where the cache and its lock live and which Maven builds it; the defaults are the checkout's. */
function locations(options) {
  return {
    cacheDirectory: options.cacheDirectory ?? CACHE_DIRECTORY,
    lockFile: options.lockFile ?? LOCK_FILE,
    maven: options.maven ?? env.KEIKO_ACCEPTANCE_MVN ?? "mvn",
  };
}

function mavenEnvironment(home) {
  return {
    PATH: env.PATH ?? "",
    HOME: home,
    // Java takes `user.home` from the account, not from `HOME`; Maven reads its user files there.
    MAVEN_OPTS: `-Duser.home=${home}`,
    ...(env.JAVA_HOME === undefined ? {} : { JAVA_HOME: env.JAVA_HOME }),
    LANG: "en_US.UTF-8",
  };
}

function runMaven(command, arguments_, cwd, home) {
  const result = spawnSync(command, arguments_, {
    cwd,
    env: mavenEnvironment(home),
    stdio: "inherit",
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    fail(
      `mvn exited with ${String(result.status ?? result.signal)}; it needs Maven and a JDK on PATH and network access to Maven Central`,
    );
  }
}

/** Builds the cache with a real Maven run of the fixed project, then removes the private tree. */
export function buildCache(options = {}) {
  const { cacheDirectory, maven } = locations(options);
  const scratch = mkdtempSync(join(tmpdir(), "keiko-acceptance-maven-"));
  try {
    const home = join(scratch, "home");
    const project = join(scratch, "project");
    mkdirSync(home, { recursive: true });
    cpSync(PROJECT, project, { recursive: true });
    copyFileSync(FIXED_VARIANT, join(project, FIXED_TARGET));
    const settings = join(scratch, "settings.xml");
    writeFileSync(settings, "<settings></settings>\n");
    // Maven's own global settings (`conf/settings.xml` of the installation) are replaced as well.
    const globalSettings = join(scratch, "global-settings.xml");
    writeFileSync(globalSettings, "<settings></settings>\n");
    rmSync(cacheDirectory, { recursive: true, force: true });
    mkdirSync(cacheDirectory, { recursive: true });
    // The private parent POM first, so the build can read it from the cache.
    cpSync(join(PRIVATE_REPOSITORY, PRIVATE_GROUP_PATH), join(cacheDirectory, PRIVATE_GROUP_PATH), {
      recursive: true,
    });
    runMaven(
      maven,
      ["-B", "-s", settings, "-gs", globalSettings, `-Dmaven.repo.local=${cacheDirectory}`, "test"],
      project,
      home,
    );
    rmSync(join(cacheDirectory, PRIVATE_GROUP_PATH), { recursive: true, force: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyAgainstLock(options = {}) {
  const { cacheDirectory, lockFile } = locations(options);
  const lock = readLock(lockFile);
  if (lock === undefined) fail("the lock is missing; run with --write-lock once and commit it");
  if (!existsSync(cacheDirectory))
    fail("the cache is missing; run npm run provision:acceptance-maven");
  const mismatches = lockMismatches(cacheDirectory, lock);
  if (mismatches.length > 0) {
    fail(`the cache does not match its lock:\n  ${mismatches.slice(0, 20).join("\n  ")}`);
  }
  console.log(
    `provision-acceptance-maven: ${String(Object.keys(lock.files).length)} artifacts match the lock`,
  );
}

export function main(argv, options = {}) {
  const flags = new Set(argv);
  if (flags.has("--verify") && flags.has("--write-lock")) {
    fail("--verify and --write-lock exclude each other");
  }
  if (flags.has("--verify")) return verifyAgainstLock(options);
  buildCache(options);
  if (flags.has("--write-lock")) {
    const { cacheDirectory, lockFile } = locations(options);
    writeFileSync(lockFile, `${JSON.stringify(lockFor(cacheDirectory), null, 2)}\n`);
    console.log(`provision-acceptance-maven: wrote ${relative(REPO_ROOT, lockFile)}`);
  }
  return verifyAgainstLock(options);
}

/** The command line: a refusal of this script is one line on stderr and a failing exit. */
export function runCli(argv, io = {}) {
  const report = io.error ?? console.error;
  const exit = io.exit ?? process.exit;
  try {
    main(argv, io.options);
  } catch (error) {
    if (!(error instanceof ProvisionError)) throw error;
    report(`provision-acceptance-maven: ${error.message}`);
    exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runCli(process.argv.slice(2));
