import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// ADR-0131 amendment (2026-11-21): the pre-push hook starts the local SonarQube from cold. A
// server that is still starting drops the status probe (curl exit 52), and under
// `set -euo pipefail` that failed probe ended the whole run before the wait loop could retry, so
// every cold-start scan failed while a warm server hid the defect.
const runner = resolve(import.meta.dirname, "..", "..", "docker", "gates", "run-sonar.sh");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A checkout holding what the runner reads before it starts the server. */
function checkout() {
  const root = scratch("keiko-sonar-cold-");
  mkdirSync(join(root, "docker", "gates"), { recursive: true });
  copyFileSync(runner, join(root, "docker", "gates", "run-sonar.sh"));
  mkdirSync(join(root, "node_modules", "@types", "node"), { recursive: true });
  writeFileSync(join(root, "node_modules", "@types", "node", "package.json"), "{}");
  mkdirSync(join(root, "packages", "keiko-contracts", "dist"), { recursive: true });
  writeFileSync(join(root, "packages", "keiko-contracts", "dist", "index.d.ts"), "");
  spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function executable(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

/**
 * `docker` and `sleep` succeed at once. `curl` drops the first status probe the way a starting
 * server does, answers UP afterwards, and fails every other request, which stops the run right
 * after the wait loop without touching a real server.
 */
function fakeTools() {
  const bin = scratch("keiko-sonar-cold-bin-");
  const state = join(bin, "probes");
  executable(bin, "docker", "exit 0");
  executable(bin, "sleep", "exit 0");
  executable(
    bin,
    "curl",
    [
      'case "$*" in',
      "  *api/system/status*)",
      `    count=$(cat "${state}" 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > "${state}"`,
      '    if [ "$count" -eq 1 ]; then exit 52; fi',
      '    echo \'{"status":"UP"}\'; exit 0 ;;',
      "  *) exit 22 ;;",
      "esac",
    ].join("\n"),
  );
  return bin;
}

describe("the local Sonar runner's cold start", () => {
  it("keeps waiting when the first status probe of a starting server fails", () => {
    const bin = fakeTools();
    const result = spawnSync("bash", [join(checkout(), "docker", "gates", "run-sonar.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        KEIKO_LOCAL_SONAR_NODE_MODULES_VOLUME: "",
      },
    });
    expect(result.stdout).toContain("waiting for the server. up");
    expect(result.stderr).not.toContain("did not become ready");
  });
});
