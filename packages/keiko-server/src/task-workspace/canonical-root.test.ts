import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isRegisteredLocalRoot } from "./canonical-root.js";

// A path whose stat fails with an error that says nothing about reachability (an offline network
// drive answers EIO or UNKNOWN on Windows). Only `statSync` is wrapped; everything else is real.
const failingStat = vi.hoisted(() => ({ path: undefined as string | undefined, code: "EIO" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const statSync = ((path: NodeFs.PathLike, options?: NodeFs.StatSyncOptions) => {
    if (failingStat.path !== undefined && String(path) === failingStat.path) {
      throw Object.assign(new Error("injected stat failure"), { code: failingStat.code });
    }
    return actual.statSync(path, options);
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

let base: string;

function store(...paths: readonly string[]): { listProjects: () => { path: string }[] } {
  return { listProjects: () => paths.map((path) => ({ path })) };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko canonical root-")));
  failingStat.path = undefined;
  failingStat.code = "EIO";
});

afterEach(() => {
  failingStat.path = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe("isRegisteredLocalRoot (#4404)", () => {
  it("matches the exact registered spelling", () => {
    const root = join(base, "repo");
    mkdirSync(root);
    expect(isRegisteredLocalRoot(store(root), root)).toBe(true);
  });

  it("matches a registration that names the same directory under another spelling", () => {
    const root = join(base, "repo");
    mkdirSync(root);
    const alias = join(base, "alias");
    symlinkSync(root, alias, "junction");
    expect(isRegisteredLocalRoot(store(alias), root)).toBe(true);
  });

  it("refuses a directory nobody registered", () => {
    const root = join(base, "repo");
    const other = join(base, "other");
    mkdirSync(root);
    mkdirSync(other);
    expect(isRegisteredLocalRoot(store(other), root)).toBe(false);
  });

  it("keeps a non-canonical spelling of the selected root unregistered", () => {
    const root = join(base, "repo");
    mkdirSync(root);
    const alias = join(base, "alias");
    symlinkSync(root, alias, "junction");
    expect(isRegisteredLocalRoot(store(alias), `${root}${sep}.`)).toBe(false);
    expect(isRegisteredLocalRoot(store(alias), "repo")).toBe(false);
  });

  it("refuses a selected root that does not exist or is not a directory", () => {
    const file = join(base, "file.txt");
    writeFileSync(file, "x");
    expect(isRegisteredLocalRoot(store(base), join(base, "missing"))).toBe(false);
    expect(isRegisteredLocalRoot(store(base), file)).toBe(false);
  });

  it("decides by the other registrations when one cannot be read", () => {
    const root = join(base, "repo");
    mkdirSync(root);
    const alias = join(base, "alias");
    symlinkSync(root, alias, "junction");
    const offline = join(base, "offline-share");
    failingStat.path = offline;
    expect(isRegisteredLocalRoot(store(join(base, "removed"), offline, alias), root)).toBe(true);
    expect(isRegisteredLocalRoot(store(join(base, "removed"), offline), root)).toBe(false);
  });

  it("propagates an unexpected failure of the selected root itself", () => {
    const root = join(base, "repo");
    mkdirSync(root);
    const alias = join(base, "alias");
    symlinkSync(root, alias, "junction");
    failingStat.path = root;
    expect(() => isRegisteredLocalRoot(store(alias), root)).toThrow("injected stat failure");
    failingStat.code = "ENOENT";
    expect(isRegisteredLocalRoot(store(alias), root)).toBe(false);
  });
});
