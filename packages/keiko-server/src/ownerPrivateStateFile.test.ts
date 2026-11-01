import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantOthersWrite, makeOwnerPrivate } from "./test-support/owner-private-fixture.js";
import {
  OwnerPrivateFileRefused,
  ownerPrivateReaderFor,
  readOwnerPrivateFile,
} from "./ownerPrivateStateFile.js";
import { plantSymlinkOrSkip } from "./test-support/symlink-fixture.js";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "keiko-owner-private-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function refusal(path: string, maxBytes = 1_024): unknown {
  try {
    readOwnerPrivateFile(path, maxBytes);
  } catch (error) {
    return error instanceof OwnerPrivateFileRefused ? error.reason : error;
  }
  return undefined;
}

function privateFile(directory: string, name = "registry.json", body = "{}"): string {
  const file = join(directory, name);
  writeFileSync(file, body, { mode: 0o600 });
  makeOwnerPrivate(file);
  return file;
}

describe("reading an operator registry from Keiko's state directory", () => {
  it("reads a private file and treats a missing one as absent", () => {
    const directory = root();
    expect(readOwnerPrivateFile(join(directory, "registry.json"), 1_024)).toBeUndefined();
    const file = privateFile(directory);
    expect(readOwnerPrivateFile(file, 1_024)?.toString("utf8")).toBe("{}");
  });

  it("refuses a directory, a file others may write and an oversized file", () => {
    const directory = root();
    const file = privateFile(directory);
    const folder = join(directory, "folder.json");
    mkdirSync(folder);
    expect(refusal(folder)).toBe("not-regular-file");
    expect(refusal(file, 1)).toBe("too-large");
    grantOthersWrite(file);
    expect(refusal(file)).toBe("not-owner-private");
  });

  it("refuses a link to a private file", (context) => {
    const directory = root();
    const file = privateFile(directory);
    const link = join(directory, "link.json");
    plantSymlinkOrSkip(context, file, link);
    expect(refusal(link)).toBe("not-regular-file");
  });

  it("refuses a file whose mode grants group write on POSIX", () => {
    const file = privateFile(root());
    chmodSync(file, 0o620);
    expect(refusal(file)).toBe(process.platform === "win32" ? undefined : "not-owner-private");
  });

  it("reads a batch through one reader and refuses a path it was not given", () => {
    const directory = root();
    const first = privateFile(directory, "a.json", "1");
    const second = privateFile(directory, "b.json", "2");
    const outside = privateFile(directory, "c.json", "3");
    const reader = ownerPrivateReaderFor([first, second, join(directory, "missing.json")]);
    expect(reader.read(first, 16)?.toString("utf8")).toBe("1");
    expect(reader.read(second, 16)?.toString("utf8")).toBe("2");
    expect(reader.read(join(directory, "missing.json"), 16)).toBeUndefined();
    const expected = process.platform === "win32" ? "not-owner-private" : undefined;
    let refused: unknown;
    try {
      reader.read(outside, 16);
    } catch (error) {
      refused = error instanceof OwnerPrivateFileRefused ? error.reason : error;
    }
    expect(refused).toBe(expected);
  });
});

describe("the Windows owner-private check through an injected inspection", () => {
  it("refuses every file when the inspection itself is unavailable", () => {
    const file = privateFile(root());
    const reader = ownerPrivateReaderFor([file], {
      platform: "win32",
      inspect: () => {
        throw new Error("powershell blocked");
      },
    });
    expect(() => reader.read(file, 16)).toThrow(OwnerPrivateFileRefused);
  });

  it("refuses a file whose inspected identity differs from the opened descriptor", () => {
    const file = privateFile(root());
    const reader = ownerPrivateReaderFor([file], {
      platform: "win32",
      inspect: () => ({
        principal: { userSid: "S-1-5-21-1-2-3-1001", tokenOwnerSid: "S-1-5-21-1-2-3-1001" },
        files: [
          {
            kind: "facts",
            attributes: 0x20,
            volumeSerial: -1n,
            fileIndex: -1n,
            links: 1,
            descriptor: new Uint8Array(),
          },
        ],
      }),
    });
    expect(() => reader.read(file, 16)).toThrow("owner-private-file-not-owner-private");
  });

  it("refuses a reparse point the inspection reported, as not a regular file", () => {
    const file = privateFile(root());
    const reader = ownerPrivateReaderFor([file], {
      platform: "win32",
      inspect: () => ({
        principal: { userSid: "S-1-5-21-1-2-3-1001", tokenOwnerSid: "S-1-5-21-1-2-3-1001" },
        files: [
          {
            kind: "facts",
            attributes: 0x400,
            volumeSerial: 0n,
            fileIndex: 0n,
            links: 1,
            descriptor: new Uint8Array(),
          },
        ],
      }),
    });
    expect(() => reader.read(file, 16)).toThrow("owner-private-file-not-regular-file");
  });
});
