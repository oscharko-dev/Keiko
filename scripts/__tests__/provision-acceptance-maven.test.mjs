// #4492: the lock of the acceptance task's Maven cache covers every .pom and .jar, and a cache that
// differs from it in any way is reported.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCache,
  cachedArtifacts,
  fail,
  lockFor,
  lockMismatches,
  MAVEN_RETRY_ARGUMENTS,
  main,
  ProvisionError,
  runCli,
  verifyAgainstLock,
} from "../provision-acceptance-maven.mjs";

const roots = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cacheWith(files) {
  const root = mkdtempSync(join(tmpdir(), "keiko-provision-maven-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("provision-acceptance-maven lock", () => {
  it("covers every pom and jar, and nothing else, in a stable order", () => {
    const cache = cacheWith({
      "b/b-1.jar": "jar",
      "a/a-1.pom": "pom",
      "a/a-1.pom.sha1": "ignored",
      "a/_remote.repositories": "ignored",
    });
    expect(cachedArtifacts(cache)).toEqual(["a/a-1.pom", "b/b-1.jar"]);
    expect(lockFor(cache)).toEqual({
      schemaVersion: 1,
      files: {
        "a/a-1.pom": createHash("sha256").update("pom").digest("hex"),
        "b/b-1.jar": createHash("sha256").update("jar").digest("hex"),
      },
    });
  });

  it("reports a missing, altered and unlisted file, and nothing for a matching cache", () => {
    const cache = cacheWith({ "a/a-1.pom": "pom", "b/b-1.jar": "jar" });
    const lock = lockFor(cache);
    expect(lockMismatches(cache, lock)).toEqual([]);
    writeFileSync(join(cache, "a/a-1.pom"), "altered");
    writeFileSync(join(cache, "c-1.jar"), "extra");
    const missing = { ...lock, files: { ...lock.files, "gone-1.jar": "00" } };
    expect(lockMismatches(cache, missing)).toEqual([
      "digest differs: a/a-1.pom",
      "missing: gone-1.jar",
      "not in the lock: c-1.jar",
    ]);
  });

  it("reads a cache directory that does not exist as empty, and a lock without files as empty", () => {
    expect(cachedArtifacts(join(tmpdir(), "keiko-provision-maven-absent"))).toEqual([]);
    const cache = cacheWith({ "a/a-1.pom": "pom" });
    expect(lockMismatches(cache, {})).toEqual(["not in the lock: a/a-1.pom"]);
  });
});

// The build itself needs Maven and the network; a stand-in Maven proves the script's own handling:
// where it builds, what it removes afterwards, what it records and how it fails.
const posix = process.platform === "win32" ? describe.skip : describe;

function stubMaven(body) {
  const directory = mkdtempSync(join(tmpdir(), "keiko-provision-mvn-"));
  roots.push(directory);
  const path = join(directory, "mvn");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const STUB_BUILDS = `for a in "$@"; do case "$a" in -Dmaven.repo.local=*) repo="\${a#-Dmaven.repo.local=}";; esac; done
mkdir -p "$repo/org/x"
echo pom > "$repo/org/x/x-1.pom"
echo jar > "$repo/org/x/x-1.jar"
mkdir -p "$repo/com/example/acceptance"
echo private > "$repo/com/example/acceptance/private-1.pom"`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "keiko-provision-work-"));
  roots.push(root);
  return {
    cacheDirectory: join(root, "cache", "repository"),
    lockFile: join(root, "maven-cache.lock.json"),
  };
}

