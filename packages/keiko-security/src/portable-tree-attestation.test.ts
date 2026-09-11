import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  attestPortableTreeKht1Sync,
  hashPortableTreeKht1,
  PortableTreeAttestationError,
  type PortableTreeKht1Operation,
} from "./portable-tree-attestation.js";

const roots: string[] = [];
const workers: { readonly worker: Worker; readonly control: Int32Array }[] = [];

afterEach(async () => {
  for (const { worker, control } of workers.splice(0)) {
    Atomics.store(control, 1, 1);
    Atomics.notify(control, 1);
    await worker.terminate();
  }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-kht1-"));
  roots.push(root);
  return root;
}

function operation(overrides: Partial<PortableTreeKht1Operation> = {}): PortableTreeKht1Operation {
  return {
    deadline: Date.now() + 5_000,
    now: Date.now,
    yieldControl: () => Promise.resolve(),
    ...overrides,
  };
}

function expectedKht1(entries: readonly (readonly [string, string | Buffer])[]): string {
  const hash = createHash("sha256");
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length);
  hash.update("KHT1", "ascii");
  hash.update(count);
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(nameBytes.byteLength);
    hash.update(length);
    hash.update(nameBytes);
    hash.update(createHash("sha256").update(content).digest());
  }
  return hash.digest("hex");
}

