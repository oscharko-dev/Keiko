import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HUMAN_WRITE_WAIT_MS,
  NATIVE_WRITE_WAIT_MS,
  NativeWriteGateTimeoutError,
  nativeWriteGateWaiters,
  runHumanWorkspaceWrite,
} from "./nativeWriteGate.js";
import { fileSignature, guardedNativeWrite, provenNotApplied } from "./opencodeRevertGuard.js";
import { OpenCodeV2HttpStatusError } from "./opencodeV2HttpClient.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-revert-guard-"));
  roots.push(root);
  return root;
}

async function proven(root: string, content: string): Promise<Map<string, string>> {
  writeFileSync(join(root, "a.txt"), content);
  return new Map([["a.txt", (await fileSignature(root, "a.txt")) ?? "unverifiable"]]);
}

describe("guardedNativeWrite", () => {
  it("sends nothing when a file is not as it was proven right before the request", async () => {
    const root = directory();
    const before = await proven(root, "proven\n");
    writeFileSync(join(root, "a.txt"), "edited\n");
    const call = vi.fn(() => Promise.resolve("sent"));

    await expect(guardedNativeWrite({ root, files: ["a.txt"], before, call })).resolves.toEqual({
      kind: "changed",
    });
    expect(call).not.toHaveBeenCalled();
  });

  it("settles content that matches neither state as uncertain and leaves it alone", async () => {
    const root = directory();
    const before = await proven(root, "undone\n");
    const after = await proven(directory(), "turn\n");

    const result = await guardedNativeWrite({
      root,
      files: ["a.txt"],
      before,
      after,
      call: () => {
        writeFileSync(join(root, "a.txt"), "typed after the write\n");
        return Promise.resolve("answer");
      },
    });

    expect(result).toMatchObject({ kind: "uncertain", reason: "unexpected-content" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("typed after the write\n");
  });

  it("calls an Undo write whose answer never came uncertain, never a clean stage", async () => {
    const root = directory();
    const before = await proven(root, "turn\n");

    const result = await guardedNativeWrite({
      root,
      files: ["a.txt"],
      before,
      call: () => {
        writeFileSync(join(root, "a.txt"), "undone\n");
        return Promise.reject(new Error("reset"));
      },
    });

    expect(result).toMatchObject({ kind: "uncertain", reason: "call-failed-unknown" });
  });

  it("reports the fingerprints it read inside the gate right after the write", async () => {
    const root = directory();
    const before = await proven(root, "undone\n");
    const result = await guardedNativeWrite({
      root,
      files: ["a.txt"],
      before,
      call: () => {
        writeFileSync(join(root, "a.txt"), "turn\n");
        return Promise.resolve("answer");
      },
    });

    expect(result).toMatchObject({ kind: "done", settlement: "clean", result: "answer" });
    const landed = result.kind === "done" ? result.landed.get("a.txt") : undefined;
    expect(landed).toBe(await fileSignature(root, "a.txt"));
  });

  it("calls a failure that may have been sent uncertain even while the files still equal the proven state", async () => {
    const root = directory();
    const before = await proven(root, "proven\n");

    await expect(
      guardedNativeWrite({
        root,
        files: ["a.txt"],
        before,
        call: () => Promise.reject(new Error("request timed out")),
      }),
    ).resolves.toMatchObject({ kind: "uncertain", reason: "call-failed-unknown" });
  });

  it("calls only a failure proven not applied a plain failure", async () => {
    const root = directory();
    const before = await proven(root, "proven\n");
    const refused = new OpenCodeV2HttpStatusError(409);

    await expect(
      guardedNativeWrite({
        root,
        files: ["a.txt"],
        before,
        call: () => Promise.reject(refused),
      }),
    ).resolves.toEqual({ kind: "failed", error: refused });
    expect(provenNotApplied(new OpenCodeV2HttpStatusError(503))).toBe(false);
    expect(provenNotApplied(new OpenCodeV2HttpStatusError(404))).toBe(true);
    expect(
      provenNotApplied(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } })),
    ).toBe(true);
    expect(provenNotApplied(new Error("aborted"))).toBe(false);
  });

  it("calls an answered Restore request that wrote nothing uncertain, never applied", async () => {
    const root = directory();
    const before = await proven(root, "undone\n");
    const after = await proven(directory(), "turn\n");

    const result = await guardedNativeWrite({
      root,
      files: ["a.txt"],
      before,
      after,
      call: () => Promise.resolve("200 with nothing written"),
    });

    expect(result).toMatchObject({ kind: "uncertain", reason: "unexpected-content" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("undone\n");
  });

  it("still accepts an answered request on files whose expected result Keiko does not know", async () => {
    const root = directory();
    const before = await proven(root, "turn\n");

    await expect(
      guardedNativeWrite({ root, files: ["a.txt"], before, call: () => Promise.resolve("ok") }),
    ).resolves.toMatchObject({ kind: "done", settlement: "clean" });
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "settles as unreadable when the files cannot be read after the write, retries spent",
    async () => {
      const root = directory();
      const before = await proven(root, "undone\n");
      const path = join(root, "a.txt");

      const result = await guardedNativeWrite({
        root,
        files: ["a.txt"],
        before,
        call: () => {
          chmodSync(path, 0o000);
          return Promise.resolve("answer");
        },
      });
      chmodSync(path, 0o600);

      expect(result).toMatchObject({
        kind: "uncertain",
        reason: "unreadable",
        errorKind: expect.any(String) as string,
      });
    },
  );

  it("turns the gate's wait timeout into a failure that sent nothing", async () => {
    const root = directory();
    const before = await proven(root, "proven\n");
    let enter: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const typing = runHumanWorkspaceWrite(root, async () => {
      enter();
      await released;
    });
    await entered;
    const call = vi.fn(() => Promise.resolve("sent"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const guarded = guardedNativeWrite({ root, files: ["a.txt"], before, call });
      while (nativeWriteGateWaiters() === 0) await new Promise<void>((done) => setImmediate(done));
      await vi.advanceTimersByTimeAsync(Math.max(NATIVE_WRITE_WAIT_MS, HUMAN_WRITE_WAIT_MS));
      const result = await guarded;

      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" && result.error).toBeInstanceOf(NativeWriteGateTimeoutError);
    } finally {
      vi.useRealTimers();
    }
    expect(call).not.toHaveBeenCalled();
    release();
    await typing;
  });
});
