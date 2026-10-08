import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type PathLike,
  type Mode,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  attestPortableTreeKht1Sync,
  attestPortableSidecarTree,
  attestPortableSidecarTreeSync,
  computePortableSidecarPayloadTreeDigest,
  hashPortableTreeKht1,
  PortableTreeAttestationError,
  type PortableTreeKht1Operation,
} from "./portable-tree-attestation.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const observedIo = vi.hoisted(() => ({
  selectedPath: "",
  selectedOpens: 0,
  openHandles: 0,
  directoryOrderRoot: "",
  directoryOrderReads: 0,
  onDirectoryOrder: undefined as ((names: string[]) => void) | undefined,
}));

function observeDirectoryNames(path: PathLike, names: string[]): string[] {
  if (path === observedIo.directoryOrderRoot) {
    observedIo.directoryOrderReads += 1;
    observedIo.onDirectoryOrder?.(names);
  }
  return names;
}

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readdirSync: (path: PathLike): string[] =>
      observeDirectoryNames(path, original.readdirSync(path, { encoding: "utf8" })),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readdir: async (path: PathLike): Promise<string[]> =>
      observeDirectoryNames(path, await original.readdir(path, { encoding: "utf8" })),
    open: async (path: PathLike, flags: string | number, mode?: Mode): Promise<FileHandle> => {
      const handle = await original.open(path, flags, mode);
      observedIo.openHandles += 1;
      if (path === observedIo.selectedPath) observedIo.selectedOpens += 1;
      const close = handle.close.bind(handle);
      Object.defineProperty(handle, "close", {
        value: async (): Promise<void> => {
          await close();
          observedIo.openHandles -= 1;
        },
      });
      return handle;
    },
  };
});

const roots: string[] = [];
const workers: { readonly worker: Worker; readonly control: Int32Array }[] = [];

