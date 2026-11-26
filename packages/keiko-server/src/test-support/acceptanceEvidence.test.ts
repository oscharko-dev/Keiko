import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ownerPrivateEvidenceTarget,
  writeOwnerPrivateEvidence,
  type WindowsOwnerPrivacy,
} from "./acceptanceEvidence.js";

const POSIX = process.platform !== "win32";

let sandbox: string;
let checkout: string;
let outside: string;

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "keiko-acceptance-evidence-")));
  checkout = join(sandbox, "checkout");
  outside = join(sandbox, "outside");
  mkdirSync(checkout);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("ownerPrivateEvidenceTarget", () => {
  it("refuses a file inside the checkout", () => {
    expect(() => ownerPrivateEvidenceTarget(join(checkout, "evidence.json"), checkout)).toThrow(
      "acceptance-evidence-inside-checkout",
    );
  });

  it("refuses a not-yet-existing nested target below the checkout", () => {
    expect(() =>
      ownerPrivateEvidenceTarget(join(checkout, "a", "b", "evidence.json"), checkout),
    ).toThrow("acceptance-evidence-inside-checkout");
  });

  it("refuses the checkout root itself", () => {
    expect(() => ownerPrivateEvidenceTarget(checkout, checkout)).toThrow(
      "acceptance-evidence-inside-checkout",
    );
  });

  it("refuses a path that reaches the checkout through a symbolic link", () => {
    const link = join(outside, "link");
    symlinkSync(checkout, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => ownerPrivateEvidenceTarget(join(link, "evidence.json"), checkout)).toThrow(
      "acceptance-evidence-inside-checkout",
    );
  });

  it("returns a nested, not-yet-existing target outside the checkout resolved", () => {
    const requested = join(outside, "deep", "er", "evidence.json");
    expect(ownerPrivateEvidenceTarget(requested, checkout)).toBe(requested);
  });

  it("returns an existing target outside the checkout", () => {
    const requested = join(outside, "evidence.json");
    writeFileSync(requested, "{}");
    expect(ownerPrivateEvidenceTarget(requested, checkout)).toBe(requested);
  });

  it("does not mistake a sibling whose name starts with the checkout's for the inside", () => {
    const sibling = join(sandbox, "checkout-other");
    mkdirSync(sibling);
    const requested = join(sibling, "evidence.json");
    expect(ownerPrivateEvidenceTarget(requested, checkout)).toBe(requested);
  });
});

describe.skipIf(!POSIX)("writeOwnerPrivateEvidence on POSIX", () => {
  it("creates the directory owner-only and writes the file with mode 0600", () => {
    const target = join(outside, "new", "evidence.json");
    writeOwnerPrivateEvidence(target, "content");
    expect(readFileSync(target, "utf8")).toBe("content");
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(outside, "new")).mode & 0o077).toBe(0);
  });

  it("tightens a pre-existing 0644 file to 0600 and truncates it", () => {
    chmodSync(outside, 0o700);
    const target = join(outside, "evidence.json");
    writeFileSync(target, "old content that is longer");
    chmodSync(target, 0o644);
    writeOwnerPrivateEvidence(target, "new");
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
  });

  it("refuses a directory other users can enter", () => {
    const directory = join(outside, "open");
    mkdirSync(directory);
    chmodSync(directory, 0o755);
    expect(() => {
      writeOwnerPrivateEvidence(join(directory, "evidence.json"), "content");
    }).toThrow("acceptance-evidence-directory-not-owner-private");
  });

  it("refuses a target that is a symbolic link and leaves its destination untouched", () => {
    const destination = join(outside, "destination.txt");
    writeFileSync(destination, "keep");
    const directory = join(outside, "private");
    mkdirSync(directory, { mode: 0o700 });
    const target = join(directory, "evidence.json");
    symlinkSync(destination, target);
    expect(() => {
      writeOwnerPrivateEvidence(target, "overwrite");
    }).toThrow(/ELOOP|ENOTSUP|EMLINK/u);
    expect(readFileSync(destination, "utf8")).toBe("keep");
  });
});

// The Windows branch runs on every host: only `process.platform` is stood in, and the privacy
// setters are fakes, so no ACL is touched.
describe("writeOwnerPrivateEvidence on the Windows branch", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });
  afterEach(() => {
    if (realPlatform !== undefined) Object.defineProperty(process, "platform", realPlatform);
  });

  it("fails closed without the owner-private setters", () => {
    expect(() => {
      writeOwnerPrivateEvidence(join(outside, "evidence.json"), "content");
    }).toThrow("acceptance-evidence-windows-privacy-missing");
  });

  it("restricts the directory, then the empty file, before the content is written", () => {
    const calls: string[] = [];
    const target = join(outside, "evidence.json");
    const privacy: WindowsOwnerPrivacy = {
      makeOwnerPrivateDirectory: (path) => {
        calls.push(`directory:${path}`);
      },
      makeOwnerPrivate: (path) => {
        calls.push(`file:${path}:${readFileSync(path, "utf8")}`);
      },
    };
    writeOwnerPrivateEvidence(target, "content", privacy);
    expect(calls).toEqual([`directory:${outside}`, `file:${target}:`]);
    expect(readFileSync(target, "utf8")).toBe("content");
  });
});
