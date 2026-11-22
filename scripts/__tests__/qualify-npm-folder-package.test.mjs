import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QualificationRefusal,
  assertTargetIsHost,
  buildEvidence,
  cleanup,
  download,
  expectedRuntimePackage,
  folderDrift,
  hostTarget,
  logHasLine,
  parseQualifyArgs,
  recordingWrapper,
  releaseAssetUrls,
  reportFailedRun,
  runWrapper,
  shellInvocation,
  snapshotOutsideNodeModules,
  windowsProcessListCommand,
  wrapperOutputReport,
} from "../testing/qualify-npm-folder-package.mjs";
import {
  CHECK_NAMES,
  DEFAULT_REPOSITORY,
  EVIDENCE_SCHEMA_VERSION,
} from "../lib/npm-folder-qualification.mjs";
import { platformRuntimePackages } from "../release-workspace-policy.mjs";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("hostTarget", () => {
  it("names the three desktop targets and nothing else", () => {
    expect(hostTarget("darwin", "arm64")).toBe("macos-arm64");
    expect(hostTarget("darwin", "x64")).toBe("macos-x64");
    expect(hostTarget("win32", "x64")).toBe("windows-x64");
    expect(hostTarget("linux", "x64")).toBeUndefined();
    expect(hostTarget("win32", "arm64")).toBeUndefined();
  });
});

describe("assertTargetIsHost", () => {
  it("accepts the host's own target", () => {
    expect(() => assertTargetIsHost("macos-arm64", "macos-arm64")).not.toThrow();
  });

  it("refuses another platform's target, an unknown target and an unsupported host", () => {
    expect(() => assertTargetIsHost("windows-x64", "macos-arm64")).toThrow(QualificationRefusal);
    expect(() => assertTargetIsHost("macos-x64", "macos-arm64")).toThrow(/not this host/u);
    expect(() => assertTargetIsHost("linux-x64", "macos-arm64")).toThrow(/unsupported target/u);
    expect(() => assertTargetIsHost("macos-arm64", undefined)).toThrow(/no npm folder package/u);
  });
});

describe("parseQualifyArgs", () => {
  it("defaults the version to the root version and the repository to this one", () => {
    expect(parseQualifyArgs(["--target", "macos-arm64", "--out-dir", "out"], "1.5.3")).toEqual({
      target: "macos-arm64",
      outDir: "out",
      version: "1.5.3",
      repository: DEFAULT_REPOSITORY,
    });
  });

  it("takes an explicit version, evidence path and repository", () => {
    const options = parseQualifyArgs(
      ["--target", "windows-x64", "--out-dir", "o", "--version", "2.0.0", "--evidence", "e.json"],
      "1.5.3",
    );
    expect(options.version).toBe("2.0.0");
    expect(options.evidence).toBe("e.json");
  });

  it.each([
    [["--out-dir", "o"], /--target is required/u],
    [["--target", "macos-arm64"], /--out-dir is required/u],
    [["--target", "macos-arm64", "--out-dir", "o", "--version", "v1.5"], /x\.y\.z/u],
    [["--target", "macos-arm64", "--out-dir", "o", "--repository", "a b/c"], /owner\/name/u],
    [["--target", "macos-arm64", "--out-dir"], /needs a value/u],
    [["--target", "macos-arm64", "--out-dir", "o", "--archive", "x"], /unknown argument/u],
  ])("refuses %j", (argv, message) => {
    expect(() => parseQualifyArgs(argv, "1.5.3")).toThrow(message);
  });
});

describe("releaseAssetUrls", () => {
  it("names the public release asset and checksum file of a target", () => {
    expect(
      releaseAssetUrls({ repository: "o/r", version: "1.5.3", target: "macos-arm64" }),
    ).toEqual({
      archive: "https://github.com/o/r/releases/download/v1.5.3/keiko-macos-arm64.zip",
      checksums: "https://github.com/o/r/releases/download/v1.5.3/macos-arm64-SHA256SUMS.txt",
    });
  });
});

