import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault, type MemoryVaultStore } from "@oscharko-dev/keiko-memory-vault";
import type { MemoryId, MemoryRecord, MemoryUserId } from "@oscharko-dev/keiko-contracts";
import { runMemoryCli } from "./memory.js";
import type { CliIo } from "./runner.js";

function capture(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t: string): void => {
        out += t;
      },
      err: (t: string): void => {
        err += t;
      },
    },
    out: (): string => out,
    err: (): string => err,
  };
}

const tmpDirs: string[] = [];
const vaults: MemoryVaultStore[] = [];

afterEach(() => {
  for (const vault of vaults.splice(0)) {
    try {
      vault.close();
    } catch {
      // ignore
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeVault(): MemoryVaultStore {
  const dir = mkdtempSync(join(tmpdir(), "keiko-cli-mem-"));
  tmpDirs.push(dir);
  const vault = createMemoryVault({ memoryDir: dir, redactString: (s) => s });
  vaults.push(vault);
  return vault;
}

function mid(value: string): MemoryId {
  return value as unknown as MemoryId;
}

function insert(
  vault: MemoryVaultStore,
  options: { id: string; status?: MemoryRecord["status"]; createdAt?: number; validUntil?: number },
): MemoryRecord {
  const createdAt = options.createdAt ?? Date.now();
  return vault.insertMemory({
    id: mid(options.id),
    schemaVersion: "1",
    scope: { kind: "user", userId: "u-1" as unknown as MemoryUserId },
    type: "preference",
    body: "prefers dark mode",
    provenance: {
      sourceKind: "explicit-user-instruction",
      capturedAt: createdAt,
      confidence: 0.9,
      sensitivity: "confidential",
    },
    validity:
      options.validUntil === undefined
        ? { validFrom: createdAt }
        : { validFrom: createdAt, validUntil: options.validUntil },
    status: options.status ?? "accepted",
    pinned: false,
    tags: [],
    createdAt,
    updatedAt: createdAt,
  });
}

describe("runMemoryCli — usage and dispatch", () => {
  it("prints usage and exits 2 with no subcommand", () => {
    const cap = capture();
    expect(runMemoryCli([], cap.io, {})).toBe(2);
    expect(cap.out()).toContain("keiko memory maintain");
  });

  it("prints usage and exits 0 for --help", () => {
    const cap = capture();
    expect(runMemoryCli(["--help"], cap.io, {})).toBe(0);
    expect(cap.out()).toContain("keiko memory stats");
  });

  it("exits 2 on an unknown subcommand", () => {
    const cap = capture();
    expect(runMemoryCli(["frobnicate"], cap.io, {})).toBe(2);
    expect(cap.err()).toContain("unknown subcommand");
  });
});

describe("runMemoryCli stats", () => {
  it("prints counts by status, scope, and total", () => {
    const vault = makeVault();
    insert(vault, { id: "a", status: "accepted" });
    insert(vault, { id: "b", status: "accepted" });
    insert(vault, { id: "c", status: "proposed" });
    const cap = capture();
    expect(runMemoryCli(["stats"], cap.io, {}, { vault })).toBe(0);
    const out = cap.out();
    expect(out).toContain("By status:");
    expect(out).toContain("accepted: 2");
    expect(out).toContain("proposed: 1");
    expect(out).toContain("user: 3");
    expect(out).toContain("Total: 3");
  });

  it("reports an empty vault cleanly", () => {
    const vault = makeVault();
    const cap = capture();
    expect(runMemoryCli(["stats"], cap.io, {}, { vault })).toBe(0);
    expect(cap.out()).toContain("Total: 0");
  });
});

describe("runMemoryCli maintain", () => {
  it("runs the in-process pass and prints the applied counts", () => {
    const vault = makeVault();
    // An expired memory is forgotten; the report surfaces forgotten: 1.
    insert(vault, {
      id: "m",
      status: "accepted",
      createdAt: Date.now() - 864e5,
      validUntil: Date.now() - 1,
    });
    const cap = capture();
    expect(runMemoryCli(["maintain"], cap.io, {}, { vault })).toBe(0);
    const out = cap.out();
    expect(out).toContain("Memory maintenance complete.");
    expect(out).toContain("forgotten:         1");
    expect(vault.getMemory(mid("m"))).toBeUndefined();
  });
});

describe("runMemoryCli error handling", () => {
  it("exits 1 and prints the message when the vault factory throws", () => {
    const cap = capture();
    const code = runMemoryCli(
      ["stats"],
      cap.io,
      {},
      {
        openVault: () => {
          throw new Error("vault is locked");
        },
      },
    );
    expect(code).toBe(1);
    expect(cap.err()).toContain("vault is locked");
  });
});
