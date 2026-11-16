import { afterEach, describe, expect, it, vi } from "vitest";

import {
  nativeSecureReadTarget,
  qualifyPortableSecureRead,
  runPortableSecureReadQualification,
} from "../qualify-portable-secure-read.mjs";
import { PORTABLE_TARGETS } from "../portable-runtime.mjs";

describe("portable secure-read native qualification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the portable read fixture against the freshly compiled native helper", async () => {
    const target = nativeSecureReadTarget();
    if (target === undefined) {
      await expect(qualifyPortableSecureRead(target, false)).rejects.toThrow(
        "target is not native to this host",
      );
      return;
    }
    const evidence = await qualifyPortableSecureRead(target, false);
    expect(evidence).toEqual({
      platformTarget: target,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sizeBytes: expect.any(Number),
      sourceTreeSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(evidence.sizeBytes).toBeGreaterThan(0);
  });

  it.each([undefined, "amiga-68k"])("rejects unsupported target %s", async (target) => {
    await expect(qualifyPortableSecureRead(target, false)).rejects.toThrow(
      "target is not native to this host",
    );
  });

  it("rejects every supported target that requires a different host", async () => {
    for (const target of PORTABLE_TARGETS) {
      if (target.platformTarget === nativeSecureReadTarget()) continue;
      await expect(qualifyPortableSecureRead(target.platformTarget, false)).rejects.toThrow(
        "target is not native to this host",
      );
    }
  });

  it("returns a failed CLI verdict for unsupported targets and invalid arguments", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runPortableSecureReadQualification(["node", "qualify", "amiga-68k"]),
    ).resolves.toBe(1);
    await expect(
      runPortableSecureReadQualification(["node", "qualify", "amiga-68k", "extra"]),
    ).resolves.toBe(1);
    expect(errors.mock.calls).toEqual([
      ["portable-secure-read-qualification: target is not native to this host"],
      ["portable-secure-read-qualification: invalid arguments"],
    ]);
  });

  it("automatically qualifies the host with the complete portable load fixture", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = nativeSecureReadTarget();
    const code = await runPortableSecureReadQualification(["node", "qualify"]);
    if (target === undefined) {
      expect(code).toBe(1);
      expect(errors).toHaveBeenCalledExactlyOnceWith(
        "portable-secure-read-qualification: target is not native to this host",
      );
      return;
    }
    expect(code).toBe(0);
    expect(info).toHaveBeenCalledTimes(2);
    const prefix = "portable-secure-read-qualification: identity ";
    expect(info.mock.calls[0][0]).toMatch(new RegExp(`^${prefix}`, "u"));
    const evidence = JSON.parse(info.mock.calls[0][0].slice(prefix.length));
    expect(evidence.platformTarget).toBe(target);
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.sizeBytes).toBeGreaterThan(0);
    expect(evidence.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(info).toHaveBeenNthCalledWith(2, `portable-secure-read-qualification: PASS ${target}`);
    expect(errors).not.toHaveBeenCalled();
  });
});
