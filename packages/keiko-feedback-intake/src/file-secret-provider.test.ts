import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSecretProvider } from "./file-secret-provider.js";
import type { KeyDeletionEvidence, KeyDeletionLedger } from "./file-secret-provider.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "feedback-key-provider-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function key(root: string, date: string, fill: number, kind: "abuse" | "dedupe" = "abuse"): void {
  const id = `${kind === "dedupe" ? "dedupe-v1:" : ""}${date}`;
  const path = join(root, `key-${date}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id,
      activatedAt: `${date}T00:00:00.000Z`,
      key: Buffer.alloc(32, fill).toString("base64"),
    }),
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
}

function emptyLedger(): KeyDeletionLedger {
  return {
    pendingDeletions: () => Promise.resolve([]),
    beginDeletion: () => Promise.resolve(),
    completeDeletion: () => Promise.resolve(),
  };
}

describe("durable feedback key custody", () => {
  it("records closed deletion evidence only after durable key destruction", async () => {
    const root = directory();
    key(root, "2026-07-09", 5);
    key(root, "2026-07-10", 6);
    const at = new Date("2026-07-11T00:00:00Z");
    const observed: string[] = [];
    const ledger: KeyDeletionLedger = {
      pendingDeletions: () => Promise.resolve([]),
      beginDeletion: (evidence) => {
        expect(readdirSync(root)).toContain("key-2026-07-09.json");
        observed.push(JSON.stringify(evidence));
        return Promise.resolve();
      },
      completeDeletion: (evidence) => {
        expect(readdirSync(root)).not.toContain("key-2026-07-09.json");
        observed.push(JSON.stringify(evidence));
        return Promise.resolve();
      },
    };
    const provider = new FileSecretProvider({
      directory: root,
      kind: "abuse",
      now: (): Date => new Date("2026-07-10T12:00:00Z"),
    });

    await provider.purgeRetired(at, () => Promise.resolve(false), ledger);

    expect(observed).toEqual([
      JSON.stringify({ keyClass: "abuse", keyId: "2026-07-09", timestamp: at, result: "pending" }),
      JSON.stringify({
        keyClass: "abuse",
        keyId: "2026-07-09",
        timestamp: at,
        result: "destroyed",
      }),
    ]);
  });

  it("destroys only repository-cleared material and reloads after operator activation", async () => {
    const root = directory();
    key(root, "2026-07-09", 5);
    key(root, "2026-07-10", 6);
    const activeTime = new Date("2026-07-10T12:00:00Z");
    const boundary = new Date("2026-07-11T00:00:00Z");
    const first = new FileSecretProvider({
      directory: root,
      kind: "abuse",
      now: (): Date => activeTime,
    });

    const ledger = emptyLedger();
    await first.purgeRetired(boundary, () => Promise.resolve(true), ledger);
    expect(readdirSync(root)).toContain("key-2026-07-09.json");
    await first.purgeRetired(boundary, () => Promise.resolve(false), ledger);
    expect(readdirSync(root)).not.toContain("key-2026-07-09.json");
    key(root, "2026-07-11", 7);
    const now = new Date("2026-07-11T12:00:00Z");
    const restarted = new FileSecretProvider({
      directory: root,
      kind: "abuse",
      now: (): Date => now,
    });
    expect(restarted.snapshot(now).predecessors.map((item) => item.id)).toEqual(["2026-07-10"]);
  });

  it("replays a pending event after destruction succeeds but evidence completion fails", async () => {
    const root = directory();
    key(root, "2026-07-09", 5);
    key(root, "2026-07-10", 6);
    const at = new Date("2026-07-11T00:00:00Z");
    let stored: KeyDeletionEvidence | undefined;
    let failCompletion = true;
    let beginCount = 0;
    const ledger: KeyDeletionLedger = {
      pendingDeletions: () => Promise.resolve(stored?.result === "pending" ? [stored] : []),
      beginDeletion: (evidence) => {
        beginCount += 1;
        stored = evidence;
        return Promise.resolve();
      },
      completeDeletion: (evidence) => {
        if (failCompletion) {
          failCompletion = false;
          return Promise.reject(new Error("evidence unavailable"));
        }
        stored = evidence;
        return Promise.resolve();
      },
    };
    const provider = new FileSecretProvider({
      directory: root,
      kind: "abuse",
      now: (): Date => new Date("2026-07-10T12:00:00Z"),
    });

    await expect(provider.purgeRetired(at, () => Promise.resolve(false), ledger)).rejects.toThrow(
      "evidence unavailable",
    );
    expect(readdirSync(root)).not.toContain("key-2026-07-09.json");
    expect(stored?.result).toBe("pending");
    await provider.purgeRetired(at, () => Promise.resolve(false), ledger);
    await provider.purgeRetired(at, () => Promise.resolve(false), ledger);

    expect(stored).toEqual({
      keyClass: "abuse",
      keyId: "2026-07-09",
      timestamp: new Date("2026-07-10T12:00:00Z"),
      result: "destroyed",
    });
    expect(beginCount).toBe(1);
  });

  it("rejects readable future material and insecure modes", () => {
    const root = directory();
    key(root, "2026-07-10", 6);
    key(root, "2026-07-11", 7);
    const now = new Date("2026-07-11T12:00:00Z");
    expect(
      new FileSecretProvider({ directory: root, kind: "abuse", now: (): Date => now }),
    ).toBeDefined();

    key(root, "2026-07-12", 8);
    expect(
      (): FileSecretProvider =>
        new FileSecretProvider({ directory: root, kind: "abuse", now: (): Date => now }),
    ).toThrow("custody");
    unlinkSync(join(root, "key-2026-07-12.json"));
    chmodSync(join(root, "key-2026-07-11.json"), 0o644);
    expect(
      (): FileSecretProvider =>
        new FileSecretProvider({ directory: root, kind: "abuse", now: (): Date => now }),
    ).toThrow("custody");
  });

  it("reloads every boundary and fails closed when operator activation is absent", () => {
    const root = directory();
    key(root, "2026-07-10", 6);
    key(root, "2026-07-11", 7);
    const now = new Date("2026-07-11T12:00:00Z");
    const provider = new FileSecretProvider({
      directory: root,
      kind: "abuse",
      now: (): Date => now,
    });
    unlinkSync(join(root, "key-2026-07-11.json"));

    expect(() => provider.snapshot(now)).toThrow("custody");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked key files and configured directories",
    () => {
      const root = directory();
      key(root, "2026-07-10", 6);
      key(root, "2026-07-11", 7);
      const target = join(root, "key-2026-07-11.json");
      unlinkSync(target);
      symlinkSync(join(root, "key-2026-07-10.json"), target);
      const now = new Date("2026-07-11T12:00:00Z");
      expect(
        (): FileSecretProvider =>
          new FileSecretProvider({ directory: root, kind: "abuse", now: (): Date => now }),
      ).toThrow("custody");

      const parent = directory();
      const link = join(parent, "linked");
      symlinkSync(root, link, "dir");
      expect(
        (): FileSecretProvider =>
          new FileSecretProvider({ directory: link, kind: "abuse", now: (): Date => now }),
      ).toThrow("custody");
    },
  );

  it("allows only active plus two dedupe predecessors and rejects future material", () => {
    const root = directory();
    key(root, "2026-01-02", 1, "dedupe");
    key(root, "2026-04-02", 2, "dedupe");
    key(root, "2026-07-01", 3, "dedupe");
    const now = new Date("2026-07-11T12:00:00Z");
    const provider = new FileSecretProvider({
      directory: root,
      kind: "dedupe",
      now: (): Date => now,
    });

    const custody = provider.snapshot(now);
    expect(custody.predecessors.map((item) => item.id)).toEqual([
      "dedupe-v1:2026-04-02",
      "dedupe-v1:2026-01-02",
    ]);
    expect([custody.active, ...custody.predecessors].map((item) => item.id)).toEqual([
      "dedupe-v1:2026-07-01",
      "dedupe-v1:2026-04-02",
      "dedupe-v1:2026-01-02",
    ]);
    key(root, "2026-09-29", 4, "dedupe");
    expect(
      (): FileSecretProvider =>
        new FileSecretProvider({ directory: root, kind: "dedupe", now: (): Date => now }),
    ).toThrow("custody");
  });
});