describe("expectedRuntimePackage", () => {
  const name = (target) =>
    `@oscharko-dev/keiko-coding-runtime-${platformRuntimePackages[target].suffix}`;

  it("expects the package a release declares for the target", () => {
    const manifest = { optionalDependencies: { [name("macos-arm64")]: "1.1.5" } };
    expect(expectedRuntimePackage("macos-arm64", manifest)).toEqual({
      name: name("macos-arm64"),
      range: "1.1.5",
    });
  });

  it("expects none where the release declares none for the target", () => {
    const manifest = { optionalDependencies: { [name("macos-arm64")]: "1.1.5" } };
    expect(expectedRuntimePackage("macos-x64", manifest)).toBeUndefined();
    expect(expectedRuntimePackage("windows-x64", {})).toBeUndefined();
  });

  it("derives from the declaration, never from a fixed list", () => {
    const manifest = { optionalDependencies: { [name("windows-x64")]: "1.0.0" } };
    expect(expectedRuntimePackage("windows-x64", manifest)?.name).toBe(name("windows-x64"));
  });

  it("refuses a target the policy does not know", () => {
    expect(() => expectedRuntimePackage("linux-x64", {})).toThrow(QualificationRefusal);
  });
});

describe("logHasLine", () => {
  const line = (entry) => JSON.stringify(entry);

  it("finds an operation with its fields, at the top level or under extra", () => {
    const text = [
      line({ op: "other" }),
      line({
        op: "coding-runtime.install.unqualified",
        extra: { reason: "npm-runtime-package-missing" },
      }),
    ].join("\n");
    expect(
      logHasLine(text, "coding-runtime.install.unqualified", {
        reason: "npm-runtime-package-missing",
      }),
    ).toBe(true);
    expect(logHasLine(text, "coding-runtime.install.unqualified", { reason: "other" })).toBe(false);
    expect(logHasLine(text, "missing.op")).toBe(false);
  });

  it("ignores lines that are not JSON", () => {
    expect(logHasLine('torn "some.op" {', "some.op")).toBe(false);
  });
});

describe("folder snapshot and drift", () => {
  function folder() {
    const root = mkdtempSync(join(tmpdir(), "keiko-qualify-test-"));
    temporary.push(root);
    mkdirSync(join(root, "system"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "system", "keiko-npm.mjs"), "x");
    writeFileSync(join(root, "node_modules", "ignored.txt"), "x");
    return root;
  }

  it("ignores node_modules", () => {
    expect([...snapshotOutsideNodeModules(folder()).keys()].sort()).toEqual([
      "package.json",
      "system",
      "system/keiko-npm.mjs",
    ]);
  });

  it("reports nothing for an unchanged folder or for node_modules and the documented lock", () => {
    const root = folder();
    const before = snapshotOutsideNodeModules(root);
    writeFileSync(join(root, "node_modules", "more.txt"), "y");
    mkdirSync(join(root, "system", "keiko-npm-install.lock"));
    writeFileSync(join(root, "system", "keiko-npm-install.lock", "owner-1"), "t");
    expect(folderDrift(before, snapshotOutsideNodeModules(root))).toEqual([]);
  });

  it("reports an added, changed and removed file", () => {
    const root = folder();
    const before = snapshotOutsideNodeModules(root);
    writeFileSync(join(root, "stray.txt"), "s");
    writeFileSync(join(root, "package.json"), '{"changed":true}');
    rmSync(join(root, "system", "keiko-npm.mjs"));
    expect(folderDrift(before, snapshotOutsideNodeModules(root)).sort()).toEqual([
      "added: stray.txt",
      "changed or removed: package.json",
      "changed or removed: system/keiko-npm.mjs",
    ]);
  });
});

describe("buildEvidence", () => {
  const runner = { os: "darwin", arch: "arm64", osRelease: "25.0.0" };
  const base = { target: "macos-arm64", version: "1.5.3", archiveSha256: "a".repeat(64), runner };

  it("is body-free: closed values, digests, durations", () => {
    const evidence = buildEvidence({
      ...base,
      zipSha256: "b".repeat(64),
      results: [
        { name: CHECK_NAMES[0], ok: true, durationMs: 5 },
        { name: CHECK_NAMES[1], ok: false, durationMs: 7, detail: "exit 1" },
      ],
    });
    expect(evidence).toEqual({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind: "keiko-npm-folder-package-qualification",
      target: "macos-arm64",
      version: "1.5.3",
      archiveSha256: "a".repeat(64),
      zipSha256: "b".repeat(64),
      runner,
      passed: false,
      checks: [
        { name: CHECK_NAMES[0], result: "pass", durationMs: 5 },
        { name: CHECK_NAMES[1], result: "fail", durationMs: 7, detail: "exit 1" },
      ],
    });
  });

  const all = CHECK_NAMES.map((name) => ({ name, ok: true, durationMs: 1 }));

  it("passes only when every named check ran and passed, and never for an empty run", () => {
    expect(buildEvidence({ ...base, results: all }).passed).toBe(true);
    expect(buildEvidence({ ...base, results: [] }).passed).toBe(false);
    expect(buildEvidence({ ...base, results: [] }).zipSha256).toBeNull();
    expect(buildEvidence({ ...base, results: all.slice(1) }).passed).toBe(false);
  });

  it("keeps passed false for a run that stopped at a failed check", () => {
    const stopped = [...all.slice(0, 3), { name: CHECK_NAMES[3], ok: false, durationMs: 1 }];
    expect(buildEvidence({ ...base, results: stopped }).passed).toBe(false);
    const executedOnlyPassed = all.slice(0, 5);
    expect(executedOnlyPassed.every((result) => result.ok)).toBe(true);
    expect(buildEvidence({ ...base, results: executedOnlyPassed }).passed).toBe(false);
  });
});

