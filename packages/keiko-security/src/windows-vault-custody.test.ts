import { beforeEach, describe, expect, it } from "vitest";
import type { SecurityLogEvent } from "./log-port.js";
import type {
  WindowsOpenedFileIdentity,
  WindowsOwnerPrivateFacts,
  WindowsOwnerPrivateInspection,
} from "./windows-owner-private.js";
import {
  attestWindowsVaultCustody,
  currentWindowsVaultCustody,
  resetWindowsVaultCustodyForTest,
  secureWindowsVaultDirectory,
  WindowsVaultCustodyError,
  type WindowsVaultCustodyPorts,
} from "./windows-vault-custody.js";
import {
  expectActivityLogProof,
  formatActivityLogProofLine,
} from "../../../tests/support/activity-log-proof.js";

const USER = "S-1-5-21-1-2-3-1001";
const OTHER_USER = "S-1-5-21-1-2-3-1003";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const AUTHENTICATED_USERS = "S-1-5-11";
const FULL_CONTROL = 0x001f01ff;
const READ_EXECUTE = 0x001200a9;
const MODIFY = 0x001301bf;
const DIRECTORY_ATTRIBUTE = 0x10;
const ARCHIVE_ATTRIBUTE = 0x20;
const REPARSE_ATTRIBUTE = 0x400;

const DIRECTORY = String.raw`C:\Users\dev\.keiko\credentials`;
const KEYFILE = String.raw`C:\Users\dev\.keiko\credentials\atlassian-connector-credentials-vault.key`;
const DIRECTORY_ID: WindowsOpenedFileIdentity = { dev: 7n, ino: 100n };
const KEYFILE_ID: WindowsOpenedFileIdentity = { dev: 7n, ino: 200n };

function sidBytes(sid: string): Buffer {
  const [, , authority, ...subAuthorities] = sid.split("-").map(Number);
  const bytes = Buffer.alloc(8 + 4 * subAuthorities.length);
  bytes.set([1, subAuthorities.length, 0, 0, 0, 0, 0, authority ?? 0]);
  subAuthorities.forEach((value, index) => bytes.writeUInt32LE(value, 8 + 4 * index));
  return bytes;
}

/** A self-relative descriptor owned by `owner` whose DACL allows each `[sid, mask]` pair. */
function descriptor(owner: string, grants: readonly (readonly [string, number])[]): Uint8Array {
  const aces = grants.map(([sid, mask]) => {
    const body = sidBytes(sid);
    const ace = Buffer.alloc(8 + body.length);
    ace.writeUInt16LE(ace.length, 2);
    ace.writeUInt32LE(mask, 4);
    body.copy(ace, 8);
    return ace;
  });
  const aceBytes = Buffer.concat(aces);
  const acl = Buffer.alloc(8);
  acl.writeUInt8(2, 0);
  acl.writeUInt16LE(8 + aceBytes.length, 2);
  acl.writeUInt16LE(aces.length, 4);
  const ownerBytes = sidBytes(owner);
  const header = Buffer.alloc(20);
  header.writeUInt8(1, 0);
  header.writeUInt16LE(0x8004, 2);
  header.writeUInt32LE(20, 4);
  header.writeUInt32LE(20 + ownerBytes.length, 16);
  return new Uint8Array(Buffer.concat([header, ownerBytes, acl, aceBytes]));
}

const OWNER_ONLY = descriptor(USER, [
  [USER, FULL_CONTROL],
  [SYSTEM, FULL_CONTROL],
  [ADMINISTRATORS, FULL_CONTROL],
]);
const READABLE_BY_OTHERS = descriptor(USER, [
  [USER, FULL_CONTROL],
  [AUTHENTICATED_USERS, READ_EXECUTE],
]);
const WRITABLE_BY_OTHERS = descriptor(USER, [
  [USER, FULL_CONTROL],
  [AUTHENTICATED_USERS, MODIFY],
]);
const FOREIGN_OWNER = descriptor(OTHER_USER, [[USER, FULL_CONTROL]]);

function facts(
  identity: WindowsOpenedFileIdentity,
  attributes: number,
  bytes: Uint8Array,
): WindowsOwnerPrivateFacts {
  return {
    kind: "facts",
    attributes,
    volumeSerial: identity.dev,
    fileIndex: identity.ino,
    links: 1,
    descriptor: bytes,
  };
}

