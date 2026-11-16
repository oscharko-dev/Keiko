#!/usr/bin/env node

import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import corepackManifest from "corepack/package.json" with { type: "json" };

const modulePath = fileURLToPath(import.meta.url);
const corepackPackageRoot = dirname(fileURLToPath(import.meta.resolve("corepack/package.json")));

function shimSource() {
  if (process.platform === "win32") {
    // Pin the Node that prepared the fixture. Quoting handles spaces; cmd expands
    // percent variables even inside quotes, so escape literal percent signs in the batch file.
    const node = process.execPath.replaceAll("%", "%%");
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${node}" "%~dp0..\\package\\dist\\corepack.js" %*\r\n`;
  }
  return [
    "#!/bin/sh",
    'SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
    'exec node "$SCRIPT_DIR/../package/dist/corepack.js" "$@"',
    "",
  ].join("\n");
}

export function prepareTrustedCorepack(options = {}) {
  const runtimeRoot = options.runtimeRoot ?? dirname(dirname(process.execPath));
  const sourceRoot = options.sourceRoot ?? corepackPackageRoot;
  const installRoot = mkdtempSync(join(runtimeRoot, "keiko-corepack."));
  const packageRoot = join(installRoot, "package");
  const binDir = join(installRoot, "bin");
  cpSync(sourceRoot, packageRoot, { errorOnExist: true, force: false, recursive: true });
  mkdirSync(binDir);
  const shimPath = join(binDir, process.platform === "win32" ? "corepack.cmd" : "corepack");
  writeFileSync(shimPath, shimSource(), "utf8");
  chmodSync(shimPath, 0o755);
  return { binDir, packageRoot, version: corepackManifest.version };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === modulePath) {
  process.stdout.write(`${prepareTrustedCorepack().binDir}\n`);
}
