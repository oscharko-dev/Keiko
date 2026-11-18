import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UiStore } from "../store/types.js";
import { isRegisteredLocalRoot } from "./canonical-root.js";

// A path whose stat fails with an error that says nothing about reachability (an offline network
// drive answers EIO or UNKNOWN on Windows), and paths whose directory ids a test chooses (a
// filesystem that reports zero ids, or two volumes that reuse a file index). Only `statSync` is
// wrapped; everything else is real.
const failingStat = vi.hoisted(() => ({
  path: undefined as string | undefined,
  code: "EIO",
  ids: new Map<string, { dev: bigint; ino: bigint }>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const statSync = ((path: NodeFs.PathLike, options?: NodeFs.StatOptions) => {
    if (failingStat.path !== undefined && String(path) === failingStat.path) {
      throw Object.assign(new Error("injected stat failure"), { code: failingStat.code });
    }
    const ids = failingStat.ids.get(String(path));
    if (ids !== undefined)
      return { ...ids, isDirectory: () => true } as unknown as NodeFs.BigIntStats;
    return actual.statSync(path, options);
  }) as typeof actual.statSync;
  return { ...actual, statSync };
});

let base: string;

function store(...paths: readonly string[]): Pick<UiStore, "listProjects"> {
  return {
    listProjects: () =>
      paths.map((path) => ({ path, name: "repo", favorite: false, createdAt: 0, lastOpenedAt: 0 })),
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "keiko canonical root-")));
  failingStat.path = undefined;
  failingStat.code = "EIO";
  failingStat.ids.clear();
});

afterEach(() => {
  failingStat.path = undefined;
  failingStat.ids.clear();
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

  it("matches only by spelling on a filesystem that reports a zero device or file id", () => {
    const root = join(base, "repo");
    const other = join(base, "other");
    for (const zero of [
      { dev: 0n, ino: 42n },
      { dev: 7n, ino: 0n },
    ]) {
      failingStat.ids.set(root, zero);
      failingStat.ids.set(other, zero);
      expect(isRegisteredLocalRoot(store(other), root)).toBe(false);
      expect(isRegisteredLocalRoot(store(root), root)).toBe(true);
    }
  });

  it("refuses the same file id on another device", () => {
    const root = join(base, "repo");
    const other = join(base, "other");
    failingStat.ids.set(root, { dev: 7n, ino: 42n });
    failingStat.ids.set(other, { dev: 8n, ino: 42n });
    expect(isRegisteredLocalRoot(store(other), root)).toBe(false);
    failingStat.ids.set(other, { dev: 7n, ino: 42n });
    expect(isRegisteredLocalRoot(store(other), root)).toBe(true);
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
