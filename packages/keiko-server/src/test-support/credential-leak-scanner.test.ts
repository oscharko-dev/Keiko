import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  base64Spellings,
  createCredentialScanner,
  type CredentialFootprint,
  credentialSpellings,
} from "./credential-leak-scanner.js";

// The acceptance cases claim a planted login never reaches a run. That claim is worth only what the
// scanner can see, so every spelling it names is planted in a file and must be reported.
const USER = "relay-user";
// Assembled at runtime so the secret scan of this tree sees no credential-shaped literal.
const SECRET = ["planted", "Secret", "8f31c2d9"].join("-");
const ROOTS: string[] = [];

afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

function plantedRoot(files: Readonly<Record<string, string | Buffer>>): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-leak-scanner-"));
  ROOTS.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function footprintOf(root: string, skip?: ReadonlySet<string>): CredentialFootprint {
  const scanner = createCredentialScanner({
    root,
    spellings: credentialSpellings(SECRET, USER),
    skipDirectories: skip,
    settingsSuffix: "settings.xml",
    minIntervalMs: 0,
  });
  scanner.scan();
  return scanner.result([]);
}

describe("credentialSpellings (#4522)", () => {
  it("names the secret, the pair and their base64 and base64url spellings", () => {
    const forms = credentialSpellings(SECRET, USER);
    expect(forms).toContain(SECRET);
    expect(forms).toContain(`${USER}:${SECRET}`);
    expect(forms).toContain(Buffer.from(SECRET).toString("base64"));
    expect(forms).toContain(Buffer.from(`${USER}:${SECRET}`).toString("base64"));
    expect(forms).toContain(Buffer.from(`${USER}:${SECRET}`).toString("base64url"));
  });

  it("drops a spelling too short to be evidence", () => {
    expect(base64Spellings("ab")).toEqual([]);
  });
});

describe("a planted credential is reported in every spelling (#4522)", () => {
  const data = (value: string): Buffer => Buffer.from(value);
  const framed = (filler: number, value: string, alphabet: "base64" | "base64url"): string =>
    Buffer.concat([
      Buffer.alloc(filler, 0x7a),
      data(value),
      Buffer.from("-trailing-bytes"),
    ]).toString(alphabet);
  const cases: readonly (readonly [string, string])[] = [
    ["the raw secret", `password=${SECRET};`],
    ["the raw user:password pair", `auth ${USER}:${SECRET} end`],
    ["standalone base64 of the secret", Buffer.from(SECRET).toString("base64")],
    ["standalone base64 of the pair", Buffer.from(`${USER}:${SECRET}`).toString("base64")],
    ["standalone base64url of the pair", Buffer.from(`${USER}:${SECRET}`).toString("base64url")],
    ...[0, 1, 2].flatMap((filler): (readonly [string, string])[] => [
      [`base64 of the secret at alignment ${String(filler)}`, framed(filler, SECRET, "base64")],
      [
        `base64 of the pair at alignment ${String(filler)}`,
        framed(filler, `${USER}:${SECRET}`, "base64"),
      ],
      [
        `base64url of the secret at alignment ${String(filler)}`,
        framed(filler, SECRET, "base64url"),
      ],
      [
        `base64url of the pair at alignment ${String(filler)}`,
        framed(filler, `${USER}:${SECRET}`, "base64url"),
      ],
    ]),
  ];

  it.each(cases)("reports %s", (_name, content) => {
    const result = footprintOf(plantedRoot({ "state/file.bin": content }));
    expect(result.leakedFileCount).toBe(1);
  });

  it("reports a planted spelling in a log line", () => {
    const scanner = createCredentialScanner({
      root: plantedRoot({}),
      spellings: credentialSpellings(SECRET, USER),
      minIntervalMs: 0,
    });
    scanner.scan();
    const result = scanner.result([{ op: "x", extra: { value: SECRET } }, { op: "y" }]);
    expect(result.leakedLogLineCount).toBe(1);
  });
});

describe("a clean tree is not reported (#4522)", () => {
  it("reports nothing for files without the credential and counts what it scanned", () => {
    const root = plantedRoot({
      "home/.m2/settings.xml": "<settings><offline>false</offline></settings>",
      "work/readme.txt": `no secret here, only ${USER}`,
    });
    const result = footprintOf(root);
    expect(result).toMatchObject({ leakedFileCount: 0, settingsFilesScanned: 1, scanCount: 1 });
  });

  it("does not enter a directory that holds the credential on purpose", () => {
    const root = plantedRoot({ "person-home/.m2/settings.xml": SECRET, "run/a.txt": "ok" });
    const result = footprintOf(root, new Set(["person-home"]));
    expect(result).toMatchObject({ leakedFileCount: 0, settingsFilesScanned: 0 });
  });

  it("scans at most once per interval", () => {
    const scanner = createCredentialScanner({
      root: plantedRoot({ "a.txt": "x" }),
      spellings: [SECRET],
      minIntervalMs: 60_000,
    });
    scanner.scan();
    scanner.scan();
    expect(scanner.result([]).scanCount).toBe(1);
  });
});
