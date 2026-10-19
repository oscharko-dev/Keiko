import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const native = fileURLToPath(new URL("../../../native/runtime-supervisor/macos/", import.meta.url));
const fixture = fileURLToPath(
  new URL("../../../tests/fixtures/macos-owned-wait-main.c", import.meta.url),
);

function definition(source, name) {
  const match = new RegExp(`^(?:static[^\\n]*|int)\\b[^\\n]*\\b${name}\\s*\\(`, "mu").exec(source);
  if (match === null) throw new TypeError("Missing actual supervisor function");
  const end = source.indexOf("\n}", match.index);
  if (end < 0) throw new TypeError("Missing actual supervisor function boundary");
  return source.slice(match.index, end + 2);
}

function declaration(source, name) {
  const start = source.indexOf(`enum ${name} {`);
  const end = source.indexOf("};", start);
  if (start < 0 || end < 0) throw new TypeError("Missing actual supervisor enumeration");
  return source.slice(start, end + 2);
}

export function compileMacOwnedWaitFixture(directory, source) {
  const timeout = /^#define KRP_CHILD_REAP_TIMEOUT_MS[^\n]+/mu.exec(source)?.[0];
  if (timeout === undefined) throw new TypeError("Missing actual supervisor wait bound");
  const functions = ["write_u32", "child_reap_time", "wait_owned_root", "supervise", "main"];
  writeFileSync(
    join(directory, "owner-under-test.h"),
    functions.map((name) => definition(source, name)).join("\n"),
  );
  writeFileSync(
    join(directory, "owner-declarations.h"),
    [timeout, declaration(source, "response_kind"), declaration(source, "error_code")].join("\n"),
  );
  const executable = join(directory, "fixture");
  const result = spawnSync(
    process.platform === "darwin" ? "/usr/bin/clang" : "cc",
    [
      "-std=c17",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      native,
      "-I",
      directory,
      fixture,
      "-o",
      executable,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.error !== undefined || result.status !== 0)
    throw new Error(`Actual supervisor fixture compilation failed: ${result.stderr}`);
  return executable;
}
