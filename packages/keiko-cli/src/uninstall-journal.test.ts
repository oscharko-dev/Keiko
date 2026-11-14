import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readUninstallJournal,
  uninstallJournalPath,
  writeUninstallJournal,
  type UninstallJournal,
} from "./uninstall-journal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const journal: UninstallJournal = {
  schemaVersion: 1,
  platformTarget: "windows-x64",
  setupManifestSha256: "a".repeat(64),
  installRootIdentitySha256: "b".repeat(64),
};

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keiko-journal-"));
  roots.push(root);
  return root;
}

it("round-trips and holds digests and a platform label, never a path", () => {
  const dir = stateDir();
  writeUninstallJournal(dir, journal);
  expect(readUninstallJournal(dir)).toEqual(journal);
  expect(Object.keys(journal).sort()).toEqual([
    "installRootIdentitySha256",
    "platformTarget",
    "schemaVersion",
    "setupManifestSha256",
  ]);
});

it.each([
  ["absent", undefined],
  ["not JSON", "{broken"],
  ["not an object", "[]"],
  ["a different schema", JSON.stringify({ ...journal, schemaVersion: 2 })],
  ["an unknown platform", JSON.stringify({ ...journal, platformTarget: "plan9" })],
  ["a digest of the wrong shape", JSON.stringify({ ...journal, setupManifestSha256: "xyz" })],
  ["oversized", `${JSON.stringify(journal)}${" ".repeat(5000)}`],
])("names no removal when the journal is %s", (_name, content) => {
  const dir = stateDir();
  if (content !== undefined) writeFileSync(uninstallJournalPath(dir), content);
  expect(readUninstallJournal(dir)).toBeUndefined();
});

it("does not read a directory or a link as a journal", () => {
  const dir = stateDir();
  mkdirSync(uninstallJournalPath(dir));
  expect(readUninstallJournal(dir)).toBeUndefined();
});
