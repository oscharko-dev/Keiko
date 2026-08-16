import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWindowsMsvcEnv, windowsToolFromPath } from "../../scripts/lib/windows-msvc.mjs";
import { performance } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";

const source = fileURLToPath(new URL("./secure_workspace_read.c", import.meta.url));
const SAFE_TEXT = "safe text\n";
const HELPER_DEADLINE_MS = 2_000;
const CONCURRENT_CONSISTENCY_READS = 32;
const WINDOWS_RESERVED_STEMS = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM",
  "LPT",
  "CLOCK$",
  "GLOBALROOT",
  "DEVICE",
  "??",
];
const WINDOWS_RESERVED_DENIED = [
  "CON",
  "con.txt",
  "PRN",
  "AUX.log",
  "NUL.txt",
  "CONIN$",
  "conin$.txt",
  "CONOUT$",
  "conout$.log",
  "COM1",
  "COM9.log",
  "COM¹",
  "com¹.txt",
  "COM²",
  "com².log",
  "COM³",
  "com³.txt",
  "LPT1",
  "LPT9.log",
  "LPT¹",
  "lpt¹.txt",
  "LPT²",
  "lpt².log",
  "LPT³",
  "lpt³.txt",
  "CLOCK$",
  "GLOBALROOT",
  "GLOBALROOT.txt",
  "DEVICE",
  "DEVICE.log",
  "??",
];
const WINDOWS_RESERVED_PREFIX_ALLOWED = [
  "GLOBALROOTED",
  "CONSOLE",
  "DEVICEFUL",
  "CLOCK$X",
  "COM10",
  "LPT10",
  "CONIN$X",
  "CONOUT$X",
  "COM¹0",
  "LPT²X",
];
const isWindows = process.platform === "win32";

function request(root, path, { cap = 65_536, trailing = Buffer.alloc(0) } = {}) {
  const rootBytes = Buffer.from(root, "utf8");
  const pathBytes = Buffer.from(path, "utf8");
  const frame = Buffer.alloc(20 + rootBytes.length + pathBytes.length);
  frame.write("KSR1", 0, "ascii");
  frame.writeUInt16LE(1, 4);
  frame.writeUInt32LE(rootBytes.length, 8);
  frame.writeUInt32LE(pathBytes.length, 12);
  frame.writeUInt32LE(cap, 16);
  rootBytes.copy(frame, 20);
  pathBytes.copy(frame, 20 + rootBytes.length);
  return Buffer.concat([frame, trailing]);
}

// KEIKO-0382: the helper's frame parser has ten guards at its trust boundary (version, reserved,
// declared vs supplied lengths, size caps, NUL and UTF-8 in the path) and zero of them were
// exercised. `request()` above cannot express the malformed cases those guards exist for because
// it derives every header field from the payload; this sibling builder decouples them so a frame
// can carry a declared length that DIFFERS from the bytes actually appended, an out-of-domain
// version, a non-zero reserved half-word, or arbitrary raw path bytes including NULs and invalid
// UTF-8. Kept small and single-purpose: assertProtocolCases uses it, `request()` stays the
// well-formed builder every other case still calls.
const MALFORMED_DEFAULTS = {
  root: "",
  pathBytes: Buffer.alloc(0),
  cap: 65_536,
  version: 1,
  reserved: 0,
  trailing: Buffer.alloc(0),
};

function malformedRequest(overrides = {}) {
  const options = { ...MALFORMED_DEFAULTS, ...overrides };
  const rootBuf = Buffer.from(options.root, "utf8");
  const pathBuf = Buffer.isBuffer(options.pathBytes)
    ? options.pathBytes
    : Buffer.from(options.pathBytes, "utf8");
  const declaredRootLen = options.declaredRootLen ?? rootBuf.length;
  const declaredPathLen = options.declaredPathLen ?? pathBuf.length;
  const frame = Buffer.alloc(20 + rootBuf.length + pathBuf.length);
  frame.write("KSR1", 0, "ascii");
  frame.writeUInt16LE(options.version, 4);
  frame.writeUInt16LE(options.reserved, 6);
  frame.writeUInt32LE(declaredRootLen, 8);
  frame.writeUInt32LE(declaredPathLen, 12);
  frame.writeUInt32LE(options.cap, 16);
  rootBuf.copy(frame, 20);
  pathBuf.copy(frame, 20 + rootBuf.length);
  return Buffer.concat([frame, options.trailing]);
}

