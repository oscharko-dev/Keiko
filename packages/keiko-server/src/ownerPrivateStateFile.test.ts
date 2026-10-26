import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerPrivateFileRefused, readOwnerPrivateFile } from "./ownerPrivateStateFile.js";

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

describe("reading an operator registry from Keiko's state directory", () => {
  it("reads a private file and treats a missing one as absent", () => {
    const directory = root();
    const file = join(directory, "registry.json");
    expect(readOwnerPrivateFile(file, 1_024)).toBeUndefined();
    writeFileSync(file, "{}", { mode: 0o600 });
    expect(readOwnerPrivateFile(file, 1_024)?.toString("utf8")).toBe("{}");
  });

  it("refuses a link, a directory, a file others may write and an oversized file", () => {
    const directory = root();
    const file = join(directory, "registry.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    const link = join(directory, "link.json");
    symlinkSync(file, link);
    expect(refusal(link)).toBe("not-regular-file");
    const folder = join(directory, "folder.json");
    mkdirSync(folder);
    expect(refusal(folder)).toBe("not-regular-file");
    chmodSync(file, 0o602);
    expect(refusal(file)).toBe("not-owner-private");
    chmodSync(file, 0o600);
    expect(refusal(file, 1)).toBe("too-large");
  });
});
