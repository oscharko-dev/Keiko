// `node:child_process` is mocked for the whole file, so nothing here can start the real `security`
// even when the guard under test is broken: the failing state of this proof touches no keychain.
import { nullSecurityLogSink } from "./log-port.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";
import type { SecurityLogSink } from "./log-port.js";

const spawnMock = vi.hoisted(() => vi.fn<(file: string) => string>(() => ""));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: spawnMock,
}));

const {
  MACOS_SECURITY_EXECUTABLE,
  readMacosKeychainSecret,
  realKeychainWithheld,
  writeMacosKeychainSecret,
} = await import("./macos-keychain.js");
const { createKeychainCommandRunner, createKeychainVaultKeyAccess } =
  await import("./secret-vault.js");

const DARWIN = { platform: "darwin" as const, sink: nullSecurityLogSink() };

beforeEach(() => {
  spawnMock.mockClear();
});

describe("realKeychainWithheld", () => {
  it("withholds the keychain from a test process and from a lane that turned it off", () => {
    expect(realKeychainWithheld({ VITEST: "true" })).toBe(true);
    expect(realKeychainWithheld({ KEIKO_OS_KEYCHAIN: "off" })).toBe(true);
  });

  it("leaves a product process its keychain, also for an unrecognized value", () => {
    vi.stubEnv("VITEST", undefined);
    try {
      expect(realKeychainWithheld({})).toBe(false);
      expect(realKeychainWithheld({ KEIKO_OS_KEYCHAIN: "on" })).toBe(false);
      expect(realKeychainWithheld({ KEIKO_OS_KEYCHAIN: "OFF" })).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is what this very process reports, whatever its configuration", () => {
    expect(realKeychainWithheld()).toBe(true);
  });
});

describe("the shared keychain owner in a test process", () => {
  it("never spawns the real security binary to read", () => {
    expect(readMacosKeychainSecret("svc", "acct", DARWIN)).toEqual({ kind: "unavailable" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("never spawns the real security binary to store", () => {
    expect(writeMacosKeychainSecret("svc", "acct", "secret", DARWIN)).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("treats the real path named explicitly like the default", () => {
    const options = { ...DARWIN, executable: MACOS_SECURITY_EXECUTABLE };
    expect(readMacosKeychainSecret("svc", "acct", options)).toEqual({ kind: "unavailable" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still runs a fake binary, the seam every keychain test uses", () => {
    spawnMock.mockReturnValueOnce("stored");
    const options = { ...DARWIN, executable: "/fake/security" };
    expect(readMacosKeychainSecret("svc", "acct", options)).toEqual({
      kind: "found",
      secret: "stored",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("/fake/security");
  });

  it("spawns the real path in a product process", () => {
    vi.stubEnv("VITEST", undefined);
    try {
      spawnMock.mockReturnValueOnce("stored");
      expect(readMacosKeychainSecret("svc", "acct", DARWIN)).toEqual({
        kind: "found",
        secret: "stored",
      });
      expect(spawnMock.mock.calls[0]?.[0]).toBe(MACOS_SECURITY_EXECUTABLE);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the vault's own keychain runner in a test process", () => {
  it("refuses the real path before spawning", () => {
    expect(() => createKeychainCommandRunner()(["find-generic-password"])).toThrow(/withheld/u);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("still runs a fake binary", () => {
    spawnMock.mockReturnValueOnce("answer");
    expect(createKeychainCommandRunner("/fake/security")(["find-generic-password"])).toBe("answer");
    expect(spawnMock.mock.calls[0]?.[0]).toBe("/fake/security");
  });

  it("falls through to the next tier without a spawn and records why", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const write = vi.fn<SecurityLogSink["write"]>();
    const sink: SecurityLogSink = { write };
    try {
      expect(createKeychainVaultKeyAccess("svc", undefined, sink)()).toBeUndefined();
    } finally {
      platform.mockRestore();
    }
    expect(spawnMock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    const event = write.mock.calls[0]?.[0];
    if (event === undefined) throw new TypeError("Expected a withheld line");
    expect(
      expectActivityLogProof("security.keychain.withheld.line", formatActivityLogProofLine(event)),
    ).toMatchObject({ reason: "test-process" });
  });

  it("honours the switch in the environment handed to a vault, outside vitest too", () => {
    vi.stubEnv("VITEST", undefined);
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const write = vi.fn<SecurityLogSink["write"]>();
    const sink: SecurityLogSink = { write };
    try {
      const access = createKeychainVaultKeyAccess("svc", undefined, sink, {
        KEIKO_OS_KEYCHAIN: "off",
      });
      expect(access()).toBeUndefined();
      expect(
        readMacosKeychainSecret("svc", "acct", {
          ...DARWIN,
          env: { KEIKO_OS_KEYCHAIN: "off" },
        }),
      ).toEqual({ kind: "unavailable" });
    } finally {
      platform.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(spawnMock).not.toHaveBeenCalled();
    const event = write.mock.calls[0]?.[0];
    if (event === undefined) throw new TypeError("Expected a withheld line");
    expect(event.extra).toMatchObject({ reason: "operator-off" });
  });

  it("keeps a test process withheld when a test hands a vault an empty environment", () => {
    expect(realKeychainWithheld({})).toBe(true);
  });

  it("keeps an injected runner working, the seam the tier's tests use", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const key = Buffer.alloc(32, 7);
    try {
      const access = createKeychainVaultKeyAccess("svc", () => key.toString("base64"));
      expect(access()?.equals(key)).toBe(true);
    } finally {
      platform.mockRestore();
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