// The helper's own limits (see native/secure-workspace-read/secure_workspace_read.c: KSR_MAX_ROOT
// = 32 KiB, KSR_MAX_PATH = 4 KiB). Duplicated at the harness's trust boundary rather than
// imported, because the point of pinning them here is to catch the C constant silently drifting.
const HARNESS_KSR_MAX_ROOT = 32 * 1024;
const HARNESS_KSR_MAX_PATH = 4 * 1024;

function spawnHelper(binary, input, paused, mutate) {
  const started = performance.now();
  return new Promise((resolveResult, reject) => {
    const stdio = paused ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"];
    const child = spawn(binary, [], { stdio, env: {} });
    const stdout = [];
    const stderr = [];
    let mutationDenied = false;
    let mutationError;
    const deadline = setTimeout(() => child.kill("SIGKILL"), HELPER_DEADLINE_MS);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (paused) {
      child.stdio[3].once("data", async (signal) => {
        try {
          assert.deepEqual(signal, Buffer.of(1));
          await mutate();
        } catch (error) {
          if (isWindows && ["EACCES", "EBUSY", "EPERM"].includes(error?.code))
            mutationDenied = true;
          else mutationError = error;
        }
        child.stdio[4].end(Buffer.of(1));
      });
    }
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (mutationError !== undefined) return reject(mutationError);
      if (signal !== null) return reject(new Error("helper exceeded its execution deadline"));
      resolveResult({
        code,
        durationMs: performance.now() - started,
        mutationDenied,
        stderr: Buffer.concat(stderr),
        stdout: Buffer.concat(stdout),
      });
    });
    child.stdin.end(input);
  });
}

const run = (binary, input) => spawnHelper(binary, input, false);
const runPaused = (binary, input, mutate) => spawnHelper(binary, input, true, mutate);

function response(result) {
  assert.equal(result.code, 0);
  assert.ok(result.durationMs < HELPER_DEADLINE_MS);
  assert.equal(result.stderr.length, 0, "helper must never write stderr");
  assert.ok(result.stdout.length >= 12);
  assert.equal(result.stdout.subarray(0, 4).toString("ascii"), "KSS1");
  assert.equal(result.stdout.readUInt16LE(4), 1);
  const status = result.stdout.readUInt16LE(6);
  const length = result.stdout.readUInt32LE(8);
  assert.equal(result.stdout.length, 12 + length);
  if (status !== 0) assert.equal(length, 0, "failure must be content-free");
  return { content: result.stdout.subarray(12), status };
}

function assertSafeResult(result) {
  const decoded = response(result);
  assert.equal(decoded.status, 0);
  assert.equal(decoded.content.toString("utf8"), SAFE_TEXT);
}

async function compile(binary, paused = false) {
  const objectPath = join(dirname(binary), `${basename(binary)}.obj`);
  const args = isWindows
    ? [
        "/nologo",
        "/std:c11",
        "/W4",
        "/WX",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        "/D_CRT_SECURE_NO_WARNINGS",
        ...(paused ? ["/DKSR_TEST_PAUSE_AFTER_FINAL_OPEN"] : []),
        `/Fe:${binary}`,
        `/Fo:${objectPath}`,
        source,
        "/link",
        "ntdll.lib",
      ]
    : [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        ...(paused ? ["-DKSR_TEST_PAUSE_AFTER_FINAL_OPEN"] : []),
        "-o",
        binary,
        source,
      ];
  // Windows resolves the MSVC toolchain itself (shared lib, #3085): no workflow step persists
  // vcvars into the environment, and a bare "cl" is not reliably searched on options.env.PATH.
  const compileEnv = isWindows ? resolveWindowsMsvcEnv(process.env) : process.env;
  const compiler = isWindows ? windowsToolFromPath(compileEnv.PATH, "cl.exe") : "xcrun";
  await new Promise((resolveCompile, reject) => {
    const child = spawn(compiler, args, { env: compileEnv, stdio: ["ignore", "ignore", "pipe"] });
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolveCompile()
        : reject(new Error(`native compile failed (${String(code)}): ${Buffer.concat(errors)}`)),
    );
  });
}

