// The shared model-policy document store (Issue #4137): documents live in a real, owned directory
// and are published atomically; a redirected directory or a non-file document is refused.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  locateOwnedDocument,
  publishOwnedJsonDocument,
  readOwnedJsonDocument,
} from "./documentStore.js";

class Unsafe extends Error {}
const unsafe = (): Error => new Unsafe("unsafe");

const roots: string[] = [];
function parent(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-role-policy-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owned policy document store", () => {
  it("publishes and reads back a document, leaving no temporary file", () => {
    const place = { parent: parent(), dirName: "policies", fileName: "one.json", unsafe };
    expect(locateOwnedDocument(place, { create: false })).toBeUndefined();
    const location = locateOwnedDocument(place, { create: true });
    if (location === undefined) throw new Error("expected a location");
    expect(readOwnedJsonDocument(location, unsafe)).toBeUndefined();
    publishOwnedJsonDocument(location, { revision: 1 }, unsafe, 0o600);
    publishOwnedJsonDocument(location, { revision: 2 }, unsafe);
    expect(readOwnedJsonDocument(location, unsafe)).toEqual({ revision: 2 });
    expect(readdirSync(location.dir)).toEqual(["one.json"]);
  });

  it("refuses a symbolic-link directory and a directory in the document's place", () => {
    const root = parent();
    const elsewhere = parent();
    symlinkSync(elsewhere, join(root, "policies"));
    const place = { parent: root, dirName: "policies", fileName: "one.json", unsafe };
    expect(() => locateOwnedDocument(place, { create: false })).toThrow(Unsafe);

    const other = parent();
    mkdirSync(join(other, "policies", "one.json"), { recursive: true });
    const location = locateOwnedDocument({ ...place, parent: other }, { create: false });
    if (location === undefined) throw new Error("expected a location");
    expect(() => readOwnedJsonDocument(location, unsafe)).toThrow(Unsafe);
  });

  it("lets a malformed document's parse error reach the caller", () => {
    const place = { parent: parent(), dirName: "policies", fileName: "one.json", unsafe };
    const location = locateOwnedDocument(place, { create: true });
    if (location === undefined) throw new Error("expected a location");
    writeFileSync(location.target, "{ not json");
    expect(() => readOwnedJsonDocument(location, unsafe)).toThrow(SyntaxError);
  });
});