afterEach(async () => {
  expect(observedIo.openHandles).toBe(0);
  observedIo.selectedPath = "";
  observedIo.selectedOpens = 0;
  observedIo.directoryOrderRoot = "";
  observedIo.directoryOrderReads = 0;
  observedIo.onDirectoryOrder = undefined;
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

function legacyTieFixture(): string {
  const root = fixtureRoot();
  writeFileSync(join(root, "a\u200d"), "first");
  writeFileSync(join(root, "a"), "second");
  observedIo.directoryOrderRoot = root;
  observedIo.selectedPath = join(root, "a");
  return root;
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
    const events: SecurityLogEvent[] = [];
    const securityLogSink = { write: (event: SecurityLogEvent): void => void events.push(event) };
    const cancelledRoot = fixtureRoot();
    writeFileSync(join(cancelledRoot, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    const controller = new AbortController();
    let yields = 0;
    await expect(
      hashPortableTreeKht1(
        cancelledRoot,
        operation({
          signal: controller.signal,
          securityLogSink,
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
      hashPortableTreeKht1(
        timedRoot,
        operation({ deadline: 4, now: () => (clock += 1), securityLogSink }),
      ),
    ).rejects.toThrow(/timed out/u);
    expect(() => {
      renameSync(timedRoot, `${timedRoot}-renamed`);
    }).not.toThrow();
    roots[roots.indexOf(timedRoot)] = `${timedRoot}-renamed`;
    expect(events.map((event) => event.errorKind)).toEqual(["cancelled", "timeout"]);
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
        errorKind: "validation-failed",
        extra: {
          completeness: "complete",
          driver: "async",
          failureKind: "ENOENT",
          loss: "none",
        },
      }),
      expect.objectContaining({
        category: "security",
        level: "error",
        op: "security.portable-tree-attestation.failed",
        errorKind: "validation-failed",
        extra: {
          completeness: "complete",
          driver: "sync",
          failureKind: "PortableTreeAttestationError",
          loss: "none",
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("content that must not reach the log");
    expect(JSON.stringify(events)).not.toContain(root);

    const [asyncEvent, syncEvent] = events;
    const persistedAsync = expectActivityLogProof(
      "security.portable-tree-attestation.failed.driver",
      formatActivityLogProofLine(asyncEvent ?? {}),
    );
    expect(persistedAsync).toMatchObject({ driver: "async", failureKind: "ENOENT" });
    const persistedSync = expectActivityLogProof(
      "security.portable-tree-attestation.failed.driver",
      formatActivityLogProofLine(syncEvent ?? {}),
    );
    expect(persistedSync).toMatchObject({
      driver: "sync",
      failureKind: "PortableTreeAttestationError",
    });
  });
});

describe("portable legacy sidecar tree attestation", () => {
  it("retains the canonical legacy tuple digest and selects the executable in the same content pass", async () => {
    const root = fixtureRoot();
    const files = [
      ["B.txt", "upper"],
      ["a.txt", "lower"],
      ["z/é.txt", "nested"],
      ["line\nbreak.txt", "newline"],
    ] as const;
    mkdirSync(join(root, "z"));
    for (const [name, body] of files) writeFileSync(join(root, name), body);
    const entries = files.map(([relativePath, body]) => ({
      relativePath,
      sha256: createHash("sha256").update(body).digest("hex"),
    }));
    const expected = computePortableSidecarPayloadTreeDigest(entries);
    observedIo.selectedPath = join(root, "a.txt");
    expect(await attestPortableSidecarTree(root, "a.txt", operation())).toEqual({
      treeSha256: expected,
      selectedFileSha256: createHash("sha256").update(files[1][1]).digest("hex"),
    });
    expect(observedIo.selectedOpens).toBe(1);
    expect(observedIo.openHandles).toBe(0);
    expect(attestPortableSidecarTreeSync(root, "a.txt", Date.now() + 5_000)).toEqual({
      treeSha256: expected,
      selectedFileSha256: createHash("sha256").update(files[1][1]).digest("hex"),
    });
    expect(await hashPortableTreeKht1(root, operation())).not.toBe(expected);
    expect(await attestPortableSidecarTree(root, "../outside", operation())).toEqual({
      treeSha256: expected,
    });
    expect(attestPortableSidecarTreeSync(root, "../outside", Date.now() + 5_000)).toEqual({
      treeSha256: expected,
    });
  });

  it.each(["sync", "async"] as const)(
    "returns only requested immutable provenance digests from the same %s content pass",
    async (driver) => {
      const root = fixtureRoot();
      mkdirSync(join(root, "evidence"));
      const files = [
        ["bin", "executable"],
        ["evidence/LICENSE", "approved license"],
        ["evidence/sbom.json", "approved sbom"],
        ["unrequested", "other tree content"],
      ] as const;
      for (const [path, body] of files) writeFileSync(join(root, path), body);
      const requested = files.slice(0, 3).map(([path]) => path);
      observedIo.selectedPath = join(root, "bin");
      const result =
        driver === "sync"
          ? attestPortableSidecarTreeSync(root, "bin", Date.now() + 5_000, undefined, requested)
          : await attestPortableSidecarTree(root, "bin", operation(), requested);
      expect(observedIo.selectedOpens).toBe(driver === "async" ? 1 : 0);
      const inventory = result.selectedFileSha256ByPath;
      expect(Object.keys(inventory ?? {}).sort()).toEqual([...requested].sort());
      expect(inventory).toEqual(
        Object.fromEntries(
          files
            .slice(0, 3)
            .map(([path, body]) => [path, createHash("sha256").update(body).digest("hex")]),
        ),
      );
      expect(inventory?.bin).toBe(result.selectedFileSha256);
      expect(Object.isFrozen(inventory)).toBe(true);
      if (inventory === undefined) throw new Error("expected selected inventory");
      expect(Reflect.set(inventory, "unrequested", "0".repeat(64))).toBe(false);
      expect(Object.keys(inventory)).toHaveLength(3);
    },
  );

  it("owns selected paths before async IO so a caller cannot change the attested inventory", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "evidence"));
    writeFileSync(join(root, "bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    writeFileSync(join(root, "evidence", "LICENSE"), "approved license");
    writeFileSync(join(root, "unrequested"), "other content");
    const requested = ["bin", "evidence/LICENSE"];
    let replaced = false;
    const result = await attestPortableSidecarTree(
      root,
      "bin",
      operation({
        yieldControl: () => {
          replaced = true;
          requested.splice(0, requested.length, "unrequested");
          return Promise.resolve();
        },
      }),
      requested,
    );
    expect(replaced).toBe(true);
    expect(requested).toEqual(["unrequested"]);
    expect(Object.keys(result.selectedFileSha256ByPath ?? {}).sort()).toEqual([
      "bin",
      "evidence/LICENSE",
    ]);
    expect(result.selectedFileSha256ByPath?.["evidence/LICENSE"]).toBe(
      createHash("sha256").update("approved license").digest("hex"),
    );
  });

  it.each([
    ["../escape"],
    ["bin", "bin"],
    Array.from({ length: 9 }, (_, index) => `file${String(index)}`),
    ["absent"],
  ])("refuses unsafe, duplicate, oversized or missing selected paths %j", async (...paths) => {
    const root = fixtureRoot();
    writeFileSync(join(root, "bin"), "executable");
    observedIo.selectedPath = join(root, "bin");
    expect(() =>
      attestPortableSidecarTreeSync(root, "bin", Date.now() + 5_000, undefined, paths),
    ).toThrow(PortableTreeAttestationError);
    await expect(attestPortableSidecarTree(root, "bin", operation(), paths)).rejects.toThrow(
      PortableTreeAttestationError,
    );
    expect(observedIo.selectedOpens).toBe(paths[0] === "absent" ? 1 : 0);
  });

  it("preserves historical legacy DFS ordering when localeCompare considers paths equal", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "z"));
    writeFileSync(join(root, "z", "nested"), "last");
    writeFileSync(join(root, "a.txt"), "middle");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "nested"), "first");
    const entries = new Map([
      [
        "a",
        { relativePath: "a/nested", sha256: createHash("sha256").update("first").digest("hex") },
      ],
      [
        "a.txt",
        { relativePath: "a.txt", sha256: createHash("sha256").update("middle").digest("hex") },
      ],
      [
        "z",
        { relativePath: "z/nested", sha256: createHash("sha256").update("last").digest("hex") },
      ],
    ]);
    const historicalOrder = readdirSync(root).map((name) => {
      const entry = entries.get(name);
      if (entry === undefined) throw new Error("expected fixed fixture entry");
      return entry;
    });
    const collation = vi.spyOn(String.prototype, "localeCompare").mockReturnValue(0);
    try {
      const expected = computePortableSidecarPayloadTreeDigest(historicalOrder);
      expect(attestPortableSidecarTreeSync(root, "a/nested", Date.now() + 5_000).treeSha256).toBe(
        expected,
      );
      expect((await attestPortableSidecarTree(root, "a/nested", operation())).treeSha256).toBe(
        expected,
      );
    } finally {
      collation.mockRestore();
    }
  });

  it("skips historical enumeration when complete file paths have no collation ties", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "a.txt"), "first");
    writeFileSync(join(root, "z.txt"), "second");
    observedIo.directoryOrderRoot = root;
    attestPortableSidecarTreeSync(root, "a.txt", Date.now() + 5_000);
    await attestPortableSidecarTree(root, "a.txt", operation());
    expect(observedIo.directoryOrderReads).toBe(0);
  });

  it.each(["sync", "async"] as const)(
    "refuses real directory membership mutation during historical enumeration through %s",
    async (driver) => {
      const root = legacyTieFixture();
      observedIo.onDirectoryOrder = (names): void => {
        observedIo.onDirectoryOrder = undefined;
        writeFileSync(join(root, "added.txt"), "unexpected new file");
        names.push("added.txt");
      };
      if (driver === "sync") {
        expect(() => attestPortableSidecarTreeSync(root, "a", Date.now() + 5_000)).toThrow(
          /changed during attestation/u,
        );
      } else {
        await expect(attestPortableSidecarTree(root, "a", operation())).rejects.toThrow(
          /changed during attestation/u,
        );
      }
      expect(observedIo.directoryOrderReads).toBe(1);
      expect(observedIo.selectedOpens).toBe(0);
    },
  );

  it("checks cancellation immediately after historical enumeration before content opens", async () => {
    const root = legacyTieFixture();
    const controller = new AbortController();
    observedIo.onDirectoryOrder = (): void => {
      controller.abort();
    };
    await expect(
      attestPortableSidecarTree(root, "a", operation({ signal: controller.signal })),
    ).rejects.toThrow(/cancelled/u);
    expect(observedIo.directoryOrderReads).toBe(1);
    expect(observedIo.selectedOpens).toBe(0);
  });

  it.each(["sync", "async"] as const)(
    "checks the deadline immediately after historical enumeration through %s",
    async (driver) => {
      const root = legacyTieFixture();
      let clock = 1;
      observedIo.onDirectoryOrder = (): void => {
        clock = 3;
      };
      const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
      try {
        if (driver === "sync") {
          expect(() => attestPortableSidecarTreeSync(root, "a", 2)).toThrow(/timed out/u);
        } else {
          await expect(
            attestPortableSidecarTree(root, "a", operation({ deadline: 2 })),
          ).rejects.toThrow(/timed out/u);
        }
        expect(observedIo.directoryOrderReads).toBe(1);
        expect(observedIo.selectedOpens).toBe(0);
      } finally {
        now.mockRestore();
      }
    },
  );

  it("refuses an expired sync projection without retaining a partial proof and logs its driver", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "body.txt"), "private fixture body");
    const events: SecurityLogEvent[] = [];
    expect(() =>
      attestPortableSidecarTreeSync(root, "body.txt", 1, {
        write: (event): void => void events.push(event),
      }),
    ).toThrow(PortableTreeAttestationError);
    expect(events).toHaveLength(1);
    expect(events[0]?.errorKind).toBe("timeout");
    expect(
      expectActivityLogProof(
        "security.portable-tree-attestation.failed.driver",
        formatActivityLogProofLine(events[0] ?? {}),
      ),
    ).toMatchObject({ driver: "sync", failureKind: "PortableTreeAttestationError" });
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain("private fixture body");
  });

  it("lets a scheduled callback run before the full attestation settles", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    let serviced = false;
    setImmediate(() => {
      serviced = true;
    });
    await attestPortableSidecarTree(
      root,
      "large.bin",
      operation({ yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)) }),
    );
    expect(serviced).toBe(true);
  });

  it("rejects a previously hashed leaf changing during the full pass", async () => {
    const root = fixtureRoot();
    const target = join(root, "a.txt");
    writeFileSync(target, "old");
    writeFileSync(join(root, "z.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
    let mutated = false;
    await expect(
      attestPortableSidecarTree(
        root,
        "a.txt",
        operation({
          yieldControl: () => {
            if (!mutated) {
              mutated = true;
              writeFileSync(target, "new");
            }
            return Promise.resolve();
          },
        }),
      ),
    ).rejects.toThrow(/changed during attestation/u);
    expect(mutated).toBe(true);
    expect(observedIo.openHandles).toBe(0);
  });

  it.each(["symbolic", "hard", "root"] as const)("refuses an unsafe %s link", async (kind) => {
    const root = fixtureRoot();
    const target = join(root, "a.txt");
    writeFileSync(target, "content");
    let inspectedRoot = root;
    if (kind === "symbolic") symlinkSync(target, join(root, "alias.txt"));
    if (kind === "hard") linkSync(target, join(root, "alias.txt"));
    if (kind === "root") {
      inspectedRoot = `${root}-alias`;
      roots.push(inspectedRoot);
      symlinkSync(root, inspectedRoot);
    }
    await expect(
      attestPortableSidecarTree(inspectedRoot, "a.txt", operation()),
    ).rejects.toBeInstanceOf(PortableTreeAttestationError);
    expect(() => attestPortableSidecarTreeSync(inspectedRoot, "a.txt", Date.now() + 5_000)).toThrow(
      PortableTreeAttestationError,
    );
    expect(observedIo.openHandles).toBe(0);
  });

  it.each(["cancelled", "timeout"] as const)(
    "returns no partial proof on %s and closes every file",
    async (kind) => {
      const root = fixtureRoot();
      writeFileSync(join(root, "large.bin"), Buffer.alloc(4 * 1024 * 1024 + 1));
      const controller = new AbortController();
      let clock = 10;
      const events: SecurityLogEvent[] = [];
      await expect(
        attestPortableSidecarTree(
          root,
          "large.bin",
          operation({
            signal: controller.signal,
            deadline: 100,
            now: () => clock,
            securityLogSink: { write: (event): void => void events.push(event) },
            yieldControl: () => {
              if (kind === "cancelled") controller.abort();
              else clock = 101;
              return Promise.resolve();
            },
          }),
        ),
      ).rejects.toMatchObject({ kind });
      expect(observedIo.openHandles).toBe(0);
      expect(events).toHaveLength(1);
      expect(events[0]?.extra).toMatchObject({
        driver: "async",
        failureKind: "PortableTreeAttestationError",
      });
      expect(JSON.stringify(events)).not.toContain(root);
    },
  );
});
