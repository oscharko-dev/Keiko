import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The local Sonar runner must never produce a PASS it cannot stand behind (#4351). SonarJS resolves
// types through TypeScript, and a git worktree has an empty node_modules, so type-dependent rules
// (S2871, S4043, ...) stayed silent and a run passed on code the CI analysis reported. The runner now
// refuses to scan until the scanner can see installed dependencies and built workspace packages.
const runner = resolve(import.meta.dirname, "..", "..", "docker", "gates", "run-sonar.sh");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway checkout holding only what the runner reads before it would start a container. */
function checkout({ types, built }) {
  const root = mkdtempSync(join(tmpdir(), "keiko-sonar-types-"));
  roots.push(root);
  mkdirSync(join(root, "docker", "gates"), { recursive: true });
  copyFileSync(runner, join(root, "docker", "gates", "run-sonar.sh"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  if (types) {
    mkdirSync(join(root, "node_modules", "@types", "node"), { recursive: true });
    writeFileSync(join(root, "node_modules", "@types", "node", "package.json"), "{}");
  }
  if (built) {
    mkdirSync(join(root, "packages", "keiko-contracts", "dist"), { recursive: true });
    writeFileSync(join(root, "packages", "keiko-contracts", "dist", "index.d.ts"), "");
  }
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

/** A `docker` that answers every call with `status`, so no daemon or volume is ever touched. */
function fakeDocker(status) {
  const bin = mkdtempSync(join(tmpdir(), "keiko-sonar-bin-"));
  roots.push(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexit ${String(status)}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
}

function check(root, dockerStatus) {
  const bin = fakeDocker(dockerStatus);
  return spawnSync("bash", [join(root, "docker", "gates", "run-sonar.sh"), "--check-types"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      KEIKO_LOCAL_SONAR_NODE_MODULES_VOLUME: "",
    },
  });
}

describe("the local Sonar runner's type-resolution guard", () => {
  it("refuses to scan, exit 2, when no dependencies are visible and no volume can supply them", () => {
    const result = check(checkout({ types: false, built: true }), 1);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("local-sonar: FAIL - no installed dependencies");
    expect(result.stderr).toContain("S2871");
  });

  it("refuses to scan, exit 2, when the workspace packages are not built", () => {
    const result = check(checkout({ types: true, built: false }), 0);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("workspace packages are not built");
  });

  it("accepts a checkout that has installed dependencies and built packages", () => {
    const result = check(checkout({ types: true, built: true }), 1);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("types resolve");
  });

  it("mounts a populated gates volume when the checkout has no node_modules", () => {
    const result = check(checkout({ types: false, built: true }), 0);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("mounting volume");
  });
});