describe("cleanup", () => {
  it("removes every path even when one fails and names only closed words", () => {
    const removed = [];
    const remove = (path) => {
      if (path === "work-path") throw new Error("EBUSY: /secret/path");
      removed.push(path);
    };
    const warn = vi.fn();
    const session = { root: "root-path", work: "work-path", state: "state-path" };
    expect(cleanup(session, "darwin", { remove, warn })).toEqual(["work"]);
    expect(removed).toEqual(["root-path", "state-path"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe("WARN cleanup left 1 path(s) behind: work");
    expect(warn.mock.calls[0][0]).not.toContain("path/");
  });

  it("is silent when everything was removed and skips paths that were never made", () => {
    const warn = vi.fn();
    expect(
      cleanup({ root: undefined, work: undefined, state: undefined }, "darwin", { warn }),
    ).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries a held path for longer than a short grace", () => {
    const remove = vi.fn();
    cleanup({ root: "r" }, "darwin", { remove, warn: vi.fn() });
    expect(remove.mock.calls[0][1].retryDelay).toBeGreaterThanOrEqual(500);
  });
});

describe("download", () => {
  function target() {
    const dir = mkdtempSync(join(tmpdir(), "keiko-qualify-download-"));
    temporary.push(dir);
    return join(dir, "file");
  }

  it("refuses a download that does not finish in time", async () => {
    const stalled = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    await expect(
      download("https://example.test/a.zip", target(), { timeoutMs: 20, fetchImpl: stalled }),
    ).rejects.toThrow(/did not finish within/u);
  });

  it("refuses a body that stalls after the headers", async () => {
    const fetchImpl = (_url, { signal }) => {
      const stalledBody = {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason));
              }),
          };
        },
      };
      return Promise.resolve({ ok: true, body: stalledBody, headers: new globalThis.Headers() });
    };
    await expect(
      download("https://example.test/a.zip", target(), { timeoutMs: 20, fetchImpl }),
    ).rejects.toThrow(/did not finish within/u);
  });

  it("writes a body that arrives in time", async () => {
    const path = target();
    const fetchImpl = () =>
      Promise.resolve({
        ok: true,
        headers: new globalThis.Headers(),
        body: (async function* () {
          yield Buffer.from("abc");
        })(),
      });
    await download("https://example.test/a.zip", path, { fetchImpl });
    expect(existsSync(path)).toBe(true);
  });
});