function inspection(
  directory: WindowsOwnerPrivateFacts,
  keyfile: WindowsOwnerPrivateFacts,
): WindowsOwnerPrivateInspection {
  return { principal: { userSid: USER, tokenOwnerSid: USER }, files: [directory, keyfile] };
}

const privateDirectory = facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE, OWNER_ONLY);
const privateKeyfile = facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, OWNER_ONLY);

interface Harness {
  readonly ports: WindowsVaultCustodyPorts;
  readonly events: SecurityLogEvent[];
  readonly inspected: (readonly string[])[];
  readonly protectedPaths: { readonly path: string; readonly inherit: boolean }[];
}

/** `answers` are consumed one per inspection; an Error answer makes that inspection throw. */
function harness(
  answers: readonly (WindowsOwnerPrivateInspection | Error)[],
  protect?: (path: string) => void,
): Harness {
  const events: SecurityLogEvent[] = [];
  const inspected: (readonly string[])[] = [];
  const protectedPaths: { path: string; inherit: boolean }[] = [];
  const queue = [...answers];
  return {
    events,
    inspected,
    protectedPaths,
    ports: {
      inspect: (paths): WindowsOwnerPrivateInspection => {
        inspected.push(paths);
        const answer = queue.shift();
        if (answer === undefined) throw new Error("unexpected inspection");
        if (answer instanceof Error) throw answer;
        return answer;
      },
      protect: (path, options): void => {
        protectedPaths.push({ path, inherit: options.inheritToChildren === true });
        protect?.(path);
      },
      directoryIdentity: () => DIRECTORY_ID,
    },
  };
}

function attest(h: Harness): ReturnType<typeof attestWindowsVaultCustody> {
  return attestWindowsVaultCustody(
    {
      directory: DIRECTORY,
      keyfile: KEYFILE,
      keyfileIdentity: KEYFILE_ID,
      sink: { write: (event): void => void h.events.push(event) },
    },
    h.ports,
  );
}

function custodyLine(h: Harness): Record<string, unknown> {
  const event = h.events.find((candidate) => candidate.op === "security.vault.custody");
  return expectActivityLogProof(
    "security.vault.custody.decision",
    formatActivityLogProofLine(event ?? {}),
  );
}

function expectBodyFree(h: Harness): void {
  const text = JSON.stringify(h.events);
  for (const secret of [DIRECTORY, KEYFILE, "dev", USER, OTHER_USER, "S-1-5"]) {
    expect(text).not.toContain(secret);
  }
}

beforeEach(() => {
  resetWindowsVaultCustodyForTest();
});

