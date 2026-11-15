// #4358: on Windows the vault's key file and its directory are attested as private to the current
// principal before the key is used. This suite drives the real key resolution on any host through
// the `windowsCustody` seam: a real temporary directory and key file, with the Windows inspection
// and protection injected.
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import {
  NO_LOCAL_VAULT_KEYCHAIN,
  resolveLocalVaultKey,
  type ResolveLocalVaultKeyOptions,
} from "./secret-vault.js";
import type { WindowsOwnerPrivateInspection } from "./windows-owner-private.js";
import {
  currentWindowsVaultCustody,
  resetWindowsVaultCustodyForTest,
} from "./windows-vault-custody.js";

const USER = "S-1-5-21-1-2-3-1001";
const KEYFILE = "test-vault.key";

function sid(parts: readonly number[], authority: number): Buffer {
  const bytes = Buffer.alloc(8 + 4 * parts.length);
  bytes.set([1, parts.length, 0, 0, 0, 0, 0, authority]);
  parts.forEach((value, index) => bytes.writeUInt32LE(value, 8 + 4 * index));
  return bytes;
}

/** Owner USER; one allow ACE for USER, plus one read ACE for Authenticated Users when `shared`. */
function descriptor(shared: boolean): Uint8Array {
  const user = sid([21, 1, 2, 3, 1001], 5);
  const grants: [Buffer, number][] = [[user, 0x001f01ff]];
  if (shared) grants.push([sid([11], 5), 0x001200a9]);
  const aces = Buffer.concat(
    grants.map(([body, mask]) => {
      const ace = Buffer.alloc(8 + body.length);
      ace.writeUInt16LE(ace.length, 2);
      ace.writeUInt32LE(mask, 4);
      body.copy(ace, 8);
      return ace;
    }),
  );
  const acl = Buffer.alloc(8);
  acl.writeUInt8(2, 0);
  acl.writeUInt16LE(8 + aces.length, 2);
  acl.writeUInt16LE(grants.length, 4);
  const header = Buffer.alloc(20);
  header.writeUInt8(1, 0);
  header.writeUInt16LE(0x8004, 2);
  header.writeUInt32LE(20, 4);
  header.writeUInt32LE(20 + user.length, 16);
  return new Uint8Array(Buffer.concat([header, user, acl, aces]));
}

let dir: string;
let events: SecurityLogEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keiko-vault-custody-"));
  events = [];
  resetWindowsVaultCustodyForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Facts for the real directory and, when it was asked for, the real key file, as the Windows
 * inspection would report them. `shared` makes the key file readable by Authenticated Users.
 */
function realFacts(
  shared: boolean,
  paths: readonly string[] = [dir, join(dir, KEYFILE)],
): WindowsOwnerPrivateInspection {
  const directory = lstatSync(dir, { bigint: true });
  const directoryFacts = {
    kind: "facts" as const,
    attributes: 0x10,
    volumeSerial: directory.dev,
    fileIndex: directory.ino,
    links: 1,
    descriptor: descriptor(false),
  };
  if (paths.length === 1) {
    return { principal: { userSid: USER, tokenOwnerSid: USER }, files: [directoryFacts] };
  }
  const keyfile = lstatSync(join(dir, KEYFILE), { bigint: true });
  return {
    principal: { userSid: USER, tokenOwnerSid: USER },
    files: [
      directoryFacts,
      {
        kind: "facts",
        attributes: 0x20,
        volumeSerial: keyfile.dev,
        fileIndex: keyfile.ino,
        links: 1,
        descriptor: descriptor(shared),
      },
    ],
  };
}

function options(
  custody: NonNullable<ResolveLocalVaultKeyOptions["windowsCustody"]>,
): ResolveLocalVaultKeyOptions {
  return {
    env: {},
    vaultDir: dir,
    envVarName: "KEIKO_TEST_VAULT_KEY",
    keychainService: "keiko-test-vault",
    keyfileName: KEYFILE,
    keychainAccess: NO_LOCAL_VAULT_KEYCHAIN,
    sink: { write: (event): void => void events.push(event) },
    windowsCustody: { platform: "win32", ...custody },
  };
}

function custodyOutcomes(): unknown[] {
  return events
    .filter((event) => event.op === "security.vault.custody")
    .map((event) => event.extra?.outcome);
}

