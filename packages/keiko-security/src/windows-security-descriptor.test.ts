import { describe, expect, it } from "vitest";
import {
  evaluateWindowsSecurityDescriptor,
  parseSidBytes,
  WINDOWS_WRITE_ACCESS_MASK,
  type WindowsDescriptorPrincipal,
  type WindowsDescriptorVerdict,
  type WindowsOwnerPrivateRefusal,
} from "./windows-security-descriptor.js";

const USER = "S-1-5-21-1-2-3-1001";
const OTHER_USER = "S-1-5-21-1-2-3-1003";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const EVERYONE = "S-1-1-0";
const AUTHENTICATED_USERS = "S-1-5-11";
const CREATOR_OWNER = "S-1-3-0";
const FULL_CONTROL = 0x001f01ff;
const MODIFY = 0x001301bf;
const READ_EXECUTE = 0x001200a9;
const INHERIT_ONLY = 0x08;
const ALLOWED = 0x00;
const DENIED = 0x01;
const ALLOWED_OBJECT = 0x05;
const ALLOWED_CALLBACK = 0x09;
const ALLOWED_CALLBACK_OBJECT = 0x0b;
const SE_DACL_PRESENT = 0x0004;
const SE_SELF_RELATIVE = 0x8000;

const STANDARD_USER: WindowsDescriptorPrincipal = { userSid: USER, tokenOwnerSid: USER };
const ELEVATED_USER: WindowsDescriptorPrincipal = { userSid: USER, tokenOwnerSid: ADMINISTRATORS };
const OWNER_PRIVATE: WindowsDescriptorVerdict = { kind: "owner-private" };

function refusedWith(reason: WindowsOwnerPrivateRefusal): WindowsDescriptorVerdict {
  return { kind: "refused", reason };
}

// ---- Test-local descriptor builder ---------------------------------------------------------

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function sidBytes(sid: string): number[] {
  const [, revision, authority, ...subAuthorities] = sid.split("-").map(Number);
  const authorityBytes = [0, 0, 0, 0, 0, authority ?? 0];
  const subBytes = subAuthorities.flatMap((value) => u32(value));
  return [revision ?? 0, subAuthorities.length, ...authorityBytes, ...subBytes];
}

function rawAce(type: number, flags: number, body: readonly number[], size?: number): number[] {
  const padded = [...body];
  while ((padded.length + 4) % 4 !== 0) padded.push(0);
  return [type, flags, ...u16(size ?? padded.length + 4), ...padded];
}

function allowAce(sid: string, mask: number, flags = 0, type = ALLOWED): number[] {
  return rawAce(type, flags, [...u32(mask), ...sidBytes(sid)]);
}

function objectAce(
  sid: string,
  mask: number,
  objectFlags: number,
  type = ALLOWED_OBJECT,
): number[] {
  const guids: number[] = [];
  if ((objectFlags & 1) !== 0) guids.push(...new Array<number>(16).fill(0xaa));
  if ((objectFlags & 2) !== 0) guids.push(...new Array<number>(16).fill(0xbb));
  return rawAce(type, 0, [...u32(mask), ...u32(objectFlags), ...guids, ...sidBytes(sid)]);
}

interface AclOptions {
  readonly revision?: number;
  readonly count?: number;
  readonly size?: number;
}

function acl(aces: readonly (readonly number[])[], options: AclOptions = {}): number[] {
  const body = aces.flat();
  const size = options.size ?? body.length + 8;
  const count = options.count ?? aces.length;
  return [options.revision ?? 2, 0, ...u16(size), ...u16(count), 0, 0, ...body];
}

interface DescriptorOptions {
  readonly owner?: string;
  readonly ownerBytes?: readonly number[];
  readonly dacl?: readonly number[] | null;
  readonly control?: number;
  readonly revision?: number;
  readonly ownerOffset?: number;
}

function descriptor(options: DescriptorOptions = {}): Uint8Array {
  const owner = options.ownerBytes ?? sidBytes(options.owner ?? USER);
  const group = sidBytes(USER);
  const dacl = options.dacl === undefined ? standardDacl() : options.dacl;
  const ownerOffset = 20;
  const groupOffset = ownerOffset + owner.length;
  const daclOffset = dacl === null ? 0 : groupOffset + group.length;
  const control = options.control ?? SE_SELF_RELATIVE | SE_DACL_PRESENT;
  const header = [
    options.revision ?? 1,
    0,
    ...u16(control),
    ...u32(options.ownerOffset ?? ownerOffset),
    ...u32(groupOffset),
    ...u32(0),
    ...u32(daclOffset),
  ];
  return Uint8Array.from([...header, ...owner, ...group, ...(dacl ?? [])]);
}

