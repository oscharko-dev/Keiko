import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const [target, destination] = process.argv.slice(2);
const source = resolve("native/secure-workspace-read/secure_workspace_read.c");
const supported = new Map([
  [
    "macos-arm64",
    [
      "xcrun",
      [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        "-arch",
        "arm64",
      ],
    ],
  ],
  [
    "macos-x64",
    [
      "xcrun",
      [
        "clang",
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-D_DARWIN_C_SOURCE",
        "-arch",
        "x86_64",
      ],
    ],
  ],
  [
    "windows-x64",
    [
      "cl",
      [
        "/nologo",
        "/std:c11",
        "/W4",
        "/WX",
        "/O2",
        "/DUNICODE",
        "/D_UNICODE",
        "/D_CRT_SECURE_NO_WARNINGS",
        "/Fe:",
      ],
    ],
  ],
]);

if (
  process.argv.length !== 4 ||
  !supported.has(target) ||
  !destination ||
  !isAbsolute(destination)
) {
  process.exitCode = 2;
} else {
  const output = resolve(destination);
  await mkdir(dirname(output), { recursive: true });
  const [compiler, flags] = supported.get(target);
  const args =
    target === "windows-x64"
      ? [...flags, output, source, "/link", "ntdll.lib"]
      : [...flags, "-o", output, source];
  const result = spawnSync(compiler, args, {
    stdio: "inherit",
    env: { PATH: process.env.PATH ?? "" },
  });
  process.exitCode = result.status ?? 1;
}