describe("attestWindowsVaultCustody", () => {
  it("attests a key file and directory that only the user, SYSTEM and Administrators reach", () => {
    const h = harness([inspection(privateDirectory, privateKeyfile)]);
    expect(attest(h)).toBe("attested");
    expect(h.inspected).toEqual([[DIRECTORY, KEYFILE]]);
    expect(h.protectedPaths).toEqual([]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ category: "security", level: "info" });
    expect(custodyLine(h)).toMatchObject({ outcome: "attested", target: "none", reason: "none" });
    expectBodyFree(h);
  });

  // The key may have been read while it was reachable: protecting it afterwards is not "all good".
  it("reports a key file another account could read as exposed, after protecting it", () => {
    const h = harness([
      inspection(privateDirectory, facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, READABLE_BY_OTHERS)),
      inspection(privateDirectory, privateKeyfile),
    ]);
    expect(attest(h)).toBe("exposed");
    expect(h.protectedPaths).toEqual([{ path: KEYFILE, inherit: false }]);
    expect(h.events.at(-1)).toMatchObject({ level: "warn", errorKind: "unsafe-target" });
    expect(custodyLine(h)).toMatchObject({ outcome: "exposed", target: "keyfile" });
    expect(currentWindowsVaultCustody()).toBe("exposed");
    expectBodyFree(h);
  });

  it("reports exposure when both the directory and the key file were reachable", () => {
    const h = harness([
      inspection(
        facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE, WRITABLE_BY_OTHERS),
        facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, WRITABLE_BY_OTHERS),
      ),
      inspection(privateDirectory, privateKeyfile),
    ]);
    expect(attest(h)).toBe("exposed");
    expect(h.protectedPaths).toEqual([
      { path: DIRECTORY, inherit: true },
      { path: KEYFILE, inherit: false },
    ]);
    expect(custodyLine(h)).toMatchObject({ outcome: "exposed", target: "both" });
  });

  it("reports protected when only the directory was reachable and the key file was private", () => {
    const h = harness([
      inspection(facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE, READABLE_BY_OTHERS), privateKeyfile),
      inspection(privateDirectory, privateKeyfile),
    ]);
    expect(attest(h)).toBe("protected");
    expect(h.protectedPaths).toEqual([{ path: DIRECTORY, inherit: true }]);
    expect(custodyLine(h)).toMatchObject({ outcome: "protected", target: "directory" });
    expect(currentWindowsVaultCustody()).toBe("protected");
  });

  it("refuses when protection did not make the object private", () => {
    const readable = inspection(
      privateDirectory,
      facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, READABLE_BY_OTHERS),
    );
    const h = harness([readable, readable]);
    expect(() => attest(h)).toThrow(WindowsVaultCustodyError);
    expect(h.events.at(-1)).toMatchObject({ level: "error", errorKind: "unsafe-target" });
    expect(custodyLine(h)).toMatchObject({
      outcome: "refused",
      target: "keyfile",
      reason: "foreign-access",
    });
    expectBodyFree(h);
  });

  it("refuses an object owned by another account, which protection cannot change", () => {
    const foreign = inspection(
      privateDirectory,
      facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, FOREIGN_OWNER),
    );
    const h = harness([foreign, foreign]);
    expect(() => attest(h)).toThrow("not private to the current Windows user (foreign-owner)");
    expect(custodyLine(h)).toMatchObject({ outcome: "refused", reason: "foreign-owner" });
  });

  it("refuses when the object cannot be protected", () => {
    const h = harness(
      [inspection(facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE, READABLE_BY_OTHERS), privateKeyfile)],
      () => {
        throw new Error("icacls failed for C:\\Users\\dev");
      },
    );
    let thrown: unknown;
    try {
      attest(h);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WindowsVaultCustodyError);
    expect((thrown as WindowsVaultCustodyError).code).toBe("unsafe-target");
    expect((thrown as Error).message).not.toContain("dev");
    expect(custodyLine(h)).toMatchObject({
      outcome: "refused",
      target: "directory",
      reason: "protect-failed",
    });
    expectBodyFree(h);
  });

  it("refuses when a repair cannot be verified afterwards", () => {
    const h = harness([
      inspection(privateDirectory, facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, READABLE_BY_OTHERS)),
      new Error("windows-owner-private-unavailable"),
    ]);
    expect(() => attest(h)).toThrow(WindowsVaultCustodyError);
    expect(custodyLine(h)).toMatchObject({
      outcome: "refused",
      target: "keyfile",
      reason: "inspection-unavailable",
    });
  });

  it.each([
    [
      "a key file replaced after it was opened",
      inspection(privateDirectory, facts({ dev: 7n, ino: 999n }, ARCHIVE_ATTRIBUTE, OWNER_ONLY)),
      "keyfile",
      "replaced",
    ],
    [
      "a key file that is a reparse point",
      inspection(
        privateDirectory,
        facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE | REPARSE_ATTRIBUTE, OWNER_ONLY),
      ),
      "keyfile",
      "not-regular-file",
    ],
    [
      "a directory replaced after the inspection",
      inspection(facts({ dev: 7n, ino: 999n }, DIRECTORY_ATTRIBUTE, OWNER_ONLY), privateKeyfile),
      "directory",
      "replaced",
    ],
    [
      "a directory that is a junction",
      inspection(
        facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE | REPARSE_ATTRIBUTE, OWNER_ONLY),
        privateKeyfile,
      ),
      "directory",
      "not-directory",
    ],
    [
      "a directory path that holds a file",
      inspection(facts(DIRECTORY_ID, ARCHIVE_ATTRIBUTE, OWNER_ONLY), privateKeyfile),
      "directory",
      "not-directory",
    ],
  ] as const)("refuses %s without rewriting any permission", (_label, found, target, reason) => {
    const h = harness([found]);
    expect(() => attest(h)).toThrow(WindowsVaultCustodyError);
    expect(h.protectedPaths).toEqual([]);
    expect(custodyLine(h)).toMatchObject({ outcome: "refused", target, reason });
  });

  it.each([
    ["the inspection cannot run", new Error("windows-owner-private-unavailable")],
    ["an object could not be opened", inspection(privateDirectory, { kind: "unavailable" })],
  ] as const)("claims nothing and keeps working when %s", (_label, answer) => {
    const h = harness([answer]);
    expect(attest(h)).toBe("unattested");
    expect(h.protectedPaths).toEqual([]);
    expect(h.events.at(-1)).toMatchObject({ level: "warn", errorKind: "unavailable" });
    expect(custodyLine(h)).toMatchObject({
      outcome: "unattested",
      target: "none",
      reason: "inspection-unavailable",
    });
    expectBodyFree(h);
  });
});