function standardAces(): number[][] {
  return [
    allowAce(USER, FULL_CONTROL),
    allowAce(SYSTEM, FULL_CONTROL),
    allowAce(ADMINISTRATORS, FULL_CONTROL),
  ];
}

function standardDacl(extra: readonly (readonly number[])[] = []): number[] {
  return acl([...standardAces(), ...extra]);
}

function evaluate(bytes: Uint8Array, principal = STANDARD_USER): WindowsDescriptorVerdict {
  return evaluateWindowsSecurityDescriptor(bytes, principal);
}

function fromHex(lines: readonly string[]): Uint8Array {
  const hex = lines.join("");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Deterministic mulberry32 PRNG: the fuzz corpus is identical on every run and every OS. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Real descriptors captured on a Windows 11 host ------------------------------------------
// Captured with GetSecurityDescriptorBinaryForm() on fresh files that `node -e` wrote to %TEMP%.
// Every S-1-5-21 machine/domain SID was replaced, byte-for-byte and consistently, by a synthetic
// SID of identical length: the capturing user became S-1-5-21-1-2-3-1001, another local account
// S-1-5-21-1-2-3-1003, and each remaining foreign SID S-1-5-21-(100+k)-(200+k)-(300+k)-(2000+k).

/** Hardened with `icacls /inheritance:r`: D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>). */
const CAPTURED_OWNER_PRIVATE = fromHex([
  "010004941400000030000000000000004C000000010500000000000515000000010000000200000003000000E9030000",
  "010500000000000515000000010000000200000003000000E9030000020058000300000000001400FF011F0001010000",
  "000000051200000000001800FF011F000102000000000005200000002002000000002400FF011F000105000000000005",
  "15000000010000000200000003000000E9030000",
]);

/** The default inherited %TEMP% DACL of that host: twelve foreign SIDs hold Modify (0x1301bf+). */
const CAPTURED_DEFAULT_TEMP = fromHex([
  "010004841400000030000000000000004C000000010500000000000515000000010000000200000003000000E9030000",
  "010500000000000515000000010000000200000003000000E9030000020008020F00000000102400BF01130001050000",
  "000000051500000065000000C90000002D010000D107000000102400BF01130001050000000000051500000066000000",
  "CA0000002E010000D207000000102400BF01130001050000000000051500000067000000CB0000002F010000D3070000",
  "00102400BF01130001050000000000051500000068000000CC00000030010000D407000000102400BF01130001050000",
  "000000051500000069000000CD00000031010000D507000000102400BF0113000105000000000005150000006A000000",
  "CE00000032010000D607000000102400BF0113000105000000000005150000006B000000CF00000033010000D7070000",
  "00102400BF0113000105000000000005150000006C000000D000000034010000D807000000102400BF01130001050000",
  "00000005150000006D000000D100000035010000D907000000102400BF01130001050000000000051500000001000000",
  "0200000003000000EB03000000102400BF0113000105000000000005150000006E000000D200000036010000DA070000",
  "00102400FF0113000105000000000005150000006F000000D300000037010000DB07000000101400FF011F0001010000",
  "000000051200000000101800FF011F000102000000000005200000002002000000102400FF011F000105000000000005",
  "15000000010000000200000003000000E9030000",
]);

const WRITE_BITS = [
  0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x2000000, 0x10000000, 0x40000000,
];

describe("parseSidBytes", () => {
  it("renders well-known and domain SIDs canonically", () => {
    for (const sid of [SYSTEM, ADMINISTRATORS, EVERYONE, USER, "S-1-0-0"]) {
      const bytes = Uint8Array.from(sidBytes(sid));
      expect(parseSidBytes(bytes, 0)).toEqual({ sid, length: bytes.length });
    }
  });

  it("parses at an offset and accepts zero sub-authorities", () => {
    expect(parseSidBytes(Uint8Array.from([9, 9, 1, 0, 0, 0, 0, 0, 0, 5]), 2)).toEqual({
      sid: "S-1-5",
      length: 8,
    });
  });

  it("renders a 48-bit identifier authority in hexadecimal like ConvertSidToStringSid", () => {
    const bytes = Uint8Array.from([1, 1, 0x12, 0x34, 0, 0, 0, 1, ...u32(7)]);
    expect(parseSidBytes(bytes, 0)?.sid).toBe("S-1-0x123400000001-7");
  });

  it("refuses wrong revisions, too many sub-authorities, truncation, and bad offsets", () => {
    const valid = sidBytes(USER);
    expect(parseSidBytes(Uint8Array.from([2, ...valid.slice(1)]), 0)).toBeUndefined();
    const sixteen = [1, 16, 0, 0, 0, 0, 0, 5, ...new Array<number>(64).fill(0)];
    expect(parseSidBytes(Uint8Array.from(sixteen), 0)).toBeUndefined();
    expect(parseSidBytes(Uint8Array.from(valid.slice(0, -1)), 0)).toBeUndefined();
    expect(parseSidBytes(Uint8Array.from(valid.slice(0, 7)), 0)).toBeUndefined();
    const bytes = Uint8Array.from(valid);
    for (const offset of [-1, 1.5, Number.NaN, bytes.length, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseSidBytes(bytes, offset)).toBeUndefined();
    }
  });
});

describe("WINDOWS_WRITE_ACCESS_MASK", () => {
  it("is exactly the union of the documented write rights", () => {
    expect(WINDOWS_WRITE_ACCESS_MASK).toBe(WRITE_BITS.reduce((mask, bit) => mask | bit, 0));
    expect(WINDOWS_WRITE_ACCESS_MASK & READ_EXECUTE).toBe(0);
  });
});

describe("evaluateWindowsSecurityDescriptor — owner", () => {
  it("accepts a user-owned object whose DACL grants only the user, SYSTEM, and Administrators", () => {
    expect(evaluate(descriptor())).toEqual(OWNER_PRIVATE);
  });

  it("refuses an object owned by another principal", () => {
    expect(evaluate(descriptor({ owner: OTHER_USER }))).toEqual(refusedWith("foreign-owner"));
    expect(evaluate(descriptor({ owner: EVERYONE }))).toEqual(refusedWith("foreign-owner"));
  });

  it("accepts an Administrators owner only when the token's default owner is Administrators", () => {
    const owned = descriptor({ owner: ADMINISTRATORS });
    expect(evaluate(owned, ELEVATED_USER)).toEqual(OWNER_PRIVATE);
    expect(evaluate(owned, STANDARD_USER)).toEqual(refusedWith("foreign-owner"));
  });

  it("accepts a SYSTEM owner only when the token's default owner is SYSTEM", () => {
    const dacl = acl([allowAce(SYSTEM, FULL_CONTROL), allowAce(ADMINISTRATORS, FULL_CONTROL)]);
    const owned = descriptor({ owner: SYSTEM, dacl });
    expect(evaluate(owned, { userSid: SYSTEM, tokenOwnerSid: SYSTEM })).toEqual(OWNER_PRIVATE);
    expect(evaluate(owned, ELEVATED_USER)).toEqual(refusedWith("foreign-owner"));
  });

  it("never treats an arbitrary token owner as an accepted object owner", () => {
    const principal = { userSid: USER, tokenOwnerSid: OTHER_USER };
    expect(evaluate(descriptor({ owner: OTHER_USER }), principal)).toEqual(
      refusedWith("foreign-owner"),
    );
  });
});

describe("evaluateWindowsSecurityDescriptor — DACL", () => {
  it("refuses a NULL DACL whether the present flag is missing or the offset is zero", () => {
    expect(evaluate(descriptor({ control: SE_SELF_RELATIVE }))).toEqual(refusedWith("null-dacl"));
    expect(evaluate(descriptor({ dacl: null }))).toEqual(refusedWith("null-dacl"));
  });

  it("accepts an empty DACL (no access for anybody but the owner's implicit rights)", () => {
    expect(evaluate(descriptor({ dacl: acl([]) }))).toEqual(OWNER_PRIVATE);
  });

  it("skips an inherit-only ACE that grants a foreign write", () => {
    const dacl = standardDacl([allowAce(EVERYONE, FULL_CONTROL, INHERIT_ONLY)]);
    expect(evaluate(descriptor({ dacl }))).toEqual(OWNER_PRIVATE);
  });

  it("refuses a write grant to Everyone, Authenticated Users, Users, or CREATOR OWNER", () => {
    for (const sid of [EVERYONE, AUTHENTICATED_USERS, "S-1-5-32-545", CREATOR_OWNER]) {
      const dacl = standardDacl([allowAce(sid, MODIFY)]);
      expect(evaluate(descriptor({ dacl }))).toEqual(refusedWith("foreign-write"));
    }
  });

  it("accepts a read-only grant to Authenticated Users", () => {
    const dacl = standardDacl([allowAce(AUTHENTICATED_USERS, READ_EXECUTE)]);
    expect(evaluate(descriptor({ dacl }))).toEqual(OWNER_PRIVATE);
  });

  it("ignores deny ACEs, which can only restrict access", () => {
    const dacl = acl([
      rawAce(DENIED, 0, [...u32(FULL_CONTROL), ...sidBytes(EVERYONE)]),
      ...standardAces(),
    ]);
    expect(evaluate(descriptor({ dacl }))).toEqual(OWNER_PRIVATE);
  });

  it("refuses every individual write right granted to a foreign SID", () => {
    for (const bit of WRITE_BITS) {
      const dacl = standardDacl([allowAce(OTHER_USER, bit)]);
      expect(evaluate(descriptor({ dacl })), `bit 0x${bit.toString(16)}`).toEqual(
        refusedWith("foreign-write"),
      );
    }
  });

  it("refuses a callback allow ACE that grants a foreign write and accepts a trusted one", () => {
    const foreign = standardDacl([allowAce(EVERYONE, MODIFY, 0, ALLOWED_CALLBACK)]);
    expect(evaluate(descriptor({ dacl: foreign }))).toEqual(refusedWith("foreign-write"));
    const trusted = standardDacl([allowAce(SYSTEM, MODIFY, 0, ALLOWED_CALLBACK)]);
    expect(evaluate(descriptor({ dacl: trusted }))).toEqual(OWNER_PRIVATE);
  });

  it("locates the SID of object ACEs with and without object-type GUIDs", () => {
    for (const flags of [0, 1, 2, 3]) {
      for (const type of [ALLOWED_OBJECT, ALLOWED_CALLBACK_OBJECT]) {
        const foreign = standardDacl([objectAce(EVERYONE, MODIFY, flags, type)]);
        expect(evaluate(descriptor({ dacl: foreign }))).toEqual(refusedWith("foreign-write"));
        const trusted = standardDacl([objectAce(USER, MODIFY, flags, type)]);
        expect(evaluate(descriptor({ dacl: trusted }))).toEqual(OWNER_PRIVATE);
      }
    }
  });

  it("refuses an ACE type outside the supported set, such as a mandatory label", () => {
    for (const type of [0x02, 0x03, 0x04, 0x07, 0x08, 0x0d, 0x11, 0x12, 0x13, 0xff]) {
      const dacl = standardDacl([rawAce(type, 0, [...u32(0), ...sidBytes(EVERYONE)])]);
      expect(evaluate(descriptor({ dacl })), `type 0x${type.toString(16)}`).toEqual(
        refusedWith("unsupported-ace"),
      );
    }
  });
});

describe("evaluateWindowsSecurityDescriptor — malformed input", () => {
  const malformed = refusedWith("malformed-descriptor");

  it("refuses a truncated header, a wrong revision, and an absolute descriptor", () => {
    expect(evaluate(new Uint8Array(0))).toEqual(malformed);
    expect(evaluate(descriptor().subarray(0, 19))).toEqual(malformed);
    expect(evaluate(descriptor({ revision: 2 }))).toEqual(malformed);
    expect(evaluate(descriptor({ control: SE_DACL_PRESENT }))).toEqual(malformed);
  });

  it("refuses an absent, overlapping, or out-of-bounds owner", () => {
    expect(evaluate(descriptor({ ownerOffset: 0 }))).toEqual(malformed);
    expect(evaluate(descriptor({ ownerOffset: 4 }))).toEqual(malformed);
    expect(evaluate(descriptor({ ownerOffset: 0xffff_fff0 }))).toEqual(malformed);
  });

  it("bounds-checks the group SID and the SACL header even though neither is evaluated", () => {
    const valid = descriptor();
    const daclOffset = new DataView(valid.buffer).getUint32(16, true);
    const withHeaderField = (field: number, value: number): Uint8Array => {
      const bytes = Uint8Array.from(valid);
      new DataView(bytes.buffer).setUint32(field, value, true);
      return bytes;
    };
    expect(evaluate(withHeaderField(8, valid.length))).toEqual(malformed);
    expect(evaluate(withHeaderField(8, daclOffset))).toEqual(malformed);
    expect(evaluate(withHeaderField(12, 20))).toEqual(malformed);
    expect(evaluate(withHeaderField(12, valid.length - 4))).toEqual(malformed);
    expect(evaluate(withHeaderField(12, daclOffset))).toEqual(OWNER_PRIVATE);
  });

  it("refuses an owner SID with sixteen sub-authorities", () => {
    const ownerBytes = [1, 16, 0, 0, 0, 0, 0, 5, ...new Array<number>(64).fill(1)];
    expect(evaluate(descriptor({ ownerBytes }))).toEqual(malformed);
  });

  it("refuses an ACE that is too small, unaligned, or overruns the ACL", () => {
    const body = [...u32(READ_EXECUTE), ...sidBytes(USER)];
    for (const size of [0, 4, 6, 26]) {
      const dacl = acl([...standardAces(), rawAce(ALLOWED, 0, body, size)]);
      expect(evaluate(descriptor({ dacl })), `size ${String(size)}`).toEqual(malformed);
    }
    const overrun = acl([...standardAces(), rawAce(ALLOWED, 0, body, body.length + 8)]);
    expect(evaluate(descriptor({ dacl: overrun }))).toEqual(malformed);
  });

  it("refuses an ACE count larger than the ACEs present and an AclSize beyond the buffer", () => {
    expect(evaluate(descriptor({ dacl: acl(standardAces(), { count: 4 }) }))).toEqual(malformed);
    const tooLarge = acl(standardAces(), { size: 0x400 });
    expect(evaluate(descriptor({ dacl: tooLarge }))).toEqual(malformed);
    expect(evaluate(descriptor({ dacl: acl([], { size: 4 }) }))).toEqual(malformed);
  });

  it("refuses an unknown ACL revision and an ACE SID that leaves the ACE", () => {
    expect(evaluate(descriptor({ dacl: acl(standardAces(), { revision: 3 }) }))).toEqual(malformed);
    const truncatedSid = rawAce(ALLOWED, 0, [...u32(READ_EXECUTE), ...sidBytes(USER).slice(0, 12)]);
    expect(evaluate(descriptor({ dacl: acl([truncatedSid]) }))).toEqual(malformed);
  });

  it("refuses an object ACE with unknown object flags or a missing flags field", () => {
    const unknownFlags = rawAce(ALLOWED_OBJECT, 0, [...u32(0), ...u32(4), ...sidBytes(USER)]);
    expect(evaluate(descriptor({ dacl: acl([unknownFlags]) }))).toEqual(malformed);
    const noFlags = rawAce(ALLOWED_OBJECT, 0, u32(0));
    expect(evaluate(descriptor({ dacl: acl([noFlags]) }))).toEqual(malformed);
  });

  it("reports a malformed DACL before the owner and NULL-DACL verdicts", () => {
    const broken = acl(standardAces(), { count: 9 });
    expect(evaluate(descriptor({ owner: EVERYONE, dacl: broken }))).toEqual(malformed);
    const absent = descriptor({ dacl: broken, control: SE_SELF_RELATIVE });
    expect(evaluate(absent)).toEqual(malformed);
  });

  it("never throws for random byte arrays", () => {
    const random = seededRandom(0x4068);
    for (let iteration = 0; iteration < 5000; iteration += 1) {
      const bytes = Uint8Array.from({ length: Math.floor(random() * 160) }, () =>
        Math.floor(random() * 256),
      );
      if (random() < 0.5 && bytes.length >= 4) bytes[2] = 0x04;
      if (bytes.length >= 4) bytes[3] = 0x80;
      expect(() => evaluate(bytes)).not.toThrow();
    }
  });

  it("never throws for single-byte mutations of a valid descriptor", () => {
    const random = seededRandom(0x5eed);
    const valid = descriptor({
      dacl: standardDacl([objectAce(USER, MODIFY, 3), allowAce(EVERYONE, MODIFY, INHERIT_ONLY)]),
    });
    for (let iteration = 0; iteration < 5000; iteration += 1) {
      const bytes = Uint8Array.from(valid);
      bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
      const verdict = evaluate(bytes.subarray(0, bytes.length - Math.floor(random() * 3)));
      expect(["owner-private", "refused"]).toContain(verdict.kind);
    }
  });

  it("honours a subarray view instead of reading the backing buffer", () => {
    const valid = descriptor();
    const padded = new Uint8Array(valid.length + 8);
    padded.set(valid, 8);
    expect(evaluate(padded.subarray(8))).toEqual(OWNER_PRIVATE);
  });
});

describe("evaluateWindowsSecurityDescriptor — captured Windows descriptors", () => {
  it("accepts the captured owner-private descriptor for its owner", () => {
    expect(evaluate(CAPTURED_OWNER_PRIVATE)).toEqual(OWNER_PRIVATE);
    expect(evaluate(CAPTURED_OWNER_PRIVATE, ELEVATED_USER)).toEqual(OWNER_PRIVATE);
    const stranger = { userSid: OTHER_USER, tokenOwnerSid: OTHER_USER };
    expect(evaluate(CAPTURED_OWNER_PRIVATE, stranger)).toEqual(refusedWith("foreign-owner"));
  });

  it("refuses the captured default %TEMP% descriptor, whose inherited DACL grants foreign Modify", () => {
    expect(evaluate(CAPTURED_DEFAULT_TEMP)).toEqual(refusedWith("foreign-write"));
  });
});