function startMutationWorker(script: string, data: Record<string, unknown>): void {
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const control = new Int32Array(shared);
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const path = require("node:path");
      const control = new Int32Array(workerData.shared);
      ${script}
    `,
    { eval: true, workerData: { ...data, shared } },
  );
  workers.push({ worker, control });
  const wait = Atomics.wait(control, 0, 0, 5_000);
  if (wait === "timed-out") throw new Error("mutation worker did not start");
}

describe("portable KHT1 tree attestation", () => {
  it("produces one native-compatible golden digest through async hashing and sync attestation", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "z"));
    writeFileSync(join(root, "B.txt"), "upper");
    writeFileSync(join(root, "z", "a.txt"), "nested");
    const expected = expectedKht1([
      ["B.txt", "upper"],
      ["z/a.txt", "nested"],
    ]);

    expect(expected).toBe("4d120aeb0383a39dfd0d1782e7cb3e4d0ed6b0e86658842e1b8db2c1efdafca4");
    await expect(hashPortableTreeKht1(root, operation())).resolves.toBe(expected);
    expect(() => {
      attestPortableTreeKht1Sync(root, expected, Date.now() + 5_000);
    }).not.toThrow();
  });

  it("rejects symbolic links and hard-linked files through both drivers", async () => {
    const symbolicRoot = fixtureRoot();
    writeFileSync(join(symbolicRoot, "target.txt"), "target");
    symlinkSync(join(symbolicRoot, "target.txt"), join(symbolicRoot, "link.txt"));

    await expect(hashPortableTreeKht1(symbolicRoot, operation())).rejects.toThrow(
      /unsupported entry/u,
    );
    expect(() => {
      attestPortableTreeKht1Sync(symbolicRoot, "0".repeat(64), Date.now() + 5_000);
    }).toThrow(/unsupported entry/u);

    const hardLinkRoot = fixtureRoot();
    writeFileSync(join(hardLinkRoot, "first.txt"), "same inode");
    linkSync(join(hardLinkRoot, "first.txt"), join(hardLinkRoot, "second.txt"));
    await expect(hashPortableTreeKht1(hardLinkRoot, operation())).rejects.toThrow(
      /unsupported entry/u,
    );
    expect(() => {
      attestPortableTreeKht1Sync(hardLinkRoot, "0".repeat(64), Date.now() + 5_000);
    }).toThrow(/unsupported entry/u);
  });

  it("rejects content mutation through the async driver", async () => {
    const root = fixtureRoot();
    const first = join(root, "a.txt");
    writeFileSync(first, "old");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    let rewritten = false;

    await expect(
      hashPortableTreeKht1(
        root,
        operation({
          yieldControl: () => {
            if (!rewritten) {
              rewritten = true;
              writeFileSync(first, "new");
            }
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/changed during attestation/u);
    expect(rewritten).toBe(true);
  });

  it("rejects parent-directory rebinding through the async driver", async () => {
    const root = fixtureRoot();
    const parent = join(root, "a");
    mkdirSync(parent);
    writeFileSync(join(parent, "file.txt"), "same");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    let rebound = false;

    await expect(
      hashPortableTreeKht1(
        root,
        operation({
          yieldControl: () => {
            if (!rebound) {
              rebound = true;
              const oldParent = join(root, "old-a");
              renameSync(parent, oldParent);
              mkdirSync(parent);
              writeFileSync(join(parent, "file.txt"), "same");
              rmSync(oldParent, { recursive: true });
            }
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/changed during attestation/u);
    expect(rebound).toBe(true);
  });

  it("rejects concurrent content mutation through the sync driver", async () => {
    const root = fixtureRoot();
    const victim = join(root, "a.txt");
    writeFileSync(victim, "old");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(32 * 1024 * 1024));
    const expected = await hashPortableTreeKht1(root, operation());
    startMutationWorker(
      `
        let revision = 0;
        fs.writeFileSync(workerData.victim, "new");
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        while (Atomics.load(control, 1) === 0) {
          fs.writeFileSync(workerData.victim, revision++ % 2 === 0 ? "old" : "new");
        }
      `,
      { victim },
    );

    expect(() => {
      attestPortableTreeKht1Sync(root, expected, Date.now() + 5_000);
    }).toThrow();
  });

  it("rejects concurrent parent-directory rebinding through the sync driver", () => {
    const root = fixtureRoot();
    const parent = join(root, "a");
    const spare = join(root, "old-a");
    mkdirSync(parent);
    writeFileSync(join(parent, "file.txt"), "same");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(32 * 1024 * 1024));
    startMutationWorker(
      `
        fs.renameSync(workerData.parent, workerData.spare);
        fs.mkdirSync(workerData.parent);
        fs.writeFileSync(path.join(workerData.parent, "file.txt"), "same");
        fs.rmSync(workerData.spare, { recursive: true });
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0);
        while (Atomics.load(control, 1) === 0) {
          try {
            fs.renameSync(workerData.parent, workerData.spare);
            fs.mkdirSync(workerData.parent);
            fs.writeFileSync(path.join(workerData.parent, "file.txt"), "same");
            fs.rmSync(workerData.spare, { recursive: true });
          } catch {}
        }
      `,
      { parent, spare },
    );

    expect(() => {
      attestPortableTreeKht1Sync(root, "0".repeat(64), Date.now() + 5_000);
    }).toThrow();
  });

  it("checks abort and deadline throughout async work and closes active resources", async () => {
    const cancelledRoot = fixtureRoot();
    writeFileSync(join(cancelledRoot, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    const controller = new AbortController();
    let yields = 0;
    await expect(
      hashPortableTreeKht1(
        cancelledRoot,
        operation({
          signal: controller.signal,
          yieldControl: () => {
            yields += 1;
            controller.abort();
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/cancelled/u);
    expect(yields).toBeGreaterThan(0);
    expect(() => {
      rmSync(cancelledRoot, { recursive: true });
    }).not.toThrow();
    roots.splice(roots.indexOf(cancelledRoot), 1);

    const timedRoot = fixtureRoot();
    writeFileSync(join(timedRoot, "file.txt"), "content");
    let clock = 0;
    await expect(
      hashPortableTreeKht1(timedRoot, operation({ deadline: 4, now: () => (clock += 1) })),
    ).rejects.toThrow(/timed out/u);
    expect(() => {
      renameSync(timedRoot, `${timedRoot}-renamed`);
    }).not.toThrow();
    roots[roots.indexOf(timedRoot)] = `${timedRoot}-renamed`;
  });

  it("fails closed on an expired sync deadline and malformed or mismatched digests", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "file.txt"), "content");

    expect(() => {
      attestPortableTreeKht1Sync(root, "0".repeat(64), 1);
    }).toThrow(/timed out/u);
    expect(() => {
      attestPortableTreeKht1Sync(root, "ABC", Date.now() + 5_000);
    }).toThrow(/digest is invalid/u);
    expect(() => {
      attestPortableTreeKht1Sync(root, "0".repeat(64), Date.now() + 5_000);
    }).toThrow(/digest mismatch/u);
  });

  it("uses the dedicated attestation error type for policy failures", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "file.txt"), "content");

    await expect(hashPortableTreeKht1(root, operation({ deadline: 1 }))).rejects.toBeInstanceOf(
      PortableTreeAttestationError,
    );
  });

  it("emits body-free security events for async and sync attestation failures", async () => {
    const root = fixtureRoot();
    const events: SecurityLogEvent[] = [];
    const securityLogSink = { write: (event: SecurityLogEvent): void => void events.push(event) };
    writeFileSync(join(root, "file.txt"), "content that must not reach the log");

    await expect(
      hashPortableTreeKht1(join(root, "missing"), operation({ securityLogSink })),
    ).rejects.toThrow();
    expect(() => {
      attestPortableTreeKht1Sync(root, "0".repeat(64), Date.now() + 5_000, securityLogSink);
    }).toThrow(/digest mismatch/u);

    expect(events).toEqual([
      expect.objectContaining({
        category: "security",
        level: "error",
        op: "security.portable-tree-attestation.failed",
        errorKind: "ENOENT",
        extra: { driver: "async" },
      }),
      expect.objectContaining({
        category: "security",
        level: "error",
        op: "security.portable-tree-attestation.failed",
        errorKind: "PortableTreeAttestationError",
        extra: { driver: "sync" },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("content that must not reach the log");
    expect(JSON.stringify(events)).not.toContain(root);
  });
});