describe("windowsProcessListCommand", () => {
  it("escapes the folder before -like reads it, so [ and ] are not wildcards", () => {
    const command = windowsProcessListCommand();
    expect(command).toContain("[WildcardPattern]::Escape($env:KEIKO_QUALIFY_FOLDER)");
    expect(command).not.toMatch(/-like[^|]*\$env:KEIKO_QUALIFY_FOLDER/u);
    expect(command.match(/-like \(/gu)).toHaveLength(2);
  });
});

// cmd.exe with /s takes everything after /c and removes its first and its last quote character
// ("cmd /?"). What is left is the command it runs.
function commandCmdRuns(args) {
  const after = args.slice(args.indexOf("/c") + 1).join(" ");
  const first = after.indexOf('"');
  const last = after.lastIndexOf('"');
  return after.slice(0, first) + after.slice(first + 1, last) + after.slice(last + 1);
}

describe("shellInvocation (#4503)", () => {
  const file = String.raw`C:\Users\kstd\Keiko npm folder\Keiko\Start Keiko.cmd`;

  it("leaves the start file quoted after cmd /s removed the outer quotes", () => {
    const { command, args, verbatim } = shellInvocation(file, "win32");
    expect(command).toBe("cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(verbatim).toBe(true);
    expect(commandCmdRuns(args)).toBe(`"${file}"`);
  });

  it("would leave the path bare in the single-quoted form, which cmd splits at the first space", () => {
    expect(commandCmdRuns(["/d", "/s", "/c", `"${file}"`])).toBe(file);
  });

  it("hands the path to sh as one argument elsewhere", () => {
    expect(shellInvocation("/a b/Start Keiko.command", "darwin")).toEqual({
      command: "sh",
      args: ["/a b/Start Keiko.command"],
      verbatim: false,
    });
  });
});

describe("runWrapper with the host's real shell (#4503)", () => {
  it("runs a start file whose path contains spaces", async () => {
    const root = mkdtempSync(join(tmpdir(), "keiko-wrapper-"));
    temporary.push(root);
    const folder = join(root, "Keiko npm folder", "Keiko");
    mkdirSync(folder, { recursive: true });
    const windows = platform() === "win32";
    const file = join(folder, windows ? "Start Keiko.cmd" : "Start Keiko.command");
    writeFileSync(
      file,
      windows ? "@echo started from the folder\r\n" : "echo started from the folder\n",
    );
    const result = await runWrapper(file, {
      env: process.env,
      cwd: root,
      logPath: join(root, "start.log"),
      timeoutMs: 30_000,
    });
    expect(result.output).toContain("started from the folder");
    expect(result.status).toBe(0);
  });
});

describe("wrapperOutputReport (#4503)", () => {
  it("shows every start and stop in the order they ran, with its exit status", () => {
    const report = wrapperOutputReport([
      { name: "start-1.log", status: 0, output: "Keiko UI running" },
      { name: "start-2.log", status: 0, output: "Keiko UI process is stale; restarting" },
      { name: "stop.log", status: 1, output: "not running" },
    ]);
    const first = report.indexOf("start-1.log (exit 0");
    const second = report.indexOf("start-2.log (exit 0");
    const stop = report.indexOf("stop.log (exit 1");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    expect(stop).toBeGreaterThan(second);
    expect(report).toContain("process is stale");
  });

  it("keeps only the tail of a long output", () => {
    const output = Array.from({ length: 40 }, (_, line) => `line ${String(line)}`).join("\n");
    const report = wrapperOutputReport([{ name: "start-1.log", status: 1, output }]);
    expect(report).not.toContain("line 14\n");
    expect(report).toContain("line 15");
    expect(report).toContain("line 39");
  });

  it("says so when no start or stop ran", () => {
    expect(wrapperOutputReport([])).toBe("--- no start or stop ran ---");
  });
});

describe("recordingWrapper and reportFailedRun (#4503)", () => {
  it("keeps every start and stop with its exit status, in the order they ran", async () => {
    const session = { env: { A: "1" }, work: "/work", outputs: [] };
    const calls = [];
    const run = (file, options) => {
      calls.push({ file, options });
      return Promise.resolve({ status: calls.length === 2 ? 1 : 0, output: `out ${file}` });
    };
    const wrapper = recordingWrapper(session, "darwin", run);
    await wrapper("/f/Start Keiko.command", "start-1.log", 5);
    await wrapper("/f/Start Keiko.command", "start-2.log", 5);
    expect(calls[0].options).toMatchObject({
      env: { A: "1" },
      logPath: join("/work", "start-1.log"),
      timeoutMs: 5,
      os: "darwin",
    });
    expect(session.outputs).toEqual([
      { name: "start-1.log", status: 0, output: "out /f/Start Keiko.command" },
      { name: "start-2.log", status: 1, output: "out /f/Start Keiko.command" },
    ]);
  });

  it("prints the outputs only when a check failed", () => {
    const outputs = [{ name: "start-2.log", status: 0, output: "restarting" }];
    const printed = [];
    reportFailedRun({ checks: { results: [{ ok: true }] }, outputs }, (line) => printed.push(line));
    expect(printed).toEqual([]);
    reportFailedRun({ checks: { results: [{ ok: true }, { ok: false }] }, outputs }, (line) =>
      printed.push(line),
    );
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("output of start-2.log (exit 0");
  });
});