// KEIKO-0417: the 17 checks below used to run against RAW file text, so a security control that
// survived only as a `/* ... */` comment still satisfied `assert.match` and the deleted-but-
// documented behaviour passed as if it were live. Strip C block comments, line comments, and the
// bodies of double-quoted string literals before matching. Character literals (single-quoted) are
// preserved: they can hold at most a handful of bytes and cannot hide the multi-token security
// controls the 17 assertions pin, and assertion #16 and #9 below embed them directly. Assertions
// whose intent is to observe a specific bytestring INSIDE a `"..."` (the Windows reserved-stem
// pass and the `ascii_name_equals(..., "GLOBALROOT")` check) explicitly read `nativeSourceRaw`;
// every other check consumes the stripped text.
// Skip a C string literal starting at the opening `"` (index i). Returns the index of the byte
// AFTER the closing `"` (or the end of source on unterminated input).
function skipStringLiteral(source, start) {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return i;
}

function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return out;
      out += "  ";
      i = end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i + 2);
      if (end === -1) return out;
      i = end;
      continue;
    }
    if (ch === '"') {
      out += '""';
      i = skipStringLiteral(source, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

async function assertWindowsSourceContract() {
  const nativeSource = stripCommentsAndStrings(await readFile(source, "utf8"));
  // Windows reserved stems come from WINDOWS_RESERVED_STEMS, and the `"${stem}"` check below
  // reads string literals — but those literals are ALSO in the raw source, not comments. Read
  // the raw text again for that one check so comment-stripping does not blank the very literals
  // this contract exists to pin.
  const nativeSourceRaw = await readFile(source, "utf8");
  assert.match(nativeSource, /GetFinalPathNameByHandleW\(root,/u);
  assert.match(nativeSource, /GetFinalPathNameByHandleW\(file,/u);
  assert.match(
    nativeSource,
    /before\.id\.VolumeSerialNumber != dirs\[0\]\.id\.VolumeSerialNumber/u,
  );
  assert.match(nativeSource, /OBJ_DONT_REPARSE/u);
  assert.match(nativeSource, /_write\(3, &byte, 1\).*_read\(4, &byte, 1\)/su);
  assert.match(nativeSource, /#include <fcntl\.h>.*#include <io\.h>/su);
  assert.match(
    nativeSource,
    /_setmode\(_fileno\(stdin\), _O_BINARY\).*_setmode\(_fileno\(stdout\), _O_BINARY\)/su,
  );
  assert.match(nativeSource, /if \(!binary_standard_io\(\)\) return 1;.*parse_request\(/su);
  for (const stem of WINDOWS_RESERVED_STEMS) assert.ok(nativeSourceRaw.includes(`"${stem}"`));
  assert.match(nativeSource, /while \(name_length < length && component\[name_length\] != '\.'\)/u);
  assert.match(nativeSourceRaw, /ascii_name_equals\(component, name_length, "GLOBALROOT"\)/u);
  assert.match(nativeSource, /windows_reserved_port_name\(component, name_length\)/u);
  assert.match(nativeSource, /bytes\[3\] == 0xc2/u);
  assert.match(nativeSource, /bytes\[4\] == 0xb9 \|\| bytes\[4\] == 0xb2 \|\| bytes\[4\] == 0xb3/u);
  assert.match(nativeSource, /_Static_assert\(sizeof\(KSR_SUPERSCRIPT_ONE_UTF8\) == 3/u);
  assert.doesNotMatch(nativeSource, /char name\[10\]/u);
  assert.match(nativeSource, /\*q == ':' \|\| \*q == '\?' \|\| \*q == '~'/u);
  assert.equal(nativeSource.match(/CreateFileW\(/gu)?.length, 1);

  // KEIKO-0417 negative self-test: proves stripCommentsAndStrings is load-bearing rather than
  // decorative. Take the real source, move `OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE`'s use site
  // AND the single `CreateFileW(` call into `/* ... */` comments, and re-run the two matches
  // those pinned. A raw scan would still find both tokens (they sit inside the comment); the
  // stripped scan must not. If either check fails, the 17 assertions above are only pinning text
  // that survived in a comment.
  const mutated = nativeSourceRaw
    .replace(
      /OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE/u,
      "/* OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE */ 0",
    )
    .replace(/CreateFileW\(/u, "/* CreateFileW( */ NopW(");
  const mutatedStripped = stripCommentsAndStrings(mutated);
  assert.equal(
    mutatedStripped.match(/OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE/u),
    null,
    "stripCommentsAndStrings must remove OBJ_DONT_REPARSE hidden in a block comment",
  );
  assert.equal(
    (mutatedStripped.match(/CreateFileW\(/gu) ?? []).length,
    0,
    "stripCommentsAndStrings must remove CreateFileW( hidden in a block comment",
  );
}

async function setupFixture(fixture, outside) {
  await mkdir(join(fixture, "nested"));
  await mkdir(join(outside, "outside-dir"));
  await writeFile(join(fixture, "nested", "good.txt"), SAFE_TEXT);
  await writeFile(join(fixture, "unicode.txt"), "Grüße 東京\n");
  await writeFile(join(fixture, "allowed-controls.txt"), "a\tb\r\n");
  await writeFile(join(fixture, "binary.txt"), Buffer.from([0x61, 0, 0x62]));
  await writeFile(join(fixture, "invalid-utf8.txt"), Buffer.from([0xc3, 0x28]));
  await writeFile(join(fixture, "c0.txt"), Buffer.from([0x61, 1, 0x62]));
  await writeFile(join(fixture, "c1.txt"), Buffer.from([0xc2, 0x80]));
  await writeFile(join(fixture, "exact.txt"), "x".repeat(65_536));
  await writeFile(join(fixture, "large.txt"), "x".repeat(65_537));
  await writeFile(join(fixture, "hard-source.txt"), "linked content");
  for (const name of WINDOWS_RESERVED_PREFIX_ALLOWED)
    await writeFile(join(fixture, name), SAFE_TEXT);
  await writeFile(join(outside, "outside.txt"), "outside\n");
  await writeFile(join(outside, "outside-dir", "outside.txt"), "outside\n");
  await symlink(
    join(outside, "outside-dir"),
    join(fixture, "linked"),
    isWindows ? "junction" : "dir",
  );
  await symlink(
    join(outside, isWindows ? "outside-dir" : "outside.txt"),
    join(fixture, "final-link.txt"),
    isWindows ? "junction" : "file",
  );
  await symlink(fixture, join(outside, "root-alias"), isWindows ? "junction" : "dir");
  await link(join(fixture, "hard-source.txt"), join(fixture, "hard-link.txt"));
  let deep = fixture;
  for (let index = 0; index < 65; index += 1) {
    deep = join(deep, `d${index}`);
    await mkdir(deep);
  }
  await writeFile(
    join(fixture, Array.from({ length: 63 }, (_, index) => `d${index}`).join("/"), "deep.txt"),
    "deep",
  );
  await writeFile(join(deep, "deep.txt"), "deep");
}

async function assertProtocolCases(binary, fixture, outside) {
  assertSafeResult(await run(binary, request(fixture, "nested/good.txt")));
  assert.equal(response(await run(binary, request(fixture, "unicode.txt"))).status, 0);
  assert.equal(response(await run(binary, request(fixture, "allowed-controls.txt"))).status, 0);
  for (const raw of [Buffer.alloc(0), Buffer.from("bad"), Buffer.alloc(20)]) {
    assert.equal(response(await run(binary, raw)).status, 1);
  }
  assert.equal(response(await run(binary, request(fixture, "../outside.txt"))).status, 3);
  assert.equal(response(await run(binary, request(fixture, "/absolute.txt"))).status, 3);
  assert.equal(
    response(await run(binary, request(fixture, String.raw`nested\good.txt`))).status,
    3,
  );
  assert.equal(response(await run(binary, request(fixture, "linked/outside.txt"))).status, 4);
  assert.equal(response(await run(binary, request(fixture, "final-link.txt"))).status, 4);
  assert.equal(
    response(await run(binary, request(join(outside, "root-alias"), "nested/good.txt"))).status,
    4,
  );
  assert.equal(response(await run(binary, request(fixture, "hard-link.txt"))).status, 5);
  assert.equal(response(await run(binary, request(fixture, "nested"))).status, isWindows ? 4 : 5);
  for (const name of ["binary.txt", "invalid-utf8.txt", "c0.txt", "c1.txt"]) {
    assert.equal(response(await run(binary, request(fixture, name))).status, 7);
  }
  assert.equal(response(await run(binary, request(fixture, "exact.txt"))).content.length, 65_536);
  assert.equal(response(await run(binary, request(fixture, "large.txt"))).status, 6);
  assert.equal(
    response(await run(binary, request(fixture, "nested/good.txt", { trailing: Buffer.of(1) })))
      .status,
    1,
  );
  assert.equal(
    response(await run(binary, request(fixture, "nested/good.txt", { cap: 1 }))).status,
    1,
  );
  const path64 = deepRelativePath(63);
  const path65 = deepRelativePath(64);
  assert.equal(response(await run(binary, request(fixture, path64))).status, 0);
  assert.equal(response(await run(binary, request(fixture, path65))).status, 3);
  if (isWindows) await assertWindowsPolicies(binary, fixture);
  else {
    assert.equal(response(await run(binary, request("/", "dev/null"))).status, 4);
    assert.equal(response(await run(binary, request("/dev", "null"))).status, 5);
  }

  await assertMalformedFrameGuards(binary, fixture);
}

// KEIKO-0382: negative coverage for the ten frame-parser guards. Each case pins one guard by
// constructing a frame the helper must reject with status 1 (KSR_MALFORMED_REQUEST). Kept
// platform-agnostic and run for every configuration — the parser is the same on every platform
// and its guards are part of the trust boundary at every stage.
function buildMalformedFrameCases(fixture) {
  const rootBytes = Buffer.from(fixture, "utf8");
  const pathBytes = Buffer.from("nested/good.txt", "utf8");
  const nulPath = Buffer.concat([
    Buffer.from("a", "utf8"),
    Buffer.of(0x00),
    Buffer.from("b", "utf8"),
  ]);
  return [
    // Header says more root/path bytes than actually appended: read overruns the frame.
    {
      label: "declared rootLen exceeds supplied root bytes",
      frame: malformedRequest({ root: fixture, pathBytes, declaredRootLen: rootBytes.length + 1 }),
    },
    {
      label: "declared pathLen exceeds supplied path bytes",
      frame: malformedRequest({ root: fixture, pathBytes, declaredPathLen: pathBytes.length + 1 }),
    },
    // Zero-length root or path: no request the helper is meant to serve.
    { label: "declared rootLen == 0", frame: malformedRequest({ root: "", pathBytes }) },
    { label: "declared pathLen == 0", frame: malformedRequest({ root: fixture }) },
    // Size cap breaches: proves the constants are actually enforced, not just declared.
    {
      label: "rootLen > KSR_MAX_ROOT",
      frame: malformedRequest({ root: "x".repeat(HARNESS_KSR_MAX_ROOT + 1), pathBytes }),
    },
    {
      label: "pathLen > KSR_MAX_PATH",
      frame: malformedRequest({
        root: fixture,
        pathBytes: Buffer.from("x".repeat(HARNESS_KSR_MAX_PATH + 1), "utf8"),
      }),
    },
    // Reserved half-word must be zero. Confirmed never set on any well-formed frame today; a
    // non-zero value is a forward-compatibility violation and must fail closed.
    {
      label: "non-zero reserved u16",
      frame: malformedRequest({ root: fixture, pathBytes, reserved: 1 }),
    },
    // Wrong protocol version.
    { label: "version != 1", frame: malformedRequest({ root: fixture, pathBytes, version: 2 }) },
    // Path payloads that violate the well-formedness rules (NUL byte, invalid UTF-8).
    {
      label: "path contains an interior NUL byte",
      frame: malformedRequest({ root: fixture, pathBytes: nulPath }),
    },
    {
      label: "path is invalid UTF-8",
      frame: malformedRequest({ root: fixture, pathBytes: Buffer.of(0xc3, 0x28) }),
    },
  ];
}

async function assertMalformedFrameGuards(binary, fixture) {
  for (const { label, frame } of buildMalformedFrameCases(fixture)) {
    const status = response(await run(binary, frame)).status;
    assert.equal(status, 1, `expected status 1 (malformed) for: ${label}, got ${String(status)}`);
  }
}

function deepRelativePath(directoryCount) {
  const directories = Array.from({ length: directoryCount }, (_, index) => `d${index}`);
  return `${directories.join("/")}/deep.txt`;
}

async function assertWindowsPolicies(binary, fixture) {
  for (const denied of WINDOWS_RESERVED_DENIED) {
    assert.equal(
      response(await run(binary, request(fixture, denied))).status,
      3,
      `Windows reserved-name policy mismatch for ${JSON.stringify(denied)}`,
    );
  }
  for (const allowed of WINDOWS_RESERVED_PREFIX_ALLOWED) {
    assert.equal(
      response(await run(binary, request(fixture, allowed))).status,
      0,
      `Windows reserved-name prefix was over-rejected: ${JSON.stringify(allowed)}`,
    );
  }
  for (const denied of ["nested/good.txt:stream", "name?", "name.", "name ", "PROGRA~1"]) {
    assert.equal(
      response(await run(binary, request(fixture, denied))).status,
      3,
      `Windows path policy mismatch for ${JSON.stringify(denied)}`,
    );
  }
  for (const invalidRoot of ["C:relative", String.raw`\\server\share`, "relative"]) {
    assert.equal(
      response(await run(binary, request(invalidRoot, "safe.txt"))).status,
      1,
      `Windows root policy mismatch for ${JSON.stringify(invalidRoot)}`,
    );
  }
}

function assertRaceResult(result, label) {
  const decoded = response(result);
  assert.ok(
    [0, 6, 8].includes(decoded.status),
    `${label}: unexpected race status ${decoded.status}`,
  );
  if (decoded.status === 0)
    assert.equal(decoded.content.toString("utf8"), SAFE_TEXT, `${label}: unsafe content`);
  return decoded;
}

async function resetRaceFile(fixture) {
  await writeFile(join(fixture, "nested", "race.txt"), SAFE_TEXT);
}

async function assertAdversarialRaces(binary, fixture) {
  const nested = join(fixture, "nested");
  const target = join(nested, "race.txt");
  const moved = join(fixture, "moved-nested");
  const race = (mutate) => runPaused(binary, request(fixture, "nested/race.txt"), mutate);
  await resetRaceFile(fixture);
  assertRaceResult(await race(() => writeFile(target, "evil text\n")), "in-place rewrite");
  await resetRaceFile(fixture);
  assertRaceResult(await race(() => writeFile(target, "x".repeat(65_537))), "size growth");
  await resetRaceFile(fixture);
  const replacementResult = await race(async () => {
    const replacement = join(fixture, "replacement.txt");
    await writeFile(replacement, "replacement\n");
    await rename(replacement, target);
  });
  const replacementResponse = assertRaceResult(replacementResult, "replacement");
  if (replacementResult.mutationDenied)
    assert.equal(
      replacementResponse.status,
      8,
      "replacement: root mutation before denied target rename must close",
    );
  await resetRaceFile(fixture);
  assertRaceResult(
    await race(async () => {
      await rename(nested, moved);
      await rename(moved, nested);
    }),
    "ancestor rename round trip",
  );
  await resetRaceFile(fixture);
  let movedAway = false;
  try {
    assertRaceResult(
      await race(async () => {
        await rename(nested, moved);
        movedAway = true;
        await mkdir(nested);
        await writeFile(target, "replacement\n");
      }),
      "ancestor substitution",
    );
  } finally {
    if (movedAway) {
      await rm(nested, { recursive: true, force: true });
      await rename(moved, nested);
    }
  }
}

function isSharingDenied(error) {
  return isWindows && ["EACCES", "EBUSY", "EPERM"].includes(error?.code);
}

async function restoreRename(sourcePath, destinationPath) {
  let lastError;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (!isSharingDenied(error)) throw error;
      lastError = error;
      await delay(5);
    }
  }
  throw lastError;
}

async function runConcurrentUpdater(label, update, read) {
  let active = true;
  let readsStarted = false;
  let attempts = 0;
  let postSpawnAttempts = 0;
  let sharingDenied = 0;
  let updaterError;
  let notifyStarted;
  const started = new Promise((resolveStarted) => {
    notifyStarted = resolveStarted;
  });
  const updater = (async () => {
    try {
      while (active) {
        attempts += 1;
        if (readsStarted) postSpawnAttempts += 1;
        try {
          await update(attempts);
        } catch (error) {
          if (isSharingDenied(error)) sharingDenied += 1;
          else throw error;
        } finally {
          notifyStarted();
        }
        await nextTurn();
      }
    } catch (error) {
      updaterError = error;
      active = false;
      notifyStarted();
    }
  })();
  await started;
  if (updaterError !== undefined) throw updaterError;
  readsStarted = true;
  try {
    await Promise.all(Array.from({ length: CONCURRENT_CONSISTENCY_READS }, read));
  } finally {
    readsStarted = false;
    active = false;
    await updater;
  }
  if (updaterError !== undefined) throw updaterError;
  assert.ok(postSpawnAttempts > 0, `${label} updater made no post-spawn attempt`);
  console.log(
    `secure-workspace-read consistency: case=${label} reads=${CONCURRENT_CONSISTENCY_READS} attempts=${attempts} postSpawnAttempts=${postSpawnAttempts} sharingDenied=${sharingDenied}`,
  );
}

// KEIKO-0446: returns whether this read actually observed a known generation, so the caller can
// require that at least one did. It used to return void on every non-zero status, which made the
// whole suite vacuous — see the liveness assertion in assertFileGenerationConsistency.
function assertKnownGeneration(result, generations) {
  const decoded = response(result);
  if (decoded.status !== 0) return false;
  assert.ok(
    generations.some((generation) => decoded.content.equals(generation)),
    "successful concurrent read returned external, partial, or mixed bytes",
  );
  return true;
}

async function assertFileGenerationConsistency(binary, fixture) {
  const target = join(fixture, "concurrent-generation.txt");
  const generations = [
    Buffer.from(`${"a".repeat(2_584)}\n`),
    Buffer.from(`${"b".repeat(32_767)}\n`),
  ];
  await writeFile(target, generations[0]);
  // KEIKO-0446: every non-zero status was silently accepted, and nothing required a single read to
  // succeed. A helper that answered KSR_ACCESS_DENIED (or CHANGED_DURING_READ, or MALFORMED) to all
  // 32 reads passed this suite unchanged — the suite proved only "no read returned WRONG bytes",
  // never "reads work". The target here is a plain regular file inside the fixture root, only ever
  // replaced atomically by rename, so a correct helper must succeed on a substantial fraction.
  let successfulReads = 0;
  await runConcurrentUpdater(
    "file-generation",
    async (attempt) => {
      const staged = join(fixture, `.concurrent-generation-${attempt}.tmp`);
      await writeFile(staged, generations[attempt % generations.length]);
      try {
        await rename(staged, target);
      } finally {
        await rm(staged, { force: true });
      }
    },
    async () => {
      if (
        assertKnownGeneration(
          await run(binary, request(fixture, "concurrent-generation.txt")),
          generations,
        )
      ) {
        successfulReads += 1;
      }
    },
  );
  assert.ok(
    successfulReads > 0,
    `file-generation consistency: none of the ${String(CONCURRENT_CONSISTENCY_READS)} concurrent ` +
      "reads observed a known generation — a helper that fails closed under all contention would " +
      "satisfy every other assertion in this suite",
  );
}

async function assertAncestorAliasConsistency(binary, fixture, outside) {
  const parent = join(fixture, "concurrent-parent");
  const parked = join(fixture, ".concurrent-parent-parked");
  const alias = join(fixture, ".concurrent-parent-alias");
  const outsideParent = join(outside, "concurrent-parent");
  await mkdir(parent);
  await mkdir(outsideParent);
  await writeFile(join(parent, "generation.txt"), SAFE_TEXT);
  await writeFile(join(outsideParent, "generation.txt"), "external bytes\n");
  await symlink(outsideParent, alias, isWindows ? "junction" : "dir");
  try {
    await runConcurrentUpdater(
      "ancestor-alias",
      async () => {
        let aliasInstalled = false;
        await rename(parent, parked);
        try {
          await rename(alias, parent);
          aliasInstalled = true;
          try {
            await nextTurn();
          } finally {
            await restoreRename(parent, alias);
            aliasInstalled = false;
          }
        } finally {
          if (!aliasInstalled) await restoreRename(parked, parent);
        }
      },
      async () => {
        assertKnownGeneration(
          await run(binary, request(fixture, "concurrent-parent/generation.txt")),
          [Buffer.from(SAFE_TEXT)],
        );
      },
    );
  } finally {
    await rm(alias, { force: true });
  }
}

async function assertExternalBinaryConsistency(binary, fixture, outside) {
  await assertFileGenerationConsistency(binary, fixture);
  await assertAncestorAliasConsistency(binary, fixture, outside);
}

async function stableResourceCount() {
  const samples = [];
  for (let index = 0; index < 7; index += 1) {
    if (isWindows) samples.push(await windowsHandleCount());
    else samples.push((await readdir("/dev/fd")).length);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
}

async function windowsHandleCount() {
  const powershell = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
  return new Promise((resolveCount, reject) => {
    const child = spawn(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).HandleCount`],
      { env: {}, stdio: ["ignore", "pipe", "ignore"] },
    );
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const count = Number(Buffer.concat(output).toString("ascii").trim());
      if (code === 0 && Number.isSafeInteger(count)) resolveCount(count);
      else reject(new Error("resource probe failed"));
    });
  });
}

async function assertLoadEvidence(binary, fixture) {
  const frame = request(fixture, "nested/good.txt");
  assertSafeResult(await run(binary, frame));
  const before = await stableResourceCount();
  const durations = [];
  for (let index = 0; index < 1_000; index += 1) {
    const result = await run(binary, frame);
    assertSafeResult(result);
    durations.push(result.durationMs);
  }
  durations.sort((left, right) => left - right);
  const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95Ms <= 500, `sequential p95 exceeded 500ms: ${p95Ms.toFixed(1)}ms`);
  const started = performance.now();
  const concurrent = await Promise.all(Array.from({ length: 100 }, () => run(binary, frame)));
  const batchMs = performance.now() - started;
  concurrent.forEach(assertSafeResult);
  assert.ok(batchMs <= 10_000, `concurrent batch exceeded 10s: ${batchMs.toFixed(1)}ms`);
  const after = await stableResourceCount();
  assert.equal(after, before, "helper load test leaked parent resources");
  console.log(
    `secure-workspace-read load: sequential=1000 p95Ms=${p95Ms.toFixed(1)} concurrent=100 batchMs=${batchMs.toFixed(1)} resourceDelta=0`,
  );
}

function existingBinaryArgument(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--binary" || argv[1].length === 0)
    throw new Error("usage: test-protocol.mjs [--binary <existing-helper>]");
  return resolve(argv[1]);
}

if (!isWindows && process.platform !== "darwin") {
  throw new Error("secure-workspace-read executable harness supports only Windows and macOS");
}

const externalBinary = existingBinaryArgument(process.argv.slice(2));
const externalBinaryBytes =
  externalBinary === undefined ? undefined : await readFile(externalBinary);
let binaryRoot;
let fixture;
let outside;
try {
  binaryRoot = externalBinary === undefined ? await mkdtemp(join(tmpdir(), "ksr-bin-")) : undefined;
  fixture = await mkdtemp(join(tmpdir(), "ksr-fixture-"));
  outside = await mkdtemp(join(tmpdir(), "ksr-outside-"));
  const binary =
    externalBinary ??
    join(binaryRoot, isWindows ? "secure-workspace-read.exe" : "secure-workspace-read");
  const pausedBinaryName = isWindows
    ? "secure-workspace-read-paused.exe"
    : "secure-workspace-read-paused";
  const pausedBinary = binaryRoot === undefined ? undefined : join(binaryRoot, pausedBinaryName);
  await assertWindowsSourceContract();
  if (externalBinary === undefined) {
    await compile(binary);
    await compile(pausedBinary, true);
  }
  await setupFixture(fixture, outside);
  await assertProtocolCases(binary, fixture, outside);
  // Signed --binary runs protocol, live fixture consistency, and load checks against the exact
  // supplied bytes. Deterministically paused races require the compile-mode test companion.
  if (pausedBinary !== undefined) await assertAdversarialRaces(pausedBinary, fixture);
  if (externalBinary !== undefined) await assertExternalBinaryConsistency(binary, fixture, outside);
  await assertLoadEvidence(binary, fixture);
  if (externalBinaryBytes !== undefined)
    assert.deepEqual(
      await readFile(binary),
      externalBinaryBytes,
      "harness modified supplied binary",
    );
  console.log(`secure-workspace-read protocol tests: PASS (${basename(binary)})`);
} finally {
  if (fixture !== undefined) await rm(fixture, { recursive: true, force: true });
  if (outside !== undefined) await rm(outside, { recursive: true, force: true });
  if (binaryRoot !== undefined) await rm(binaryRoot, { recursive: true, force: true });
}
