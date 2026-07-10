import { Buffer } from "node:buffer";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogForInventory,
  inventoriesMatch,
  inventoryPathsMatch,
  inventoryWindowsPortablePeFiles,
} from "../windows-portable-signing.mjs";

const roots = [];

function root() {
  const path = mkdtempSync(join(tmpdir(), "keiko-windows-signing-"));
  roots.push(path);
  return path;
}

function portableExecutable(marker = 0) {
  const bytes = Buffer.alloc(128, marker);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0x00, 0x00], 64);
  return bytes;
}

function write(path, bytes = portableExecutable()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function validPayload() {
  const payload = root();
  write(join(payload, "Keiko.exe"), portableExecutable(1));
  write(join(payload, "runtime", "node", "node.exe"), portableExecutable(2));
  write(join(payload, "runtime", "sidecars", "worker", "worker.node"), portableExecutable(3));
  write(join(payload, "app", "native-addon.bin"), portableExecutable(4));
  write(join(payload, "app", "README.md"), Buffer.from("not executable"));
  return payload;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("Windows portable PE signing inventory", () => {
  it("finds every PE by content, including non-exe runtime files, in deterministic order", () => {
    const inventory = inventoryWindowsPortablePeFiles(validPayload());

    expect(inventory.files.map((file) => file.relativePath)).toEqual([
      "app/native-addon.bin",
      "Keiko.exe",
      "runtime/node/node.exe",
      "runtime/sidecars/worker/worker.node",
    ]);
    expect(inventory.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
    expect(catalogForInventory(inventory)).toBe(
      [
        "payload/Keiko/app/native-addon.bin",
        "payload/Keiko/Keiko.exe",
        "payload/Keiko/runtime/node/node.exe",
        "payload/Keiko/runtime/sidecars/worker/worker.node",
        "",
      ].join("\n"),
    );
  });

  it("fails closed when a required launcher is absent or an exe/dll is not PE", () => {
    const missingLauncher = root();
    write(join(missingLauncher, "runtime", "node", "node.exe"));
    expect(() => inventoryWindowsPortablePeFiles(missingLauncher)).toThrow(
      /Keiko\.exe is missing/u,
    );

    const malformed = validPayload();
    write(join(malformed, "app", "unsigned.dll"), Buffer.from("not PE"));
    expect(() => inventoryWindowsPortablePeFiles(malformed)).toThrow(/not valid PE/u);
  });

  it("rejects links and hard links so one catalog path cannot alias another file", () => {
    const linked = validPayload();
    symlinkSync(join(linked, "Keiko.exe"), join(linked, "alias.exe"));
    expect(() => inventoryWindowsPortablePeFiles(linked)).toThrow(/link or reparse/u);

    const hardLinked = validPayload();
    linkSync(join(hardLinked, "Keiko.exe"), join(hardLinked, "alias.exe"));
    expect(() => inventoryWindowsPortablePeFiles(hardLinked)).toThrow(/hard-linked/u);
  });

  it("distinguishes path-set changes from expected signature byte changes", () => {
    const before = inventoryWindowsPortablePeFiles(validPayload());
    const after = JSON.parse(JSON.stringify(before));
    after.files[0].sha256 = "f".repeat(64);

    expect(inventoryPathsMatch(before, after)).toBe(true);
    expect(inventoriesMatch(before, after)).toBe(false);
    after.files.pop();
    expect(inventoryPathsMatch(before, after)).toBe(false);
  });
});