function secure(h: Harness): ReturnType<typeof secureWindowsVaultDirectory> {
  return secureWindowsVaultDirectory(
    { directory: DIRECTORY, sink: { write: (event): void => void h.events.push(event) } },
    h.ports,
  );
}

function directoryOnly(directory: WindowsOwnerPrivateFacts): WindowsOwnerPrivateInspection {
  return { principal: { userSid: USER, tokenOwnerSid: USER }, files: [directory] };
}

// A new key file inherits its directory's permissions, so the directory is private first.
describe("secureWindowsVaultDirectory", () => {
  it("inspects the directory alone and attests a private one", () => {
    const h = harness([directoryOnly(privateDirectory)]);
    expect(secure(h)).toBe("attested");
    expect(h.inspected).toEqual([[DIRECTORY]]);
    expect(h.protectedPaths).toEqual([]);
  });

  it("makes a reachable directory private, with inheritable entries, before any key exists", () => {
    const h = harness([
      directoryOnly(facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE, READABLE_BY_OTHERS)),
      directoryOnly(privateDirectory),
    ]);
    expect(secure(h)).toBe("protected");
    expect(h.protectedPaths).toEqual([{ path: DIRECTORY, inherit: true }]);
    expect(custodyLine(h)).toMatchObject({ outcome: "protected", target: "directory" });
  });

  it("refuses to hold a key in a directory that stays reachable", () => {
    const reachable = directoryOnly(facts(DIRECTORY_ID, DIRECTORY_ATTRIBUTE, READABLE_BY_OTHERS));
    const h = harness([reachable, reachable]);
    expect(() => secure(h)).toThrow(WindowsVaultCustodyError);
    expect(custodyLine(h)).toMatchObject({ outcome: "refused", target: "directory" });
  });

  it("claims nothing when the inspection cannot run", () => {
    const h = harness([new Error("windows-owner-private-unavailable")]);
    expect(secure(h)).toBe("unattested");
    expect(currentWindowsVaultCustody()).toBe("unattested");
  });
});

// #4358 audit: "unattested" must never be read as "attested", anywhere.
describe("the process custody summary", () => {
  const privateOnce = (): Harness => harness([inspection(privateDirectory, privateKeyfile)]);

  it("is undefined until a vault was judged", () => {
    expect(currentWindowsVaultCustody()).toBeUndefined();
  });

  it("keeps the worst outcome: a later attested vault never hides an unattested or exposed one", () => {
    attest(harness([new Error("windows-owner-private-unavailable")]));
    expect(currentWindowsVaultCustody()).toBe("unattested");
    attest(privateOnce());
    expect(currentWindowsVaultCustody()).toBe("unattested");
    attest(
      harness([
        inspection(privateDirectory, facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, READABLE_BY_OTHERS)),
        inspection(privateDirectory, privateKeyfile),
      ]),
    );
    expect(currentWindowsVaultCustody()).toBe("exposed");
    attest(privateOnce());
    expect(currentWindowsVaultCustody()).toBe("exposed");
  });

  it("reports attested only when every judged vault attested", () => {
    attest(privateOnce());
    attest(privateOnce());
    expect(currentWindowsVaultCustody()).toBe("attested");
  });

  it("does not enter a refused vault, which never yields a key", () => {
    const foreign = inspection(
      privateDirectory,
      facts(KEYFILE_ID, ARCHIVE_ATTRIBUTE, FOREIGN_OWNER),
    );
    expect(() => attest(harness([foreign, foreign]))).toThrow(WindowsVaultCustodyError);
    expect(currentWindowsVaultCustody()).toBeUndefined();
  });
});
