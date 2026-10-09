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
    await expect(qualifyPortableSecureRead(target, false)).resolves.toBeUndefined();
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
    expect(info).toHaveBeenCalledExactlyOnceWith(
      `portable-secure-read-qualification: PASS ${target}`,
    );
    expect(errors).not.toHaveBeenCalled();
  });
});