posix("provision-acceptance-maven build and verification", () => {
  it("builds the cache, removes the private tree and records what it holds", () => {
    const where = { ...workspace(), maven: stubMaven(STUB_BUILDS) };
    buildCache(where);
    expect(cachedArtifacts(where.cacheDirectory)).toEqual(["org/x/x-1.jar", "org/x/x-1.pom"]);
    expect(existsSync(join(where.cacheDirectory, "com", "example", "acceptance"))).toBe(false);
  });

  it("asks Maven to outlast a short rate limit of Maven Central", () => {
    const records = `${STUB_BUILDS}
printf '%s\\n' "$@" > "$repo/arguments.txt"`;
    const where = { ...workspace(), maven: stubMaven(records) };
    buildCache(where);
    const passed = readFileSync(join(where.cacheDirectory, "arguments.txt"), "utf8").split("\n");
    expect(passed).toEqual(expect.arrayContaining([...MAVEN_RETRY_ARGUMENTS]));
    // Maven 3.9 (Resolver 1) and Maven 4 (Resolver 2) each read only their own names.
    for (const family of ["connector", "transport"]) {
      expect(passed).toContain(`-Daether.${family}.http.retryHandler.count=6`);
    }
    expect(passed.at(-2)).toBe("test");
  });

  it("refuses a build that Maven fails, naming how it ended", () => {
    const where = { ...workspace(), maven: stubMaven("exit 3") };
    expect(() => {
      buildCache(where);
    }).toThrow(/mvn exited with 3/u);
    const absent = { ...workspace(), maven: join(tmpdir(), "keiko-no-such-maven") };
    expect(() => {
      buildCache(absent);
    }).toThrow(ProvisionError);
  });

  it("writes the lock on request and verifies a cache against it", () => {
    const where = { ...workspace(), maven: stubMaven(STUB_BUILDS) };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    main(["--write-lock"], where);
    const lock = JSON.parse(readFileSync(where.lockFile, "utf8"));
    expect(Object.keys(lock.files)).toEqual(["org/x/x-1.jar", "org/x/x-1.pom"]);
    main(["--verify"], where);
    expect(log).toHaveBeenLastCalledWith("provision-acceptance-maven: 2 artifacts match the lock");
    // Without --write-lock the build is verified against the committed lock.
    main([], where);
  });

  it("refuses a cache that differs from its lock, a missing lock and a missing cache", () => {
    const where = { ...workspace(), maven: stubMaven(STUB_BUILDS) };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => {
      verifyAgainstLock(where);
    }).toThrow(/the lock is missing/u);
    writeFileSync(
      where.lockFile,
      JSON.stringify({ schemaVersion: 1, files: { "gone.jar": "00" } }),
    );
    expect(() => {
      verifyAgainstLock(where);
    }).toThrow(/the cache is missing/u);
    expect(() => {
      main([], where);
    }).toThrow(/the cache does not match its lock:\n {2}missing: gone.jar/u);
  });

  it("uses the checkout's own cache and lock, and the process's console and exit, by default", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    try {
      verifyAgainstLock();
    } catch (error) {
      // A checkout that has not provisioned its cache is refused, never silently accepted.
      expect(error).toBeInstanceOf(ProvisionError);
    }
    runCli(["--verify", "--write-lock"]);
    expect(report).toHaveBeenCalledWith(
      "provision-acceptance-maven: --verify and --write-lock exclude each other",
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("refuses contradictory flags before it builds anything", () => {
    const where = { ...workspace(), maven: stubMaven("exit 9") };
    expect(() => {
      main(["--verify", "--write-lock"], where);
    }).toThrow(/exclude each other/u);
    expect(existsSync(where.cacheDirectory)).toBe(false);
  });

  it("reports a refusal as one line and a failing exit, and lets any other error through", () => {
    const messages = [];
    const exits = [];
    const where = { ...workspace(), maven: "unused" };
    runCli(["--verify"], {
      options: where,
      error: (line) => messages.push(line),
      exit: (code) => exits.push(code),
    });
    expect(messages).toEqual([
      "provision-acceptance-maven: the lock is missing; run with --write-lock once and commit it",
    ]);
    expect(exits).toEqual([1]);
    writeFileSync(where.lockFile, "{ not json");
    expect(() => {
      runCli(["--verify"], { options: where, error: () => undefined, exit: () => undefined });
    }).toThrow(SyntaxError);
    expect(() => {
      fail("x");
    }).toThrow(ProvisionError);
  });
});