describe("secret vault key file on Windows", () => {
  it("makes the directory private before it creates a new key, then attests both", () => {
    const inspected: { readonly paths: readonly string[]; readonly keyExisted: boolean }[] = [];
    const resolved = resolveLocalVaultKey(
      options({
        inspect: (paths) => {
          inspected.push({ paths, keyExisted: existsSync(join(dir, KEYFILE)) });
          return realFacts(false, paths);
        },
        protect: () => {
          throw new Error("must not protect a private key file");
        },
      }),
    );
    expect(resolved.source).toBe("keyfile");
    expect(resolved.key).toHaveLength(32);
    // The directory alone, while no key file exists yet; then the directory and the new key file.
    expect(inspected).toEqual([
      { paths: [dir], keyExisted: false },
      { paths: [dir, join(dir, KEYFILE)], keyExisted: true },
    ]);
    expect(custodyOutcomes()).toEqual(["attested", "attested"]);
    const stored = Buffer.from(readFileSync(join(dir, KEYFILE), "utf8").trim(), "base64");
    expect(stored.equals(resolved.key)).toBe(true);
  });

  it("never creates a key in a directory another account can reach", () => {
    const reachable = (): WindowsOwnerPrivateInspection => {
      const found = realFacts(false, [dir]);
      const [directory] = found.files;
      if (directory?.kind !== "facts") throw new Error("fixture");
      return { ...found, files: [{ ...directory, descriptor: descriptor(true) }] };
    };
    expect(() =>
      resolveLocalVaultKey(options({ inspect: reachable, protect: (): void => undefined })),
    ).toThrow("secret vault directory is not private to the current Windows user (foreign-access)");
    expect(existsSync(join(dir, KEYFILE))).toBe(false);
    expect(custodyOutcomes()).toEqual(["refused"]);
  });

  it("attests an existing key file again on the next resolution and returns the same key", () => {
    const custody = {
      inspect: (paths: readonly string[]): WindowsOwnerPrivateInspection => realFacts(false, paths),
    };
    const first = resolveLocalVaultKey(options(custody));
    events.length = 0;
    const second = resolveLocalVaultKey(options(custody));
    expect(second.key.equals(first.key)).toBe(true);
    // An existing key needs one inspection, of the directory and the key file together.
    expect(custodyOutcomes()).toEqual(["attested"]);
  });

  it("uses an existing key another account could read, protects it and reports it as exposed", () => {
    const priv = {
      inspect: (paths: readonly string[]): WindowsOwnerPrivateInspection => realFacts(false, paths),
    };
    const first = resolveLocalVaultKey(options(priv));
    events.length = 0;
    let protectedPath: string | undefined;
    const resolved = resolveLocalVaultKey(
      options({
        inspect: (paths) => realFacts(protectedPath === undefined, paths),
        protect: (path) => {
          protectedPath = path;
        },
      }),
    );
    expect(protectedPath).toBe(join(dir, KEYFILE));
    expect(resolved.key.equals(first.key)).toBe(true);
    expect(custodyOutcomes()).toEqual(["exposed"]);
    expect(currentWindowsVaultCustody()).toBe("exposed");
  });

  it("refuses the key when the key file stays readable by another account", () => {
    const custody = {
      inspect: (paths: readonly string[]): WindowsOwnerPrivateInspection => realFacts(true, paths),
      protect: (): void => undefined,
    };
    expect(() => resolveLocalVaultKey(options(custody))).toThrow(
      "secret vault key file is not private to the current Windows user (foreign-access)",
    );
    expect(custodyOutcomes()).toEqual(["attested", "refused"]);
    const failed = events.find((event) => event.op === "security.vault.key-resolution-failed");
    expect(failed).toMatchObject({ level: "error", errorKind: "unsafe-target" });
    expect(events.some((event) => event.op === "security.vault.key-resolved")).toBe(false);
    // No path, account or SID reaches the Activity Log.
    const text = JSON.stringify(events);
    expect(text).not.toContain(dir);
    expect(text).not.toContain("S-1-5");
  });

  it("refuses a key file that was replaced between open and inspection", () => {
    const custody = {
      inspect: (paths: readonly string[]): WindowsOwnerPrivateInspection => {
        const found = realFacts(false, paths);
        const [directory, keyfile] = found.files;
        if (keyfile === undefined) return found;
        if (directory === undefined || keyfile.kind !== "facts") throw new Error("fixture");
        return { ...found, files: [directory, { ...keyfile, fileIndex: keyfile.fileIndex + 1n }] };
      },
    };
    expect(() => resolveLocalVaultKey(options(custody))).toThrow("(replaced)");
  });

  it("keeps working, and claims nothing, when the inspection cannot run", () => {
    const resolved = resolveLocalVaultKey(
      options({
        inspect: () => {
          throw new Error("windows-owner-private-unavailable");
        },
      }),
    );
    expect(resolved.source).toBe("keyfile");
    expect(custodyOutcomes()).toEqual(["unattested", "unattested"]);
    expect(events.find((event) => event.op === "security.vault.custody")).toMatchObject({
      level: "warn",
      errorKind: "unavailable",
    });
    // Never read as attested: the summary a person sees says unattested.
    expect(currentWindowsVaultCustody()).toBe("unattested");
  });

  it("does not attest on other platforms", () => {
    const resolved = resolveLocalVaultKey({
      ...options({}),
      windowsCustody: {
        platform: "linux",
        inspect: () => {
          throw new Error("must not inspect off Windows");
        },
      },
    });
    expect(resolved.source).toBe("keyfile");
    expect(existsSync(join(dir, KEYFILE))).toBe(true);
    expect(custodyOutcomes()).toEqual([]);
  });
});
