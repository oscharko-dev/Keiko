import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  nativeBuildCacheReadRoots,
  nativeBuildWrapperReadRoots,
} from "./native-toolchain-roots.js";
import { nativeWorkspaceSeatbeltRules } from "./seatbelt-execution-root.js";

// #4522: a run builds against the person's repository through Keiko's credential relay, never with
// the person's own `~/.m2/settings.xml` or `~/.m2/settings-security.xml`. The kernel boundary is an
// allowlist, so the pin states what it must never contain: no path the run may WRITE is the person's
// Maven settings, their `~/.m2` or an ancestor of either, and no path it may READ is one of them,
// even with the person's read-only Maven cache and wrapper distributions admitted beside them.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-m2-pin-")));
  roots.push(root);
  return root;
}

/** The top-level parenthesised forms of a Seatbelt profile. */
function topLevelForms(rules: string): string[] {
  const forms: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  for (let index = 0; index < rules.length; index += 1) {
    const character = rules.charAt(index);
    if (character === '"' && rules.charAt(index - 1) !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) forms.push(rules.slice(start, index + 1));
    }
  }
  return forms;
}

function pathsOf(form: string): { readonly kind: string; readonly path: string }[] {
  return [...form.matchAll(/\((subpath|literal) ("(?:[^"\\]|\\.)*")\)/gu)].map((match) => ({
    kind: match[1] ?? "",
    path: JSON.parse(match[2] ?? '""') as string,
  }));
}

interface Admitted {
  readonly kind: string;
  readonly path: string;
}

function admitted(rules: string, verb: "file-read*" | "file-write*"): Admitted[] {
  return topLevelForms(rules)
    .filter((form) => form.startsWith("(allow ") && form.includes(` ${verb}`))
    .flatMap(pathsOf);
}

/** Whether an admitted `literal` is exactly the path, or an admitted `subpath` holds it. */
function admits(entry: Admitted, candidate: string): boolean {
  if (entry.kind === "literal") return entry.path === candidate;
  return candidate === entry.path || candidate.startsWith(`${entry.path}/`);
}

function admittedPaths(rules: string, verb: "file-read*" | "file-write*"): string[] {
  return admitted(rules, verb).map((entry) => entry.path);
}

/** Whether `candidate` is `root` or below it. */
function covers(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

interface Person {
  readonly home: string;
  readonly workspace: string;
  readonly state: string;
  readonly rules: string;
}

function personWithMavenCache(): Person {
  const base = temp();
  const home = join(base, "person");
  mkdirSync(join(home, ".m2", "repository"), { recursive: true });
  mkdirSync(join(home, ".m2", "wrapper", "dists"), { recursive: true });
  writeFileSync(join(home, ".m2", "settings.xml"), "<settings/>");
  writeFileSync(join(home, ".m2", "settings-security.xml"), "<settingsSecurity/>");
  const workspace = join(base, "workspace");
  const state = join(base, "state");
  mkdirSync(workspace);
  mkdirSync(state);
  const rules = nativeWorkspaceSeatbeltRules({
    workspaceRoot: workspace,
    workspaceAccess: "read-write",
    privateStateRoot: state,
    runtimeReadRoot: join(base, "runtime"),
    toolchainReadRoots: [...nativeBuildCacheReadRoots(home), ...nativeBuildWrapperReadRoots(home)],
  });
  return { home, workspace, state, rules };
}

describe("the person's Maven settings stay out of the native run's reach (#4522)", () => {
  it("admits the read-only cache and wrapper distributions, which are the only .m2 paths", () => {
    const { home, rules } = personWithMavenCache();
    const m2Reads = admittedPaths(rules, "file-read*").filter((path) =>
      covers(join(home, ".m2"), path),
    );
    expect(m2Reads.sort()).toEqual(
      [join(home, ".m2", "repository"), join(home, ".m2", "wrapper", "dists")].sort(),
    );
  });

  it("lets the run write only its workspace, its private state and the devices", () => {
    const { home, workspace, state, rules } = personWithMavenCache();
    const writable = admittedPaths(rules, "file-write*");
    expect(writable).toEqual(expect.arrayContaining([workspace, state]));
    for (const path of writable) {
      expect(
        [workspace, state].some((root) => covers(root, path)) || path.startsWith("/dev/"),
      ).toBe(true);
    }
    const writes = admitted(rules, "file-write*");
    for (const protectedPath of [
      join(home, ".m2", "settings.xml"),
      join(home, ".m2", "settings-security.xml"),
      join(home, ".m2"),
      home,
    ]) {
      expect(writes.some((entry) => admits(entry, protectedPath))).toBe(false);
    }
  });

  it("never admits either settings file, or the .m2 folder, for reading", () => {
    const { home, rules } = personWithMavenCache();
    const readable = admitted(rules, "file-read*");
    for (const protectedPath of [
      join(home, ".m2", "settings.xml"),
      join(home, ".m2", "settings-security.xml"),
      join(home, ".m2"),
    ]) {
      expect(readable.some((entry) => admits(entry, protectedPath))).toBe(false);
    }
  });

  it("pins the pin: a profile that did write-allow the person's .m2 would be caught", () => {
    const { home } = personWithMavenCache();
    const widened = `(allow file-write* (subpath ${JSON.stringify(join(home, ".m2"))}))`;
    const writes = admitted(widened, "file-write*");
    expect(writes.some((entry) => admits(entry, join(home, ".m2", "settings.xml")))).toBe(true);
  });
});
